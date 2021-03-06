/* eslint-disable no-await-in-loop */

import sysPath from 'path'
import tmp from 'tmp-promise'
import JsonModel from '../JsonModel'
import ESDB from '.'
import {withESDB, testModels} from '../lib/_test-helpers'

const events = [{v: 1, type: 'foo'}, {v: 2, type: 'bar', data: {gotBar: true}}]

test('create', () =>
	tmp.withDir(
		async ({path: dir}) => {
			const file = sysPath.join(dir, 'db')
			const queueFile = sysPath.join(dir, 'q')
			const eSDB = new ESDB({
				file,
				queueFile,
				name: 'E',
				models: testModels,
			})
			// eSDB.listen(changes => eSDB.reducers.count.get('count'))
			expect(eSDB.db).toBeTruthy()
			expect(eSDB.rwDb).toBeTruthy()
			expect(eSDB.queue).toBeTruthy()
			expect(eSDB.models).toBeUndefined()
			expect(eSDB.store.count).toBeTruthy()
			expect(eSDB.rwStore.count).toBeTruthy()
			// Make sure the read-only database can start (no timeout)
			// and that migrations work
			expect(await eSDB.store.count.all()).toEqual([
				{id: 'count', total: 0, byType: {}},
			])
		},
		{unsafeCleanup: true}
	))

test('create in single file', async () => {
	const eSDB = new ESDB({
		name: 'E',
		models: testModels,
	})
	// eSDB.listen(changes => eSDB.reducers.count.get('count'))
	expect(eSDB.db).toBeTruthy()
	expect(eSDB.rwDb).toBeTruthy()
	expect(eSDB.queue).toBeTruthy()
	expect(eSDB.models).toBeUndefined()
	expect(eSDB.store.count).toBeTruthy()
	expect(eSDB.rwStore.count).toBeTruthy()
	// Make sure the read-only database can start (no timeout)
	// and that migrations work
	expect(await eSDB.store.count.all()).toEqual([
		{id: 'count', total: 0, byType: {}},
	])
})

test('create with Model', () => {
	return withESDB(
		eSDB => {
			expect(eSDB.store.count.foo()).toBe(true)
		},
		{
			count: {
				Model: class Count extends JsonModel {
					constructor(options) {
						if (typeof options.dispatch !== 'function') {
							throw new TypeError('Dispatch expected')
						}
						super(options)
					}

					foo() {
						return true
					}
				},
				reducer: testModels.count.reducer,
			},
		}
	)
})

test('create without given queue', async () => {
	let eSDB
	expect(() => {
		eSDB = new ESDB({models: {}})
	}).not.toThrow()
	await expect(eSDB.dispatch('hi')).resolves.toHaveProperty('v', 1)
})

test('reducer', () => {
	return withESDB(async eSDB => {
		const result = await eSDB._reducer(events[0])
		expect(result).toEqual({
			v: 1,
			type: 'foo',
			result: {
				count: {set: [{id: 'count', total: 1, byType: {foo: 1}}]},
			},
		})
		const result2 = await eSDB._reducer(events[1])
		expect(result2).toEqual({
			v: 2,
			type: 'bar',
			data: {gotBar: true},
			result: {
				count: {set: [{id: 'count', total: 1, byType: {bar: 1}}]},
			},
		})
	})
})

test('applyEvent', () => {
	return withESDB(async eSDB => {
		await eSDB.db.withTransaction(() =>
			eSDB._applyEvent(
				{
					v: 50,
					type: 'foo',
					result: {
						count: {set: [{id: 'count', total: 1, byType: {foo: 1}}]},
					},
				},
				true
			)
		)
		expect(await eSDB.store.count.get('count')).toEqual({
			id: 'count',
			total: 1,
			byType: {foo: 1},
		})
		expect(await eSDB.getVersion()).toBe(50)
	})
})

test('waitForQueue', async () =>
	withESDB(async (eSDB, queue) => {
		await expect(eSDB.waitForQueue()).resolves.toBeFalsy()
		await queue.add('1')
		await queue.add('2')
		expect(await eSDB.getVersion()).toBe(0)
		const p = eSDB.waitForQueue()
		let lastP
		for (let i = 3; i <= 10; i++) lastP = queue.add(String(i))
		const num = Number((await p).type)
		// should be at least last awaited
		expect(num).toBeGreaterThanOrEqual(2)
		await lastP
		await expect(eSDB.waitForQueue()).resolves.toHaveProperty('type', '10')
		// This should return immediately, if not the test will time out
		await expect(eSDB.waitForQueue()).resolves.toHaveProperty('type', '10')
	}))

test('waitForQueue race', async () =>
	withESDB(async (eSDB, queue) => {
		queue.add('1')
		queue.add('2')
		eSDB.waitForQueue()
		queue.add('3')
		await eSDB.handledVersion(3)
		await eSDB.handledVersion(3)
		queue.add('4')
		queue.add('5')
		queue.add('6')
		eSDB.waitForQueue()
		await eSDB.handledVersion(3)
		await eSDB.handledVersion(3)
		queue.add('7')
		eSDB.waitForQueue()
		await eSDB.waitForQueue()
		queue.add('8')
		queue.add('9')
		await eSDB.handledVersion(9)
		await eSDB.handledVersion(9)
		queue.add('10')
		queue.add('11')
		queue.add('12')
		const p = eSDB.handledVersion(12)
		eSDB.startPolling(12)
		await p
	}))

test('incoming event', async () => {
	return withESDB(async eSDB => {
		const event = await eSDB.queue.add('foobar')
		await eSDB.handledVersion(event.v)
		expect(await eSDB.store.count.get('count')).toEqual({
			id: 'count',
			total: 1,
			byType: {foobar: 1},
		})
	})
})

test('queue in same db', async () =>
	tmp.withDir(
		async ({path: dir}) => {
			const file = sysPath.join(dir, 'db')
			const eSDB = new ESDB({
				file,
				name: 'E',
				models: testModels,
			})
			const {queue} = eSDB
			queue.add('boop')
			const {v} = await queue.add('moop')
			eSDB.checkForEvents()
			await eSDB.handledVersion(v)
			const history = await eSDB.queue.all()
			expect(history).toHaveLength(2)
			expect(history[0].type).toBe('boop')
			expect(history[0].result).toBeTruthy()
			expect(history[1].type).toBe('moop')
			expect(history[1].result).toBeTruthy()
			await eSDB.dispatch('YO')
		},
		{unsafeCleanup: true}
	))

test('dispatch', async () => {
	return withESDB(async eSDB => {
		const event1P = eSDB.dispatch('whattup', 'indeed', 42)
		const event2P = eSDB.dispatch('dude', {woah: true}, 55)
		expect(await event2P).toEqual({
			v: 2,
			type: 'dude',
			ts: 55,
			data: {woah: true},
			result: {
				count: {set: [{id: 'count', total: 2, byType: {whattup: 1, dude: 1}}]},
			},
		})
		expect(await event1P).toEqual({
			v: 1,
			type: 'whattup',
			ts: 42,
			data: 'indeed',
			result: {
				count: {set: [{id: 'count', total: 1, byType: {whattup: 1}}]},
			},
		})
	})
})

test('reducer migration', async () => {
	let step = 0
	return withESDB(
		async eSDB => {
			// Wait for migrations to run
			await eSDB.store.count.searchOne()
			expect(step).toBe(1)
			const e = await eSDB.queue.searchOne()
			expect(e.type).toBe('foo')
		},
		{
			count: {
				...testModels.count,
				migrations: {
					async foo({db, model, queue}) {
						expect(step).toBe(0)
						step = 1
						expect(db).toBeTruthy()
						expect(model).toBeTruthy()
						expect(queue).toBeTruthy()
						await queue.add('foo', 0)
					},
				},
			},
		}
	)
})

test('derivers', async () => {
	return withESDB(async eSDB => {
		await eSDB.dispatch('bar')
		expect(await eSDB.store.deriver.searchOne()).toEqual({
			desc: 'Total: 1, seen types: bar',
			id: 'descCount',
		})
	})
})

test('preprocessors', async () => {
	return withESDB(
		async eSDB => {
			await expect(
				eSDB._preprocessor({type: 'pre type'})
			).resolves.toHaveProperty(
				'error._preprocess_meep',
				expect.stringContaining('type')
			)
			await expect(
				eSDB._preprocessor({type: 'pre version'})
			).resolves.toHaveProperty(
				'error._preprocess_meep',
				expect.stringContaining('version')
			)
			await expect(
				eSDB._preprocessor({type: 'bad event'})
			).resolves.toHaveProperty(
				'error._preprocess_meep',
				expect.stringContaining('Yeah, no.')
			)
			await eSDB.dispatch('create_thing', {foo: 2})
			expect(await eSDB.store.meep.searchOne()).toEqual({
				id: '5',
				foo: 2,
			})
		},
		{
			meep: {
				preprocessor: async ({event, model, store, dispatch}) => {
					if (!model) throw new Error('expecting my model')
					if (!store) throw new Error('expecting the store')
					if (!dispatch) throw new Error('expecting dispatch for subevents')
					if (event.type === 'create_thing') {
						event.type = 'set_thing'
						event.data.id = 5
						return event
					}
					if (event.type === 'pre type') {
						delete event.type
						return event
					}
					if (event.type === 'pre version') {
						event.v = 123
						return event
					}
					if (event.type === 'bad event') {
						return {error: 'Yeah, no.'}
					}
				},
				reducer: (model, event) => {
					if (event.type === 'set_thing') {
						return {set: [event.data]}
					}
					return false
				},
			},
		}
	)
})

test('event error in preprocessor', () =>
	withESDB(async eSDB => {
		await expect(
			eSDB._handleEvent({type: 'error_pre'})
		).resolves.toHaveProperty(
			'error._preprocess_count',
			expect.stringContaining('pre error for you')
		)
		// All the below: don't call next phases
		// Error in apply => error: _apply
	}))

test('event error in reducer', () =>
	withESDB(async eSDB => {
		await expect(
			eSDB._handleEvent({type: 'error_reduce'})
		).resolves.toHaveProperty(
			'error.reduce_count',
			expect.stringContaining('error for you')
		)
	}))

test('event error in apply', () => {
	return withESDB(async eSDB => {
		await expect(
			eSDB._applyEvent({
				v: 1,
				type: 'foo',
				result: {
					// it will try to call map as a function
					count: {set: {map: 5}},
				},
			})
		).resolves.toHaveProperty(
			'error._apply-apply',
			expect.stringContaining('.map is not a function')
		)
	})
})

test('event error in deriver', () =>
	withESDB(async eSDB => {
		await expect(
			eSDB._handleEvent({v: 1, type: 'error_derive'})
		).resolves.toHaveProperty(
			'error._apply-derive',
			expect.stringContaining('error for you')
		)
	}))

test('event emitter', async () => {
	return withESDB(async eSDB => {
		let errored = 0,
			resulted = 0
		eSDB.on('result', event => {
			resulted++
			expect(event.error).toBeFalsy()
			expect(event.result).toBeTruthy()
		})
		eSDB.on('error', event => {
			errored++
			expect(event.error).toBeTruthy()
			expect(event.result).toBeUndefined()
		})
		await eSDB.dispatch('foo')
		await eSDB.dispatch('bar')
		eSDB.__BE_QUIET = true
		await expect(
			eSDB._dispatchWithError('error_reduce')
		).rejects.toHaveProperty('error')
		expect(errored).toBe(1)
		expect(resulted).toBe(2)
	})
})

test('event replay', async () =>
	withESDB(async (eSDB, queue) => {
		queue.set({
			v: 1,
			type: 'TEST',
			data: {hi: true},
			result: {},
			error: {test: true},
		})

		await expect(eSDB.handledVersion(1)).resolves.not.toHaveProperty('error')
	}))

test('RO db sees transaction as soon as completed', async () =>
	tmp.withDir(
		async ({path: dir}) => {
			const eSDB = new ESDB({
				file: sysPath.join(dir, 'db'),
				queueFile: sysPath.join(dir, 'q'),
				name: 'E',
				models: testModels,
			})
			for (let i = 1; i <= 100; i++) {
				await eSDB.dispatch('foo')
				expect(await eSDB.store.count.get('count')).toHaveProperty('total', i)
			}
		},
		{unsafeCleanup: true}
	))

test('preprocessor/reducer for ESModel', async () =>
	withESDB(
		async eSDB => {
			await eSDB.dispatch('set_thing', {foo: 2})
			expect(await eSDB.store.meep.searchOne()).toEqual({
				id: 1,
				foo: 2,
				ok: true,
			})
			await eSDB.rwStore.meep.set({id: 2})
			const event = await eSDB.queue.get(2)
			expect(event.data).toEqual([1, 2, {id: 2}])
			expect(event.result).toEqual({meep: {ins: [{id: 2}]}})
		},
		{
			meep: {
				columns: {id: {type: 'INTEGER'}},
				preprocessor: async ({event}) => {
					if (event.data && event.data.foo) event.data.ok = true
				},
				reducer: (model, event) => {
					if (event.type === 'set_thing') {
						return {set: [event.data]}
					}
					return false
				},
			},
		}
	))

test('model fail shows name', () => {
	expect(() => new ESDB({models: {foutje: false}})).toThrow('foutje')
})
