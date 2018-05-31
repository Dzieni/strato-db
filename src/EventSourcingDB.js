/* eslint-disable no-console */
// Event Sourcing DataBase
// * Events describe facts that happened in the outside world and have to be stored
// * Events have version v, strictly ordered
// * Each event is handled separately and serially.
// * Each table is maintained by a reducer
// * Reducers get the table at v-1 and the event, and describe the change for version v
// * Once all reducers ran, the changes are applied and the db is at version v
// * To make changes to a table, change the reducer and rebuild the DB, or migrate the table

import debug from 'debug'
import DB from './DB'
import ESModel from './ESModel'
import {createStore, combineReducers} from './async-redux'
import EventQueue from './EventQueue'
import EventEmitter from 'events'

const dbg = debug('stratokit/ESDB')

const metadata = {
	reducer: async (model, {v = 0}) => {
		if (!model) {
			return {}
		}
		const currVDoc = await model.get('version')
		const currV = currVDoc ? currVDoc.v : -1
		if (v > currV) {
			return {set: [{id: 'version', v}]}
		}
		return {
			error: {
				message: `Current version ${currV} is >= event version ${v}`,
			},
		}
	},
}

const registerHistoryMigration = (rwDb, queue) => {
	rwDb.registerMigrations('historyExport', {
		2018040800: {
			up: async db => {
				const oldTable = await db.all('PRAGMA table_info(history)')
				if (
					!(
						oldTable.length === 4 &&
						oldTable.some(c => c.name === 'json') &&
						oldTable.some(c => c.name === 'v') &&
						oldTable.some(c => c.name === 'type') &&
						oldTable.some(c => c.name === 'ts')
					)
				)
					return
				let allDone = Promise.resolve()
				await db.each('SELECT * from history', row => {
					allDone = allDone.then(() =>
						queue.set({...row, json: undefined, ...JSON.parse(row.json)})
					)
				})
				await allDone
				// not dropping table, you can do that yourself :)
				console.error(`!!! history table in ${rwDb.file} is no longer needed`)
			},
		},
	})
}

const screenLine = '\n!!! -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=\n'
const showHugeDbError = (err, where) => {
	if (process.env.NODE_ENV !== 'test') {
		console.error(
			`${screenLine}!!! SEVERE ERROR in ${where} !!!${screenLine}`,
			err,
			screenLine
		)
	}
}

class ESDB extends EventEmitter {
	// eslint-disable-next-line complexity
	constructor({queue, models, queueFile, ...dbOptions}) {
		super()
		if (dbOptions.db)
			throw new TypeError(
				'db is no longer an option, pass the db options instead, e.g. file, verbose, readOnly'
			)
		if (!models) throw new TypeError('models are required')
		if (models.metadata)
			throw new TypeError('metadata is a reserved model name')
		models = {...models, metadata}

		if (
			queue &&
			queue.db.file === dbOptions.file &&
			queue.db.file !== ':memory:'
		) {
			// We have to have the same connection or we can get deadlocks
			this.rwDb = queue.db
		} else {
			this.rwDb = new DB(dbOptions)
		}
		// The RO DB needs to be the same for :memory: or it won't see anything
		this.db =
			this.rwDb.file === ':memory:'
				? this.rwDb
				: new DB({
						...dbOptions,
						name: dbOptions.name && `RO-${dbOptions.name}`,
						readOnly: true,
						onWillOpen: async () => {
							// Make sure migrations happened before opening
							await this.queue.db.openDB()
							await this.rwDb.openDB()
						},
				  })
		if (queue) {
			this.queue = queue
		} else {
			const qDb =
				this.rwDb.file === queueFile && queueFile !== ':memory:'
					? this.rwDb
					: new DB({
							...dbOptions,
							name: `${dbOptions.name || ''}Queue`,
							file: queueFile || dbOptions.file,
					  })
			this.queue = new EventQueue({db: qDb})
		}
		// Move history data to queue DB - makes no sense for :memory:
		if (this.rwDb.file !== this.queue.file) {
			registerHistoryMigration(this.rwDb, this.queue)
		}

		this.store = {}
		this.rwStore = {}

		this.reducerNames = []
		this.deriverModels = []
		this.preprocModels = []
		this.readWriters = []
		const reducers = {}
		this.reducerModels = {}
		const migrationOptions = {queue: this.queue}

		const dispatch = this.dispatch.bind(this)
		for (const [name, modelDef] of Object.entries(models)) {
			const {
				reducer,
				preprocessor,
				deriver,
				Model = ESModel,
				RWModel = Model,
				...rest
			} = modelDef

			let hasOne = false

			const rwModel = this.rwDb.addModel(RWModel, {
				name,
				...rest,
				migrationOptions,
				dispatch,
			})
			rwModel.deriver = deriver || RWModel.deriver
			this.rwStore[name] = rwModel
			if (typeof rwModel.setWritable === 'function')
				this.readWriters.push(rwModel)
			if (rwModel.deriver) {
				this.deriverModels.push(rwModel)
				hasOne = true
			}

			let model
			if (this.db === this.rwDb) {
				model = rwModel
			} else {
				model = this.db.addModel(Model, {name, ...rest, dispatch})
			}
			model.preprocessor = preprocessor || Model.preprocessor
			model.reducer = reducer || Model.reducer
			this.store[name] = model
			if (model.preprocessor) {
				this.preprocModels.push(model)
				hasOne = true
			}
			if (model.reducer) {
				this.reducerNames.push(name)
				this.reducerModels[name] = model
				reducers[name] = model.reducer
				hasOne = true
			}

			if (!hasOne)
				throw new TypeError(
					`${this.name}: At least one reducer, deriver or preprocessor required`
				)
		}

		this.modelReducer = combineReducers(reducers, true)
		this.redux = createStore(
			this.reducer.bind(this),
			undefined,
			undefined,
			true
		)
		this.redux.subscribe(this.handleResult)
		this.checkForEvents()
	}

	close() {
		return Promise.all([
			this.rwDb && this.rwDb.close(),
			this.db !== this.rwDb && this.db.close(),
		])
	}

	async dispatch(type, data, ts) {
		const event = await this.queue.add(type, data, ts)
		return this.handledVersion(event.v)
	}

	async preprocessor(event) {
		for (const model of this.preprocModels) {
			const {name} = model
			const {store} = this
			const {v, type} = event
			let newEvent
			try {
				// eslint-disable-next-line no-await-in-loop
				newEvent = await model.preprocessor({
					event,
					model,
					store,
				})
			} catch (error) {
				newEvent = {error}
			}
			if (newEvent) {
				if (newEvent.error) {
					return {
						...event,
						v,
						type,
						error: {[name]: newEvent.error},
					}
				}
				if (newEvent.v !== v) {
					// Just in case event was mutated
					// Be sure to put the version back or we put the wrong v in history
					return {
						...event,
						v,
						type,
						error: {
							_preprocess: {
								message: `${name}: preprocessor must retain event version`,
							},
						},
					}
				}
				if (!newEvent.type) {
					return {
						...event,
						v,
						type,
						error: {
							_preprocess: {
								message: `${name}: preprocessor must return event type`,
							},
						},
					}
				}
				event = newEvent
			}
		}
		return event
	}

	async reducer(state, event) {
		event = await this.preprocessor(event)
		if (event.error) {
			// preprocess failed, we need to apply metadata and store
			const metadata = await this.store.metadata.reducer(
				this.store.metadata,
				event
			)
			return {...event, result: {metadata}}
		}
		const result = await this.modelReducer(this.reducerModels, event)
		const hasError = this.reducerNames.some(n => result[n].error)
		if (hasError) {
			const error = {}
			for (const name of this.reducerNames) {
				const r = result[name]
				if (r.error) {
					error[name] = r.error
				}
			}
			return {...event, result: {metadata: result.metadata}, error}
		}
		for (const name of this.reducerNames) {
			const r = result[name]
			if (r === false || r === this.store[name]) {
				// no change
				delete result[name]
			}
		}
		return {
			...event,
			result,
		}
	}

	getVersionP = null

	getVersion() {
		if (!this.getVersionP) {
			this.getVersionP = this.store.metadata.get('version').then(vObj => {
				this.getVersionP = null
				return vObj ? vObj.v : 0
			})
		}
		// eslint-disable-next-line promise/catch-or-return
		if (dbg.enabled) this.getVersionP.then(v => dbg('at version ', v))
		return this.getVersionP
	}

	async waitForQueue() {
		const v = await this.queue._getLatestVersion()
		return this.handledVersion(v)
	}

	_waitingFor = {}

	_maxWaitingFor = 0

	async handledVersion(v) {
		if (v === 0) return
		// We must get the version first because our history might contain future events
		if (v <= (await this.getVersion())) {
			const event = await this.queue.get(v)
			if (event.error) {
				return Promise.reject(event)
			}
			return event
		}
		if (!this._waitingFor[v]) {
			if (v > this._maxWaitingFor) this._maxWaitingFor = v
			const o = {}
			this._waitingFor[v] = o
			// eslint-disable-next-line promise/avoid-new
			o.promise = new Promise((resolve, reject) => {
				o.resolve = resolve
				o.reject = reject
			})
			this.startPolling(v)
		}
		return this._waitingFor[v].promise
	}

	triggerWaitingEvent(event) {
		const o = this._waitingFor[event.v]
		if (o) {
			delete this._waitingFor[event.v]
			if (event.error) {
				o.reject(event)
			} else {
				o.resolve(event)
			}
		}
		if (event.v >= this._maxWaitingFor) {
			// Normally this will be empty but we might encounter a race condition
			for (const [v, o] of Object.entries(this._waitingFor)) {
				// eslint-disable-next-line promise/catch-or-return
				this.queue.get(v).then(event => {
					if (event.error) {
						o.reject(event)
					} else {
						o.resolve(event)
					}
					return undefined
				}, o.reject)
				delete this._waitingFor[v]
			}
		}
	}

	// This is the loop that applies events from the queue. Use startPolling(false) to always poll
	// so that events from other processes are also handled
	// It would be nice to not have to poll, but sqlite triggers only work on the connection
	// that makes the change
	// This should never throw, handling errors can be done in apply
	_waitForEvent = async () => {
		/* eslint-disable no-await-in-loop */
		let lastV = 0
		// eslint-disable-next-line no-unmodified-loop-condition
		while (!this._minVersion || this._minVersion > lastV) {
			const event = await this.queue.getNext(
				await this.getVersion(),
				!(this._isPolling || this._minVersion)
			)
			if (!event) return lastV
			// Clear previous result/error, if any
			delete event.error
			delete event.result
			lastV = event.v
			if (!this._reduxInited) {
				await this.redux.didInitialize
				this._reduxInited = true
			}
			await this.rwDb.withTransaction(async () => {
				try {
					await this.redux.dispatch(event)
				} catch (err) {
					// Redux failed so we'll apply manually
					const metadata = await this.store.metadata.reducer(
						this.store.metadata,
						event
					)
					// Will never error
					await this.handleResult({
						...event,
						error: {
							...event.error,
							_redux: {message: err.message, stack: err.stack},
						},
						result: {metadata},
					})
				}
				// This promise should always be there because the listeners are called
				// synchronously after the dispatch
				// We have to wait until the write applied before the next dispatch
				// Will never error
				return this._applyingP
			})
			if (this._reallyStop) {
				this._reallyStop = false
				return
			}
		}
		return lastV
		/* eslint-enable no-await-in-loop */
	}

	checkForEvents() {
		this.startPolling(1)
	}

	_waitingP = null

	_minVersion = 0

	startPolling(wantVersion) {
		if (wantVersion) {
			if (wantVersion > this._minVersion) this._minVersion = wantVersion
		} else if (!this._isPolling) {
			this._isPolling = true
			if (module.hot) {
				module.hot.dispose(() => {
					this.stopPolling()
				})
			}
		}
		if (!this._waitingP) {
			this._waitingP = this._waitForEvent()
				.catch(err => {
					console.error(
						'!!! Error waiting for event! This should not happen! Please investigate!',
						err
					)
					// Crash program but leave some time to notify
					// eslint-disable-next-line unicorn/no-process-exit
					setTimeout(() => process.exit(100), 50)

					throw new Error(err)
				})
				.then(lastV => {
					this._waitingP = null
					// Subtle race condition: new wantVersion coming in between end of _wait and .then
					if (this._minVersion && lastV < this._minVersion)
						return this.startPolling(this._minVersion)
					this._minVersion = 0
					return undefined
				})
		}
		return this._waitingP
	}

	stopPolling() {
		this._isPolling = false
		// here we should cancel the getNext
		this._reallyStop = true
		return this._waitingP || Promise.resolve()
	}

	_applyingP = null

	handleResult = async event => {
		if (!event) event = this.redux.getState()
		if (!event.v) {
			return
		}
		this._applyingP = this.applyEvent(event).catch(err => {
			console.error('!!! Error while applying event; changes not applied', err)
		})
		await this._applyingP
		this._applyingP = null
		if (event.error) {
			// this throws if there is no listener
			if (this.listenerCount('error')) {
				try {
					this.emit('error', event)
				} catch (err) {
					console.error('!!! "error" event handler threw, ignoring', err)
				}
			}
		} else {
			try {
				this.emit('result', event)
			} catch (err) {
				console.error('!!! "result" event handler threw, ignoring', err)
			}
		}
		try {
			this.emit('handled', event)
		} catch (err) {
			console.error('!!! "handled" event handler threw, ignoring', err)
		}
		this.triggerWaitingEvent(event)
	}

	async applyEvent(event) {
		const {rwStore, rwDb, queue, readWriters} = this
		for (const model of readWriters) model.setWritable(true)
		try {
			// First write our result to the queue (strip metadata, it's only v)
			const {result} = event
			const {metadata} = result
			delete result.metadata

			if (Object.keys(result).length) {
				// Apply reducer results
				try {
					await rwDb.run('SAVEPOINT apply')
					await Promise.all(
						Object.entries(result).map(
							([name, r]) => r && rwStore[name].applyChanges(r)
						)
					)
					await rwDb.run('RELEASE SAVEPOINT apply')
				} catch (err) {
					showHugeDbError(err, 'apply')
					await rwDb.run('ROLLBACK TO SAVEPOINT apply')
					event.failedResult = event.result
					delete event.result
					event.error = {_apply: err.message || err}
				}
			} else {
				delete event.result
			}

			// Even if the apply failed we'll consider this event handled
			await rwStore.metadata.applyChanges(metadata)

			await queue.set(event)
			if (event.error) return

			// Apply derivers
			if (this.deriverModels.length) {
				try {
					await rwDb.run('SAVEPOINT derive')
					await Promise.all(
						this.deriverModels.map(model =>
							model.deriver({
								model,
								store: this.rwStore,
								event,
								result,
							})
						)
					)
					await rwDb.run('RELEASE SAVEPOINT derive')
				} catch (err) {
					showHugeDbError(err, 'derive')
					await rwDb.run('ROLLBACK TO SAVEPOINT derive')
					event.failedResult = event.result
					delete event.result
					event.error = {_derive: err.message || err}
					await queue.set(event)
				}
			}
		} catch (err) {
			// argh, now what? Probably retry applying, or crash the app…
			// This can happen when DB has issue
			showHugeDbError(err, 'handleResult')

			throw err
		}

		for (const model of readWriters) model.setWritable(false)
	}
}

export default ESDB
