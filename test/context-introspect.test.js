'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { DatabaseSync } = require('node:sqlite')
const { createMigrator } = require('../dist/index.cjs')

test('ctx.hasTable and ctx.hasColumn introspect the live schema inside a step', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE users (id TEXT PRIMARY KEY, parsed_fetch TEXT)')
  const seen = {}
  const migrator = createMigrator({ baseline: 1 })
    .version(2, 'probe')
    .beforeDefine()
    .upgrade((_handle, ctx) => {
      seen.users = ctx.hasTable('users')
      seen.missing = ctx.hasTable('nope')
      seen.legacyCol = ctx.hasColumn('users', 'parsed_fetch')
      seen.newCol = ctx.hasColumn('users', 'capture_url')
      seen.missingTable = ctx.hasColumn('nope', 'id')
    })
  migrator.prepare(db)
  assert.deepEqual(seen, {
    users: true,
    missing: false,
    legacyCol: true,
    newCol: false,
    missingTable: false,
  })
})

test('ctx.hasTable and ctx.hasColumn reject invalid identifiers', () => {
  const db = new DatabaseSync(':memory:')
  const migrator = createMigrator({ baseline: 1 })
    .version(2, 'probe')
    .upgrade((_handle, ctx) => {
      assert.throws(() => ctx.hasTable("x'; DROP TABLE users; --"), /invalid table/)
      assert.throws(() => ctx.hasColumn('x y', 'id'), /invalid table/)
    })
  migrator.prepare(db)
})
