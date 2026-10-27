'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { DatabaseSync } = require('node:sqlite')
const { createStore } = require('../dist/index.cjs')

const SCHEMA = {
  columns: {
    id: 'text primary',
    kind: 'text',
    name: 'text <-old_name',
    updatedAt: 'integer required',
  },
}

function legacyDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(
    'CREATE TABLE things (id TEXT PRIMARY KEY, kind INTEGER, legacy TEXT, old_name TEXT, ' +
      'updated_at INTEGER NOT NULL)',
  )
  db.prepare(
    "INSERT INTO things (id, kind, legacy, old_name, updated_at) VALUES ('a', 5, 'x', 'first', 1)",
  ).run()
  db.exec('PRAGMA foreign_keys = OFF')
  return db
}

function makeStore(schema) {
  return createStore({
    table: 'things',
    conflict: ['id'],
    keyOf: (row) => row.id,
    flushMs: 10,
    label: 'things',
    stateColumn: null,
    schema,
  })
}

const columnsOf = (db) =>
  db
    .prepare('PRAGMA table_info(things)')
    .all()
    .map((c) => c.name)

test('diff lists a renamed column apart from missing and extra', () => {
  const plan = makeStore(SCHEMA).diff(legacyDb())
  assert.deepEqual(plan.missing, [])
  assert.deepEqual(plan.extra, ['legacy'])
  assert.deepEqual(plan.renamed, [{ from: 'old_name', to: 'name' }])
  assert.deepEqual(plan.retyped, [{ column: 'kind', from: 'INTEGER', to: 'TEXT' }])
})

test('migrate retypes, drops and renames while keeping the data', () => {
  const db = legacyDb()
  const store = makeStore(SCHEMA)
  const plan = store.migrate(db)
  assert.deepEqual(plan.extra, ['legacy'])
  assert.deepEqual(columnsOf(db), ['id', 'kind', 'name', 'updated_at'])
  const row = db.prepare('SELECT * FROM things').get()
  assert.equal(row.name, 'first')
  assert.equal(row.kind, '5')
  assert.deepEqual(store.diff(db), { missing: [], extra: [], retyped: [], renamed: [] })
})

test('autoMigrate rebuilds the table inside define', () => {
  const db = legacyDb()
  makeStore({ ...SCHEMA, autoMigrate: true }).define(db)
  assert.deepEqual(columnsOf(db), ['id', 'kind', 'name', 'updated_at'])
})

test('migrate refuses to run with foreign keys ON and leaves the table alone', () => {
  const db = legacyDb()
  db.exec('PRAGMA foreign_keys = ON')
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1)
  assert.throws(() => makeStore(SCHEMA).migrate(db), /foreign_keys/)
  assert.ok(columnsOf(db).includes('legacy'))
})
