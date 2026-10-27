'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createStore, openDatabase } = require('../dist/index.cjs')

function makeStore(events = []) {
  return createStore({
    table: 'things',
    conflict: ['id'],
    keyOf: (row) => row.id,
    flushMs: 10,
    label: 'things',
    stateColumn: null,
    schema: {
      columns: {
        id: 'text primary',
        kind: 'text required',
        meta: 'json',
        score: 'integer required =0',
        createdAt: 'integer',
        updatedAt: 'integer required',
      },
      unique: ['kind+id'],
      indexes: ['kind,-createdAt'],
    },
    hooks: {
      creating(doc) {
        doc.kind = doc.kind || 'default'
        events.push('creating:' + doc.id)
      },
      updating(dirty) {
        events.push('updating:' + [...dirty].join(','))
      },
      deleting(doc) {
        events.push('deleting:' + doc.id)
      },
      reading(obj) {
        events.push('reading:' + obj.id)
      },
    },
  })
}

function open(store) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zk-compact-'))
  const db = openDatabase({ file: path.join(dir, 'a.db'), stores: [store], baseline: 1 }).open()
  return {
    db,
    close() {
      if (db.isOpen) db.close()
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      } catch {
        // Windows may hold the WAL briefly; the temp dir is disposable.
      }
    },
  }
}

test('compact schema strings create the table, default, unique and index', () => {
  const t = open(makeStore())
  try {
    const names = t.db
      .prepare('PRAGMA table_info(things)')
      .all()
      .map((c) => c.name)
    assert.deepEqual(names, ['id', 'kind', 'meta_json', 'score', 'created_at', 'updated_at'])
    const things = t.db.table('things')
    things.add({ id: 'a' })
    assert.equal(things.get('a').score, 0)
    assert.equal(things.get('a').kind, 'default')
    const indexes = t.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_things_kind_createdAt'",
      )
      .all()
    assert.equal(indexes.length, 1)
  } finally {
    t.close()
  }
})

test('named compact index keeps its explicit name', () => {
  const store = createStore({
    table: 'named',
    conflict: ['id'],
    keyOf: (row) => row.id,
    flushMs: 10,
    label: 'named',
    stateColumn: null,
    schema: {
      columns: {
        id: 'text primary',
        kind: 'text',
        createdAt: 'integer',
        updatedAt: 'integer required',
      },
      indexes: ['idx_named_custom: kind,-createdAt'],
    },
  })
  const t = open(store)
  try {
    const found = t.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_named_custom'")
      .all()
    assert.equal(found.length, 1)
  } finally {
    t.close()
  }
})

test('hooks fire for creating, reading, updating (narrow path) and deleting', () => {
  const events = []
  const t = open(makeStore(events))
  try {
    const things = t.db.table('things')
    const row = things.add({ id: 'a' })
    row.kind = 'x'
    things.save(row)
    things.get('a')
    things.delete('a')
    assert.deepEqual(events, ['creating:a', 'updating:kind', 'reading:a', 'deleting:a'])
    assert.throws(() => makeStore().on('nope', () => {}), /unknown hook/)
  } finally {
    t.close()
  }
})

test('db.transaction commits, rolls back, and nests with SAVEPOINTs', () => {
  const t = open(makeStore())
  try {
    const things = t.db.table('things')
    assert.throws(
      () =>
        t.db.transaction(() => {
          things.add({ id: 't1', kind: 'k' })
          throw new Error('boom')
        }),
      /boom/,
    )
    assert.equal(things.count(), 0)
    t.db.transaction(() => {
      things.add({ id: 't2', kind: 'k' })
      t.db.transaction(() => things.add({ id: 't3', kind: 'k' }))
    })
    assert.equal(things.count(), 2)
    t.db.transaction(() => {
      things.add({ id: 't4', kind: 'k' })
      assert.throws(
        () =>
          t.db.transaction(() => {
            things.add({ id: 't5', kind: 'k' })
            throw new Error('inner')
          }),
        /inner/,
      )
    })
    assert.ok(things.get('t4'))
    assert.equal(things.get('t5'), null)
    assert.throws(() => t.db.table('nope'), /no store for table/)
  } finally {
    t.close()
  }
})
