'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { DatabaseSync } = require('node:sqlite')
const { createStore, normalizeSchema } = require('../dist/index.cjs')

// Deterministic PRNG (mulberry32) so a failing run is reproducible.
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = (r, list) => list[Math.floor(r() * list.length)]

function setup() {
  const db = new DatabaseSync(':memory:')
  db.exec(
    'CREATE TABLE rows (id TEXT PRIMARY KEY, n INTEGER, kind TEXT, ' +
      'created_at INTEGER, updated_at INTEGER NOT NULL)',
  )
  const store = createStore({
    table: 'rows',
    conflict: ['id'],
    keyOf: (row) => row.id,
    flushMs: 10,
    label: 'rows',
    stateColumn: null,
  })
  const table = store.bind(db)
  const data = []
  for (let i = 0; i < 40; i++) {
    data.push({ id: 'r' + i, n: (i * 7) % 13, kind: 'k' + (i % 4) })
  }
  table.bulkAdd(data)
  return { table, data }
}

// Brute-force oracle for the filter operators the store exposes.
function expected(data, filter) {
  return data.filter((row) => {
    for (const [key, want] of Object.entries(filter)) {
      const have = row[key]
      if (want && typeof want === 'object' && !Array.isArray(want)) {
        for (const [op, operand] of Object.entries(want)) {
          if (op === 'above' && !(have > operand)) return false
          if (op === 'aboveOrEqual' && !(have >= operand)) return false
          if (op === 'below' && !(have < operand)) return false
          if (op === 'belowOrEqual' && !(have <= operand)) return false
          if (op === 'between' && !(have >= operand[0] && have <= operand[1])) return false
          if (op === 'notEqual' && !(have !== operand)) return false
          if (op === 'noneOf' && operand.includes(have)) return false
          if (op === 'startsWith' && !String(have).startsWith(String(operand))) return false
        }
      } else if (Array.isArray(want)) {
        if (!want.includes(have)) return false
      } else if (have !== want) {
        return false
      }
    }
    return true
  })
}

test('property: random filter objects match a brute-force oracle', () => {
  const { table, data } = setup()
  const random = rng(0xc0ffee)
  for (let round = 0; round < 120; round++) {
    const filter = {}
    const fields = Math.floor(random() * 3)
    for (let f = 0; f < fields; f++) {
      const field = pick(random, ['id', 'n', 'kind'])
      const shape = pick(random, ['eq', 'in', 'cmp', 'between', 'noneOf'])
      if (shape === 'eq') {
        filter[field] = field === 'n' ? Math.floor(random() * 13) : pick(random, ['r1', 'r2', 'k0'])
      } else if (shape === 'in') {
        filter[field] = [pick(random, ['r1', 'r2', 'r3']), pick(random, ['r4', 'k1'])]
      } else if (shape === 'cmp') {
        const op = pick(random, ['above', 'aboveOrEqual', 'below', 'belowOrEqual', 'notEqual'])
        filter[field] = {
          [op]: field === 'n' ? Math.floor(random() * 13) : pick(random, ['r5', 'k2']),
        }
      } else if (shape === 'between') {
        const lo = Math.floor(random() * 8)
        filter[field] = { between: [lo, lo + Math.floor(random() * 5)] }
      } else {
        filter[field] = { noneOf: [pick(random, ['r0', 'r1', 'k0'])] }
      }
    }
    const want = expected(data, filter)
      .map((row) => row.id)
      .sort()
    const got = table
      .where(filter)
      .toArray()
      .map((row) => row.id)
      .sort()
    assert.deepEqual(got, want, 'filter ' + JSON.stringify(filter))
  }
})

test('property: the object form keeps an explicit column name', () => {
  const custom = normalizeSchema('t', { columns: { someKey: { type: 'text', column: 'own_col' } } })
  assert.equal(custom.columns.someKey.column, 'own_col')
})

test('property: compact column strings round-trip through normalizeSchema', () => {
  const random = rng(0xbeef)
  const types = ['text', 'integer', 'real', 'boolean', 'json']
  for (let round = 0; round < 120; round++) {
    const key = 'f' + round
    const type = pick(random, types)
    const tokens = [type]
    if (random() < 0.4) tokens.push('required')
    if (random() < 0.2) tokens.push('primary')
    if (random() < 0.2) tokens.push('unique')
    if (random() < 0.3) tokens.push('=' + Math.floor(random() * 100))
    const schema = normalizeSchema('t', { columns: { [key]: tokens.join(' ') } })
    const def = schema.columns[key]
    assert.equal(def.type, type, tokens.join(' '))
    assert.equal(Boolean(def.required), tokens.includes('required'), tokens.join(' '))
    assert.equal(Boolean(def.primary), tokens.includes('primary'), tokens.join(' '))
    assert.equal(Boolean(def.unique), tokens.includes('unique'), tokens.join(' '))
    if (tokens.some((token) => token.startsWith('='))) {
      assert.equal(def.default, Number(tokens[tokens.length - 1].slice(1)), tokens.join(' '))
    }
  }
})

test('property: Dexie index lists always mark the first entry primary', () => {
  const random = rng(0x5eed)
  for (let round = 0; round < 80; round++) {
    const names = []
    for (let i = 0; i < 1 + Math.floor(random() * 4); i++) {
      names.push((i === 0 ? '' : random() < 0.3 ? '&' : '') + 'c' + i)
    }
    const schema = normalizeSchema('t', { columns: names.join(', ') })
    const keys = Object.keys(schema.columns)
    assert.equal(keys.length, names.length)
    assert.equal(schema.columns.c0.primary, true)
    for (const key of keys.slice(1)) assert.notEqual(schema.columns[key].primary, true)
  }
})
