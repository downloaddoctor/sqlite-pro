'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { DatabaseSync } = require('node:sqlite')
const { createStore } = require('../dist/index.cjs')

function setup() {
  const db = new DatabaseSync(':memory:')
  db.exec(
    'CREATE TABLE widgets (id TEXT PRIMARY KEY, kind TEXT, n INTEGER, ' +
      'created_at INTEGER, updated_at INTEGER NOT NULL)',
  )
  const store = createStore({
    table: 'widgets',
    conflict: ['id'],
    keyOf: (row) => row.id,
    flushMs: 10,
    label: 'widgets',
    stateColumn: null,
  })
  const widgets = store.bind(db)
  widgets.bulkAdd([
    { id: 'a', kind: 'alpha', n: 1 },
    { id: 'b', kind: 'alpha_2', n: 5 },
    { id: 'c', kind: 'beta%', n: 9 },
    { id: 'd', kind: 'gamma', n: 12 },
  ])
  return widgets
}

const ids = (rows) => rows.map((r) => r.id)

test('above, aboveOrEqual, below, belowOrEqual, between, notEqual, noneOf', () => {
  const w = setup()
  assert.deepEqual(ids(w.where('n').above(5).orderBy('id').toArray()), ['c', 'd'])
  assert.deepEqual(ids(w.where('n').aboveOrEqual(5).orderBy('id').toArray()), ['b', 'c', 'd'])
  assert.deepEqual(ids(w.where('n').below(5).toArray()), ['a'])
  assert.deepEqual(ids(w.where('n').belowOrEqual(5).orderBy('id').toArray()), ['a', 'b'])
  assert.deepEqual(ids(w.where('n').between(5, 9).orderBy('id').toArray()), ['b', 'c'])
  assert.deepEqual(ids(w.where('id').notEqual('a').orderBy('id').toArray()), ['b', 'c', 'd'])
  assert.deepEqual(ids(w.where('id').noneOf(['a', 'b']).orderBy('id').toArray()), ['c', 'd'])
})

test('startsWith escapes LIKE wildcards', () => {
  const w = setup()
  assert.deepEqual(ids(w.where('kind').startsWith('alpha').orderBy('id').toArray()), ['a', 'b'])
  assert.deepEqual(ids(w.where('kind').startsWith('alpha_').toArray()), ['b'])
  assert.deepEqual(ids(w.where('kind').startsWith('beta%').toArray()), ['c'])
  assert.deepEqual(ids(w.where('kind').startsWith('%').toArray()), [])
})

test('offset, each, primaryKeys and sortBy', () => {
  const w = setup()
  assert.deepEqual(ids(w.orderBy('id').offset(1).limit(2).toArray()), ['b', 'c'])
  assert.deepEqual(ids(w.orderBy('id').offset(3).toArray()), ['d'])
  const seen = []
  w.where('n')
    .above(1)
    .orderBy('id')
    .each((row) => seen.push(row.id))
  assert.deepEqual(seen, ['b', 'c', 'd'])
  assert.deepEqual(w.where('n').below(6).orderBy('id').primaryKeys(), [['a'], ['b']])
  assert.deepEqual(ids(w.where('n').above(0).sortBy('n')), ['a', 'b', 'c', 'd'])
})
