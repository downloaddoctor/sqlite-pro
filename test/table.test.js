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
  return { db, widgets: store.bind(db), store }
}

test('add, get, put, update and delete by primary key', () => {
  const { widgets } = setup()
  widgets.add({ id: 'a', kind: 'x', displayName: 'one' })
  assert.equal(widgets.get('a').displayName, 'one')
  widgets.save(widgets.put({ id: 'a', displayName: 'two' }))
  assert.equal(widgets.get('a').displayName, 'two')
  widgets.save(widgets.put({ id: 'b', kind: 'y', displayName: 'new' }))
  assert.equal(widgets.get('b').kind, 'y')
  widgets.save(widgets.update('a', { kind: 'z' }))
  assert.equal(widgets.get('a').kind, 'z')
  assert.equal(widgets.update('missing', { kind: 'q' }), null)
  assert.equal(widgets.delete('a'), 1)
  assert.equal(widgets.get('a'), null)
  assert.equal(widgets.count(), 1)
})

test('where().equals/anyOf/isNull with orderBy, reverse, limit, first and count', () => {
  const { widgets } = setup()
  widgets.bulkAdd([
    { id: 'a', kind: 'x', displayName: 'n1' },
    { id: 'b', kind: 'y', displayName: null },
    { id: 'c', kind: 'x', displayName: 'n3' },
  ])
  assert.equal(widgets.where('kind').equals('x').count(), 2)
  assert.deepEqual(
    widgets
      .where('kind')
      .anyOf(['x', 'y'])
      .orderBy('id')
      .reverse()
      .limit(2)
      .toArray()
      .map((r) => r.id),
    ['c', 'b'],
  )
  assert.equal(widgets.where('displayName').isNull().first().id, 'b')
  assert.equal(widgets.where({ kind: 'x', displayName: 'n3' }).first().id, 'c')
  assert.deepEqual(
    widgets
      .orderBy('id')
      .toArray()
      .map((r) => r.id),
    ['a', 'b', 'c'],
  )
})

test('bulk writes run in one transaction and roll back together', () => {
  const { widgets } = setup()
  widgets.bulkAdd([{ id: 'a', kind: 'x' }])
  assert.throws(() => widgets.bulkAdd([{ id: 'b', kind: 'x' }, { kind: 'no-key' }]))
  assert.equal(widgets.get('b'), null)
  assert.equal(widgets.count(), 1)
})

test('modify, bulkPut, bulkDelete and clear', () => {
  const { widgets } = setup()
  widgets.bulkAdd([
    { id: 'a', kind: 'x', displayName: '1' },
    { id: 'b', kind: 'x', displayName: '2' },
  ])
  assert.equal(
    widgets
      .where('kind')
      .equals('x')
      .modify((row) => {
        row.displayName = 'm'
        widgets.save(row)
      }),
    2,
  )
  assert.equal(widgets.get('b').displayName, 'm')
  widgets.bulkPut([{ id: 'c', kind: 'z', displayName: '3' }])
  assert.equal(widgets.count(), 3)
  assert.equal(widgets.bulkDelete(['a', 'b']), 2)
  assert.equal(widgets.clear(), 1)
  assert.equal(widgets.count(), 0)
})
