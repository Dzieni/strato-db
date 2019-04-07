import {sql, valToSql} from '../DB'
import {uniqueSlugId} from '../slugify'
import {get} from 'lodash'

// eslint-disable-next-line complexity
export const normalizeColumn = (col, name) => {
	col.name = name
	col.quoted = sql.quoteId(name)
	if (col.type) col.real = true
	else if (col.real) col.type = col.falsyBool ? 'INTEGER' : 'BLOB'
	if (col.get == null) col.get = !!col.real
	if (!col.path && name !== 'json') col.path = name
	col.parts = col.path === '' ? [] : col.path.split('.')
	if (col.index === 'ALL') col.ignoreNull = false
	if (col.index === 'SPARSE') col.ignoreNull = true
	if (col.unique) {
		if (!col.index) throw new TypeError(`${name}: unique requires index`)
	} else if (col.ignoreNull == null) {
		col.ignoreNull = true
	}
	if (col.autoIncrement && col.type !== 'INTEGER')
		throw new TypeError(`${name}: autoIncrement is only for type INTEGER`)
	if (col.slugValue) {
		if (col.value)
			throw new TypeError(`${name}: slugValue and value can't both be defined`)
		if (!col.index) throw new TypeError(`${name}: slugValue requires index`)
		col.value = async function(o) {
			if (o[name] != null) return o[name]
			return uniqueSlugId(this, await col.slugValue(o), name, o[this.idCol])
		}
	}
	if (col.default != null) {
		col.ignoreNull = false
		const prev = col.value
		if (prev) {
			col.value = async function(o) {
				const r = await prev.call(this, o)
				return r == null ? col.default : r
			}
		} else if (col.sql) {
			col.sql = `ifNull(${col.sql},${valToSql(col.default)})`
		} else {
			col.value = o => {
				const v = get(o, col.path)
				return v == null ? col.default : v
			}
		}
	}
	if (col.required) {
		col.ignoreNull = false
		const prev = col.value
		if (prev) {
			col.value = async function(o) {
				const r = await prev.call(this, o)
				if (r == null) throw new Error(`${name}: value is required`)
				return r
			}
		} else {
			col.value = o => {
				const v = get(o, col.path)
				if (v == null) throw new Error(`${name}: value is required`)
				return v
			}
		}
	}
	if (col.falsyBool) {
		const parseFalsyBool = v => (v ? true : undefined)
		const {value, parse} = col
		if (value) {
			col.value = function(o) {
				const r = value.call(this, o)
				return r
					? typeof r.then === 'function'
						? r.then(parseFalsyBool)
						: true
					: undefined
			}
		} else {
			col.value = o => parseFalsyBool(get(o, col.path))
		}
		if (col.real) {
			col.parse = parse
				? v => parseFalsyBool(parse.call(this, v))
				: parseFalsyBool
		}
	}
	if (!col.real && col.stringify)
		throw new Error(`${name}: stringify only applies to real columns`)
	if (!col.get && col.parse)
		throw new Error(`${name}: parse only applies to get:true columns`)
}
