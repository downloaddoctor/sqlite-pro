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
    flushMs: 10,
    label: 'widgets',
    stateColumn: null,
  })
  return { db, store, widgets: store.bind(db) }
}

test('add, get, where and count', () => {
  const { widgets } = setup()
  widgets.add({ id: 'a', kind: 'x', displayName: 'one' })
  widgets.add({ id: 'b', kind: 'y', displayName: 'two' })
  assert.equal(widgets.get('a').displayName, 'one')
  assert.equal(widgets.where({ displayName: 'two' }).first().id, 'b')
  assert.equal(widgets.where({ id: 'zzz' }).first(), null)
  assert.equal(widgets.count(), 2)
  assert.equal(widgets.where({ kind: 'x' }).count(), 1)
  assert.ok(widgets.get('a').createdAt > 0)
})

test('where supports IN, IS NULL, sort, limit and rejects unknown fields', () => {
  const { widgets } = setup()
  widgets.add({ id: 'a', kind: 'x', displayName: 'n1' })
  widgets.add({ id: 'b', kind: 'y', displayName: null })
  widgets.add({ id: 'c', kind: 'z', displayName: 'n3' })
  assert.deepEqual(
    widgets
      .where('kind')
      .anyOf(['x', 'z'])
      .orderBy('id')
      .reverse()
      .toArray()
      .map((r) => r.id),
    ['c', 'a'],
  )
  assert.deepEqual(
    widgets
      .where('displayName')
      .isNull()
      .toArray()
      .map((r) => r.id),
    ['b'],
  )
  assert.equal(widgets.orderBy('id').limit(2).toArray().length, 2)
  assert.throws(() => widgets.where({ nope: 1 }).toArray(), /unknown field/)
})

test('update and put persist through the narrow UPDATE', () => {
  const { widgets } = setup()
  widgets.add({ id: 'a', kind: 'x', displayName: 'old' })
  const doc = widgets.update('a', { displayName: 'new' })
  widgets.save(doc)
  assert.equal(widgets.get('a').displayName, 'new')
  assert.equal(widgets.update('missing', { displayName: 'q' }), null)
  const made = widgets.put({ id: 'b', kind: 'k', displayName: 'made' })
  assert.equal(made.kind, 'k')
  const again = widgets.put({ id: 'b', displayName: 'changed' })
  widgets.save(again)
  assert.equal(widgets.get('b').displayName, 'changed')
  assert.equal(widgets.count(), 2)
})

test('delete removes rows and cancels pending writes', () => {
  const { store, widgets } = setup()
  widgets.add({ id: 'a', kind: 'x', displayName: '1' })
  widgets.add({ id: 'b', kind: 'x', displayName: '2' })
  widgets.add({ id: 'c', kind: 'y', displayName: '3' })
  const live = widgets.get('a')
  live.displayName = 'dirty'
  assert.equal(store.pendingCount(), 1)
  assert.equal(widgets.delete('a'), 1)
  assert.equal(store.pendingCount(), 0)
  assert.equal(widgets.delete('a'), 0)
  assert.equal(widgets.where({ kind: 'x' }).delete(), 1)
  assert.equal(widgets.count(), 1)
})

test('a deleted row stays gone even if a stale proxy is written again', () => {
  const { store, widgets } = setup()
  widgets.add({ id: 'a', kind: 'x', displayName: '1' })
  const live = widgets.get('a')
  widgets.delete('a')
  live.displayName = 'ghost'
  store.flushAll()
  assert.equal(widgets.count(), 0)
})

test('creating a row again revives its key', () => {
  const { widgets } = setup()
  widgets.add({ id: 'a', kind: 'x', displayName: 'first' })
  widgets.delete('a')
  widgets.add({ id: 'a', kind: 'y', displayName: 'second' })
  const again = widgets.get('a')
  again.displayName = 'third'
  widgets.save(again)
  assert.equal(widgets.get('a').displayName, 'third')
})

test('flushAll falls back to per-row writes when BEGIN fails', () => {
  const { db, store, widgets } = setup()
  widgets.add({ id: 'a', kind: 'x', displayName: '1' })
  const live = widgets.get('a')
  live.displayName = '2'
  assert.equal(store.pendingCount(), 1)
  const origExec = db.exec.bind(db)
  let blocked = true
  db.exec = (sql) => {
    if (blocked && String(sql).includes('BEGIN IMMEDIATE')) {
      blocked = false
      throw new Error('database is locked')
    }
    return origExec(sql)
  }
  store.flushAll()
  assert.equal(widgets.get('a').displayName, '2')
})

test('delete cancels a pending write for a row that never flushed', () => {
  const { db, store, widgets } = setup()
  const ghost = store.wrap(db, { id: 'g', kind: 'x', displayName: 'ghost' })
  ghost.displayName = 'dirty'
  assert.equal(store.pendingCount(), 1)
  assert.equal(widgets.delete('g'), 0)
  assert.equal(store.pendingCount(), 0)
  store.flushAll()
  assert.equal(widgets.count(), 0)
})

test('deleteMany cancels pending writes for rows that never flushed', () => {
  const { db, store, widgets } = setup()
  widgets.add({ id: 'a', kind: 'x', displayName: '1' })
  const ghost = store.wrap(db, { id: 'b', kind: 'x', displayName: 'ghost' })
  ghost.displayName = 'dirty'
  assert.equal(store.pendingCount(), 1)
  assert.equal(widgets.where({ kind: 'x' }).delete(), 1)
  assert.equal(store.pendingCount(), 0)
  store.flushAll()
  assert.equal(widgets.count(), 0)
})

test('wrapResults false returns plain rows but updates still persist', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(
    'CREATE TABLE widgets (id TEXT PRIMARY KEY, kind TEXT, display_name TEXT, ' +
      'created_at INTEGER, updated_at INTEGER NOT NULL)',
  )
  const store = createStore({
    table: 'widgets',
    conflict: ['id'],
    keyOf: (row) => row.id,
    flushMs: 10,
    label: 'widgets',
    stateColumn: null,
    wrapResults: false,
  })
  const widgets = store.bind(db)
  widgets.add({ id: 'a', kind: 'x', displayName: 'one' })
  const item = widgets.get('a')
  assert.equal(Object.getPrototypeOf(item), Object.prototype)
  item.displayName = 'two'
  assert.equal(store.pendingCount(), 0)
  widgets.update('a', { displayName: 'three' })
  widgets.flush()
  const again = widgets.get('a')
  assert.equal(again.displayName, 'three')
  assert.equal(Object.getPrototypeOf(again), Object.prototype)
})
