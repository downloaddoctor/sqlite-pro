'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { createStore, openDatabase } = require('../dist/index.cjs')

function make(table, schema) {
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

test('unsafe SQL identifiers are rejected', () => {
  assert.throws(() => make('things; DROP TABLE x', { columns: 'id' }), /invalid table/)
  const db = new DatabaseSync(':memory:')
  const store = make('things', { columns: { id: { type: 'text', primary: true, column: 'a b' } } })
  assert.throws(() => store.define(db), /invalid column/)
})

test('a row made only of key columns upserts without invalid SQL', () => {
  const db = new DatabaseSync(':memory:')
  const store = make('keys', { columns: { id: { type: 'text', primary: true } } })
  store.define(db)
  const things = store.bind(db)
  things.add({ id: 'a' })
  things.put({ id: 'a' })
  assert.equal(things.count(), 1)
})

test('a ladder step without an upgrade callback is refused before anything runs', () => {
  const db = new DatabaseSync(':memory:')
  const migrator = require('../dist/index.cjs').createMigrator({ baseline: 1 }).version(2, 'x')
  assert.throws(() => migrator.prepare(db), /no upgrade callback/)
})

test('a refused open closes the file handle', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-audit-'))
  const file = path.join(dir, 'x.db')
  try {
    const raw = new DatabaseSync(file)
    raw.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
    raw.exec("INSERT INTO meta VALUES ('schema_version', '99')")
    raw.close()
    assert.throws(() => openDatabase({ file, baseline: 1 }).open(), /newer than/)
    fs.rmSync(dir, { recursive: true, force: true })
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {
      // Windows can hold the file briefly; the temp dir is disposable.
    }
  }
})
