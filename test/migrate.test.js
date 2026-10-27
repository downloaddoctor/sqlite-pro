'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')
const { createMigrator } = require('../dist/index.cjs')

test('prepare on a fresh database defines tables, runs the ladder and stores the version', () => {
  const db = new DatabaseSync(':memory:')
  const seen = []
  const migrator = createMigrator({
    baseline: 1,
    steps: [{ v: 2, name: 'two', up: () => seen.push('two') }],
    define: (handle) => handle.exec('CREATE TABLE IF NOT EXISTS probe (x INTEGER)'),
  })
  migrator.prepare(db)
  migrator.prepare(db)
  assert.deepEqual(seen, ['two'])
  assert.equal(migrator.getVersion(db), 2)
  assert.equal(migrator.SCHEMA_VERSION, 2)
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'probe'").get().n,
    1,
  )
})

test('a database newer than the code is refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zk-newer-'))
  const file = path.join(dir, 'x.db')
  try {
    const raw = new DatabaseSync(file)
    raw.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
    raw.exec("INSERT INTO meta VALUES ('schema_version', '99')")
    const migrator = createMigrator({ baseline: 1 })
    assert.throws(() => migrator.prepare(raw), /newer than the supported version 1/)
    raw.close()
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {
      // Windows can hold the db file briefly; the temp dir is disposable.
    }
  }
})

test('legacy upgrades run before define and log their message', () => {
  const db = new DatabaseSync(':memory:')
  const order = []
  const warned = []
  const migrator = createMigrator({
    baseline: 1,
    logger: { warn: (message) => warned.push(message) },
    legacy: [
      {
        name: 'old',
        message: 'upgraded',
        up: () => {
          order.push('legacy')
          return true
        },
      },
    ],
    define: () => order.push('define'),
  })
  migrator.prepare(db)
  assert.deepEqual(order, ['legacy', 'define'])
  assert.deepEqual(warned, ['upgraded'])
})

test('chain style: version(n).upgrade(cb) appends ladder steps', () => {
  const db = new DatabaseSync(':memory:')
  const seen = []
  const migrator = createMigrator({ baseline: 1 })
    .version(2, 'two')
    .upgrade(() => seen.push('two'))
    .version(3, 'three')
    .upgrade(() => seen.push('three'))
  migrator.prepare(db)
  migrator.prepare(db)
  assert.deepEqual(seen, ['two', 'three'])
  assert.equal(migrator.getVersion(db), 3)
  assert.equal(migrator.SCHEMA_VERSION, 3)
  assert.equal(migrator.steps.length, 2)
})

test('chain style: .legacy(entry) registers a pre-baseline upgrade', () => {
  const db = new DatabaseSync(':memory:')
  const warned = []
  const migrator = createMigrator({
    baseline: 2,
    logger: { warn: (message) => warned.push(message) },
  }).legacy({ name: 'old', message: 'upgraded', up: () => true })
  migrator.prepare(db)
  assert.deepEqual(warned, ['upgraded'])
})

test('chain style: a duplicate version is rejected', () => {
  const migrator = createMigrator({ baseline: 1 })
    .version(2)
    .upgrade(() => {})
  assert.throws(() => migrator.version(2), /Duplicate migration version: 2/)
})

test('chain style: upgrade before version is rejected', () => {
  const migrator = createMigrator({ baseline: 1 })
  assert.throws(() => migrator.upgrade(() => {}), /must follow version/)
})

test('openDatabase: one call opens the file, defines the stores and runs the ladder', () => {
  const { openDatabase } = require('../dist/index.cjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zk-open-'))
  const file = path.join(dir, 'x.db')
  const seen = []
  const store = {
    define: (handle) => handle.exec('CREATE TABLE IF NOT EXISTS probe (x INTEGER)'),
  }
  const handle = openDatabase({ file, stores: [store], baseline: 1 })
    .version(2, 'two')
    .upgrade(() => seen.push('two'))
    .open()
  try {
    assert.deepEqual(seen, ['two'])
    assert.equal(
      handle.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'probe'").get().n,
      1,
    )
    assert.equal(
      handle.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value,
      '2',
    )
    handle.close()
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {
      // Windows can hold the db file briefly; the temp dir is disposable.
    }
  }
})

test('beforeDefine: the flagged step runs ahead of define with the old shape intact', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE users (id TEXT PRIMARY KEY, parsed_fetch TEXT)')
  db.exec("INSERT INTO users VALUES ('u1', '{}')")
  const order = []
  const migrator = createMigrator({
    baseline: 1,
    define: (handle) => {
      order.push('define')
      handle.exec('CREATE TABLE IF NOT EXISTS users_v4 (id TEXT PRIMARY KEY) ')
    },
  })
    .version(2, 'reshape')
    .beforeDefine()
    .upgrade((handle) => {
      const cols = handle.prepare("SELECT name FROM pragma_table_info('users')").all()
      order.push('early:' + cols.map((c) => c.name).join(','))
    })
  migrator.prepare(db)
  assert.deepEqual(order, ['early:id,parsed_fetch', 'define'])
  assert.equal(migrator.getVersion(db), 2)
})

test('beforeDefine must follow version', () => {
  const migrator = createMigrator({ baseline: 1 })
  assert.throws(() => migrator.beforeDefine(), /must follow version/)
})

test('upgrade gets (db, ctx) and db.<table> resolves the store', () => {
  const { openDatabase } = require('../dist/index.cjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zk-tables-'))
  const file = path.join(dir, 'x.db')
  const probe = {
    table: 'probe',
    schema: { columns: { id: { type: 'text', primary: true }, name: { type: 'text' } } },
    define(db) {
      db.exec('CREATE TABLE IF NOT EXISTS probe (id TEXT PRIMARY KEY, name TEXT)')
    },
  }
  let seen = null
  const db = openDatabase({ file, stores: [probe], baseline: 1 })
    .version(2, 'touch')
    .upgrade((handle, ctx) => {
      seen = { sameStore: handle.probe === probe, hasCtx: typeof ctx.table === 'function' }
      ctx.table('probe').insert({ id: 'p1', name: 'first' })
    })
    .open()
  try {
    assert.deepEqual(seen, { sameStore: true, hasCtx: true })
    assert.equal(db.probe.table, 'probe')
    assert.deepEqual(
      db
        .prepare('SELECT id, name FROM probe')
        .all()
        .map((row) => ({ ...row })),
      [{ id: 'p1', name: 'first' }],
    )
    db.close()
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {
      // Windows can hold the db file briefly; the temp dir is disposable.
    }
  }
})

test('a failing ladder step rolls back and leaves the file at the old version', () => {
  const { openDatabase } = require('../dist/index.cjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zk-rb-'))
  const file = path.join(dir, 'x.db')
  const store = {
    table: 'probe',
    schema: { columns: { id: { type: 'text', primary: true } } },
    define(db) {
      db.exec('CREATE TABLE IF NOT EXISTS probe (id TEXT PRIMARY KEY)')
    },
  }
  try {
    openDatabase({ file, stores: [store], baseline: 1 })
      .open()
      .close()
    assert.throws(
      () =>
        openDatabase({ file, stores: [store], baseline: 1 })
          .version(2, 'boom')
          .upgrade((db) => {
            db.exec("INSERT INTO probe VALUES ('x')")
            throw new Error('boom')
          })
          .open(),
      /Migration to schema_version 2 failed: boom \(database left at version 1\)/,
    )
    const handle = openDatabase({ file, stores: [store], baseline: 1 }).open()
    try {
      assert.equal(handle.prepare('SELECT COUNT(*) AS n FROM probe').get().n, 0)
      assert.equal(
        handle.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value,
        '1',
      )
      assert.equal(handle.probe, store, 'db.probe is the store')
    } finally {
      handle.close()
    }
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {
      // Windows can hold the db file briefly; the temp dir is disposable.
    }
  }
})
