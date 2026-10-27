'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { DatabaseSync } = require('node:sqlite')
const { createStore } = require('../dist/index.cjs')

function memoryStore(schema) {
  const db = new DatabaseSync(':memory:')
  const store = createStore({
    table: 'things',
    conflict: ['id'],
    keyOf: (row) => row.id,
    flushMs: 10,
    label: 'things',
    stateColumn: null,
    schema,
  })
  store.define(db)
  return { db, store, things: store.bind(db) }
}

test('Dexie index-list schema string: primary, indexes, unique and types', () => {
  const { db, things } = memoryStore({ columns: 'id, kind, &slug, n:integer, updatedAt:integer' })
  const names = db
    .prepare('PRAGMA table_info(things)')
    .all()
    .map((c) => c.name)
  assert.deepEqual(names, ['id', 'kind', 'slug', 'n', 'updated_at'])
  const idx = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_things_kind'")
    .all()
  assert.equal(idx.length, 1)
  things.add({ id: 'a', kind: 'x', slug: 's', n: 1 })
  assert.throws(() => things.add({ id: 'b', kind: 'x', slug: 's', n: 2 }))
  assert.equal(things.get('a').n, 1)
})

test('table.hook and liveQuery react to create and delete', () => {
  const { things } = memoryStore({ columns: 'id, kind, updatedAt:integer' })
  const seen = []
  things.hook('creating', (doc) => seen.push('creating:' + doc.id))
  const counts = []
  const off = things.liveQuery((t) => t.count()).subscribe((n) => counts.push(n))
  things.add({ id: 'a', kind: 'x' })
  things.add({ id: 'b', kind: 'x' })
  things.delete('a')
  off()
  things.add({ id: 'c', kind: 'x' })
  assert.deepEqual(seen, ['creating:a', 'creating:b', 'creating:c'])
  assert.deepEqual(counts, [0, 1, 2, 1])
})

test('diff reports missing, extra and retyped columns without changing the table', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE things (id TEXT PRIMARY KEY, kind INTEGER, legacy TEXT)')
  const store = createStore({
    table: 'things',
    conflict: ['id'],
    keyOf: (row) => row.id,
    flushMs: 10,
    label: 'things',
    stateColumn: null,
    schema: { columns: 'id, kind, slug' },
  })
  const plan = store.diff(db)
  assert.deepEqual(plan.missing, ['slug'])
  assert.deepEqual(plan.extra, ['legacy'])
  assert.deepEqual(plan.retyped, [{ column: 'kind', from: 'INTEGER', to: 'TEXT' }])
  const names = db
    .prepare('PRAGMA table_info(things)')
    .all()
    .map((c) => c.name)
  assert.deepEqual(names, ['id', 'kind', 'legacy'])
})
