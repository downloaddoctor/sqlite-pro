'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { DatabaseSync } = require('node:sqlite')
const { createStore } = require('../dist/index.cjs')

const THINGS = {
  columns: {
    id: { type: 'text', primary: true },
    kind: { type: 'text', required: true },
    meta: { type: 'json' },
    createdAt: { type: 'integer' },
    updatedAt: { type: 'integer', required: true },
  },
  indexes: [{ name: 'idx_things_kind', columns: ['kind', '-createdAt'] }],
}

function makeStore(table, schema) {
  return createStore({
    table,
    schema,
    conflict: ['id'],
    keyOf: (row) => row.id,
    flushMs: 10,
    label: table,
    stateColumn: null,
  })
}

test('define creates the table from the schema, is idempotent, and json is validated', () => {
  const db = new DatabaseSync(':memory:')
  const store = makeStore('things', THINGS)
  store.define(db)
  store.define(db)
  const names = db
    .prepare('PRAGMA table_info(things)')
    .all()
    .map((c) => c.name)
  assert.deepEqual(names, ['id', 'kind', 'meta_json', 'created_at', 'updated_at'])
  store.bind(db).add({ id: 'a', kind: 'k', meta: { x: 1 } })
  assert.deepEqual(store.bind(db).get('a').meta, { x: 1 })
  assert.throws(() =>
    db
      .prepare("INSERT INTO things (id, kind, meta_json, updated_at) VALUES ('b', 'k', '{bad', 1)")
      .run(),
  )
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'idx_things_kind'").get().n,
    1,
  )
})

test('define adds a declared column that an older table lacks', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(
    'CREATE TABLE things (id TEXT PRIMARY KEY, kind TEXT NOT NULL, updated_at INTEGER NOT NULL)',
  )
  const store = makeStore('things', THINGS)
  store.define(db)
  const names = db
    .prepare('PRAGMA table_info(things)')
    .all()
    .map((c) => c.name)
  assert.ok(names.includes('meta_json'))
  assert.ok(names.includes('created_at'))
})

test('child tables are created with the parent and cascade on delete', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  const store = makeStore('widgets', {
    columns: {
      id: { type: 'text', primary: true },
      updatedAt: { type: 'integer', required: true },
    },
    children: [
      {
        table: 'parts',
        schema: {
          columns: {
            widgetId: {
              type: 'text',
              required: true,
              references: { table: 'widgets', column: 'id', onDelete: 'cascade' },
            },
            name: { type: 'text', required: true },
          },
          primaryKey: ['widgetId', 'name'],
          withoutRowid: true,
        },
      },
    ],
  })
  store.define(db)
  store.bind(db).add({ id: 'w' })
  db.prepare("INSERT INTO parts (widget_id, name) VALUES ('w', 'p')").run()
  assert.equal(store.bind(db).delete('w'), 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM parts').get().n, 0)
})
