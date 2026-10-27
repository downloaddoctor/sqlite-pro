/**
 * Versioned migrations. Two equivalent styles:
 *
 *   createMigrator({ baseline, steps, legacy, stores, define, logger })
 *   createMigrator({ define, logger }).version(5, 'add flags').upgrade((db) => { ... })
 *
 * .version(n, name).upgrade(cb) appends a ladder step; .legacy(upgrade) appends a pre-baseline upgrade.
 *
 *   baseline  schema version the declared schemas describe
 *   steps     ladder [{ v, name, up(db, ctx) }] after the baseline; each runs in its own
 *             BEGIN IMMEDIATE...COMMIT with its schema_version bump (failure rolls back); beforeDefine steps use a SAVEPOINT instead
 *   legacy    [{ name, message?, up(db) -> boolean }] old on-disk shape upgrades (foreign keys OFF)
 *   define    (db) => void, creates/extends host tables
 *   stores    stores the migrator owns: each store.define(db) runs before cfg.define; exposed as db.<table>, db.table(name), db.transaction(fn)
 *
 * prepare(db): FK OFF, refuse newer db, legacy, meta table, beforeDefine steps, define, FK ON,
 * remaining ladder steps, store schema_version. Additive schema changes need no step: define() runs on every open.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createMigrationContext } from './context'
import { defineTable } from './schema'
import { attachHelpers } from './table'
import type {
  Migration,
  MigrationContext,
  Migrator,
  MigratorConfig,
  NormalizedSchema,
  OpenDatabaseConfig,
  OpenDatabaseMigrator,
} from './types'

const META_SCHEMA: NormalizedSchema = {
  columns: { key: { type: 'text', primary: true }, value: { type: 'text' } },
}

type Step = Omit<Migration, 'up'> & { up: Migration['up'] | null }

function failure(step: Step, error: unknown, version: number): Error {
  const message = error instanceof Error ? error.message : String(error)
  return new Error(
    'Migration to schema_version ' +
      step.v +
      ' failed: ' +
      message +
      ' (database left at version ' +
      version +
      ')',
  )
}

export function createMigrator(cfg: MigratorConfig = {}): Migrator {
  const steps: Step[] = [...(cfg.steps || [])]
  // Owned stores: define() calls each store.define(db).
  const stores = [...(cfg.stores || [])]
  const legacy = [...(cfg.legacy || [])]
  const logger = cfg.logger || console
  let baseline = cfg.baseline === undefined ? 0 : cfg.baseline
  let lastStep: Step | null = null
  // Passed to every upgrade callback as ctx.
  let context: MigrationContext | null = null

  const schemaVersion = (): number => Math.max(baseline, ...steps.map((step) => step.v))

  function getMeta(db: DatabaseSync, key: string): string | null {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      { value: string | null } | undefined
    return row ? row.value : null
  }

  function setMeta(db: DatabaseSync, key: string, value: unknown): void {
    db.prepare(
      'INSERT INTO meta (key, value) VALUES (?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, String(value))
  }

  function getVersion(db: DatabaseSync): number {
    const value = Number(getMeta(db, 'schema_version'))
    return Number.isSafeInteger(value) && value > 0 ? value : baseline
  }

  // Fail closed: refuse a database newer than the code.
  function assertSupported(db: DatabaseSync): void {
    const table = db
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
      .get()
    if (!table) return

    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      { value: unknown } | undefined
    if (!row || row.value === null || String(row.value).trim() === '') return

    const text = String(row.value).trim()
    if (!/^\d+$/.test(text)) throw new Error('Invalid SQLite schema_version: ' + text)
    const version = Number(text)
    if (!Number.isSafeInteger(version)) throw new Error('Invalid SQLite schema_version: ' + text)
    if (version > schemaVersion()) {
      throw new Error(
        'SQLite schema_version ' +
          version +
          ' is newer than the supported version ' +
          schemaVersion() +
          '. Refusing to open.',
      )
    }
  }

  function callback(step: Step): NonNullable<Step['up']> {
    if (typeof step.up !== 'function') {
      throw new Error('Migration ' + step.v + ' (' + step.name + ') has no upgrade callback')
    }
    return step.up
  }

  function run(db: DatabaseSync, list: Step[] = steps): void {
    const ordered = [...list].sort((a, b) => a.v - b.v)
    for (const step of ordered) {
      if (step.v <= getVersion(db)) continue
      const up = callback(step)
      db.exec('BEGIN IMMEDIATE')
      try {
        up(db, context as MigrationContext)
        setMeta(db, 'schema_version', step.v)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw failure(step, error, getVersion(db))
      }
    }
  }

  // Run beforeDefine steps (FK OFF) ahead of define(); returns the remaining steps.
  function runBeforeDefine(db: DatabaseSync): Step[] {
    const early = steps.filter((step) => step.beforeDefine)
    const late = steps.filter((step) => !step.beforeDefine)
    for (const step of early) {
      if (step.v <= getVersion(db)) continue
      const up = callback(step)
      db.exec('SAVEPOINT zk_early')
      try {
        const changed = up(db, context as MigrationContext)
        if (changed !== false) setMeta(db, 'schema_version', step.v)
        db.exec('RELEASE zk_early')
      } catch (error) {
        db.exec('ROLLBACK TO zk_early')
        db.exec('RELEASE zk_early')
        throw failure(step, error, getVersion(db))
      }
    }
    return late
  }

  function upgradeLegacy(db: DatabaseSync): void {
    for (const upgrade of legacy) {
      if (upgrade.up(db)) logger.warn(upgrade.message || 'legacy upgrade applied: ' + upgrade.name)
    }
  }

  function define(db: DatabaseSync): void {
    for (const store of stores) store.define(db)
    if (typeof cfg.define === 'function') cfg.define(db)
  }

  function attachStores(db: DatabaseSync): DatabaseSync {
    for (const store of stores) {
      if (store.table) (db as unknown as Record<string, unknown>)[store.table] = store
    }
    attachHelpers(db, stores)
    return db
  }

  function prepare(db: DatabaseSync): void {
    for (const step of steps) callback(step)
    attachStores(db)
    context = createMigrationContext(db, { stores })
    // FK off: a live FK blocks dropping referenced tables during rebuilds.
    db.exec('PRAGMA foreign_keys = OFF')
    assertSupported(db)
    upgradeLegacy(db)
    defineTable(db, 'meta', META_SCHEMA)
    const late = runBeforeDefine(db)
    define(db)
    db.exec('PRAGMA foreign_keys = ON')
    run(db, late)
    if (getMeta(db, 'schema_version') === null || getVersion(db) < schemaVersion()) {
      setMeta(db, 'schema_version', Math.max(getVersion(db), schemaVersion()))
    }
  }

  // .version(n, name?) declares a step; .upgrade(cb) attaches its callback.
  // Baseline defaults to the lowest declared version.
  function version(n: number, name?: string): Migrator {
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error('Invalid migration version: ' + n)
    for (const step of steps) {
      if (step.v === n) throw new Error('Duplicate migration version: ' + n)
    }
    if (cfg.baseline === undefined) {
      baseline = Math.min(baseline === 0 ? n : baseline, n)
    }
    lastStep = { v: n, name: name || 'version ' + n, up: null, beforeDefine: false }
    steps.push(lastStep)
    return api
  }

  // Run the preceding version(n) step before define(), FK OFF.
  function beforeDefine(): Migrator {
    if (!lastStep) throw new Error('beforeDefine() must follow version(n)')
    lastStep.beforeDefine = true
    return api
  }

  function upgrade(cb: NonNullable<Step['up']>): Migrator {
    if (typeof cb !== 'function') throw new Error('upgrade(cb) requires a function')
    if (!lastStep) throw new Error('upgrade(cb) must follow version(n)')
    lastStep.up = cb
    lastStep = null
    return api
  }

  function addLegacy(entry: Parameters<Migrator['legacy']>[0]): Migrator {
    legacy.push(entry)
    return api
  }

  const api: Migrator = {
    get SCHEMA_VERSION() {
      return schemaVersion()
    },
    get baseline() {
      return baseline
    },
    get steps() {
      return steps as Migration[]
    },
    get legacyUpgrades() {
      return legacy
    },
    get stores() {
      return stores
    },
    assertSupported,
    define,
    getMeta,
    getVersion,
    attachStores,
    prepare,
    run: run as Migrator['run'],
    setMeta,
    beforeDefine,
    version,
    upgrade,
    legacy: addLegacy,
  }

  return api
}

/**
 * One-call open: mkdir, PRAGMAs, prepare (legacy, meta, beforeDefine steps, store schemas, ladder); returns the live handle.
 *
 *   const db = openDatabase({
 *     file: 'app.db',
 *     stores: [widgets, gadgets],
 *     baseline: 4,
 *     legacy: [{ name: 'v3->v4', up: upgradeV3ToV4 }],
 *   })
 *     .version(5, 'add flags')
 *     .upgrade((handle) => handle.exec('ALTER TABLE widgets ADD COLUMN flags INTEGER'))
 *     .open()
 */
export function openDatabase(cfg: OpenDatabaseConfig = {}): OpenDatabaseMigrator {
  const pragmas = cfg.pragmas || ['PRAGMA journal_mode = WAL', 'PRAGMA busy_timeout = 5000']
  const migrator = createMigrator(cfg) as OpenDatabaseMigrator

  migrator.open = (file?: string): DatabaseSync => {
    const target = file || cfg.file
    if (!target) throw new Error('openDatabase: no file given')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const db = new DatabaseSync(target)
    try {
      for (const pragma of pragmas) db.exec(pragma)
      // prepare() attaches stores (db.widgets, ...) before any step runs.
      migrator.prepare(db)
    } catch (error) {
      // Close on failed open so the file/WAL is not left locked.
      db.close()
      throw error
    }
    return db
  }
  return migrator
}
