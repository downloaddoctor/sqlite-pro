'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { DatabaseSync } = require('node:sqlite')
const { createStore } = require('../dist/index.cjs')

function makeDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(
    'CREATE TABLE widgets (id TEXT PRIMARY KEY, display_name TEXT, is_on INTEGER, ' +
      'meta_json TEXT, extra_col TEXT, state_json TEXT, updated_at INTEGER NOT NULL)',
  )
  return db
}

function makeStore(extra = {}) {
  return createStore({
    table: 'widgets',
    conflict: ['id'],
    keyOf: (row) => row.id,
    flushMs: 10,
    label: 'widgets',
    booleanKeys: new Set(['isOn']),
    defaults: { meta: () => ({}) },
    ...extra,
  })
}

test('columns are introspected: snake_case -> camelCase, *_json -> blob, SELECT built from the table', () => {
  const db = makeDb()
  const store = makeStore()
  const w = store.wrap(db, { id: 'a', displayName: 'n', isOn: true, meta: { k: 1 }, extraCol: 'x' })
  store.flushNow(db, w)
  const raw = db.prepare('SELECT * FROM widgets WHERE id = ?').get('a')
  assert.equal(raw.display_name, 'n')
  assert.equal(raw.is_on, 1)
  assert.equal(raw.meta_json, '{"k":1}')
  assert.equal(store.sql(db, 'WHERE id = ?').startsWith('SELECT id, display_name'), true)
  const back = store.bind(db).get('a')
  assert.equal(back.displayName, 'n')
  assert.equal(back.isOn, true)
  assert.deepEqual(back.meta, { k: 1 })
  assert.equal(back.extraCol, 'x')
})

test('unmapped keys round-trip through the state column and blob default applies', () => {
  const db = makeDb()
  const store = makeStore()
  const w = store.wrap(db, { id: 'b', displayName: 'n', isOn: false })
  w.custom = { a: 1 }
  store.flushNow(db, w)
  const back = store.bind(db).get('b')
  assert.deepEqual(back.custom, { a: 1 })
  assert.equal(back.isOn, false)
  assert.deepEqual(back.meta, {})
})
