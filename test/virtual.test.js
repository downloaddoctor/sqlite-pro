'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { DatabaseSync } = require('node:sqlite')
const { createStore } = require('../dist/index.cjs')

function setup() {
  const db = new DatabaseSync(':memory:')
  const store = createStore({
    table: 'widgets',
    conflict: ['id'],
    keyOf: (row) => row.id,
    flushMs: 10,
    label: 'widgets',
    stateColumn: null,
    schema: {
      columns: {
        id: 'text primary',
        captureUrl: 'text',
        captureExtra: 'json',
        updatedAt: 'integer required',
      },
      children: [
        {
          table: 'widget_headers',
          schema: {
            columns: {
              widgetId: 'text required ->widgets.id:cascade',
              name: 'text required',
              value: 'text',
              pos: 'integer',
            },
            primaryKey: 'widgetId+name',
            withoutRowid: true,
          },
        },
      ],
      virtual: {
        capture: {
          fields: { url: 'captureUrl' },
          extra: 'captureExtra',
          children: {
            headers: {
              table: 'widget_headers',
              parent: 'widgetId',
              key: 'name',
              value: 'value',
              order: 'pos',
            },
          },
        },
      },
    },
  })
  store.define(db)
  return { db, store, widgets: store.bind(db) }
}

const headerCount = (db) => db.prepare('SELECT COUNT(*) AS n FROM widget_headers').get().n

test('virtual field projects onto columns, extra json and child rows, and hydrates back', () => {
  const { db, widgets } = setup()
  widgets.add({ id: 'w1', capture: { url: 'http://x', headers: { a: '1', b: '2' }, note: 'n' } })
  assert.equal(db.prepare('SELECT capture_url FROM widgets').get().capture_url, 'http://x')
  assert.equal(headerCount(db), 2)
  assert.deepEqual(widgets.get('w1').capture, {
    url: 'http://x',
    headers: { a: '1', b: '2' },
    note: 'n',
  })
})

test('changing a nested virtual value syncs the child table', () => {
  const { db, widgets } = setup()
  widgets.add({ id: 'w1', capture: { url: 'u', headers: { a: '1', b: '2' } } })
  const row = widgets.get('w1')
  row.capture.headers = { a: '9' }
  widgets.save(row)
  assert.equal(headerCount(db), 1)
  assert.deepEqual(widgets.get('w1').capture.headers, { a: '9' })
})

test('deleting the parent cascades to virtual child rows', () => {
  const { db, widgets } = setup()
  widgets.add({ id: 'w1', capture: { headers: { a: '1' } } })
  assert.equal(headerCount(db), 1)
  assert.equal(widgets.delete('w1'), 1)
  assert.equal(headerCount(db), 0)
})
