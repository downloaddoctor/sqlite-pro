'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { DatabaseSync } = require('node:sqlite')
const { createStore } = require('../dist/index.cjs')

function setup() {
  const db = new DatabaseSync(':memory:')
  db.exec(
    'CREATE TABLE widgets (id TEXT PRIMARY KEY, kind TEXT, display_name TEXT, ' +
      'created_at INTEGER, updated_at INTEGER NOT NULL)',
  )
  const store = createStore({
    table: 'widgets',
    conflict: ['id'],
    keyOf: (row) => row.id,
    flushMs: 60000,
    label: 'widgets',
    stateColumn: null,
  })
  return { db, store, widgets: store.bind(db) }
}

test('a read inside the debounce window sees the unflushed write', () => {
  const { store, widgets } = setup()
  widgets.add({ id: 'a', kind: 'x', displayName: 'one' })
  widgets.get('a').displayName = 'two'
  assert.equal(widgets.get('a').displayName, 'two')
  assert.equal(widgets.where({ kind: 'x' }).first().displayName, 'two')
  store.flushAll()
})

test('two read-modify-writes in the debounce window both persist', () => {
  const { db, store, widgets } = setup()
  widgets.add({ id: 'a', kind: 'x', displayName: 'one' })
  widgets.get('a').displayName = 'two'
  widgets.get('a').kind = 'y'
  store.flushAll()
  const row = db.prepare('SELECT kind, display_name FROM widgets').get()
  assert.equal(row.kind, 'y')
  assert.equal(row.display_name, 'two')
})
