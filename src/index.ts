/**
 * createStore(cfg): debounced write-through row store with a recursive Proxy.
 * Row access: store.bind(db) or db.table(name) (table.ts). Model methods here
 * (create, find, upsert, ...) are the internal engine, used only by table.ts.
 *
 * cfg:
 *   table          SQL table name
 *   columnMap      camelCase field -> column overrides; rest from PRAGMA table_info (*_json -> blob)
 *   blobKeys       extra fields stored as JSON
 *   booleanKeys    fields decoded 0/1 -> boolean
 *   defaults       { field: () => value } used when a blob column is NULL or corrupt
 *   afterDecode    (obj, row) hook at the end of decode()
 *   beforeCreate   (doc) hook before add() INSERTs: set ids/defaults
 *   conflict       columns forming the upsert target and narrow-UPDATE WHERE
 *   keyOf(obj)     stable pending-map key for a row
 *   flushMs        debounce window (ms)
 *   label          log label
 *   stateColumn    column for unmapped keys (default 'state_json'; null drops them)
 *   transientKeys  extra runtime-only keys (never persisted)
 *   wrapResults    false: find/findOne return plain objects (no Proxy)
 *   virtual        { field: { owns, columns(value), sync(db, raw), hydrate(db, pairs) } }
 *   logger         { warn, error } (default console); hooks { creating, updating, deleting, reading, changed } = store.on
 *   schema         table definition (schema.ts); store.define(db) creates/extends it and its children
 *
 * Write model:
 * - The set trap records dirty camelCase keys; flush() writes only those columns (+ updated_at).
 * - First flush of a row = full INSERT ON CONFLICT; later flushes = narrow UPDATE.
 * - flushAll() drains all pending rows, one transaction per database (per-row savepoints if a row fails).
 * - Virtual fields have no column: columns() adds columns on the full path; sync() runs after the row SQL in a savepoint.
 *
 * Limits:
 * - Only plain objects/arrays are proxied. Date/Map/Set/Buffer mutations are untracked: reassign the field.
 * - Deleted rows are tombstoned: queued writes are dropped until create() revives the key.
 *   A narrow UPDATE on a deleted row throws permanently (no retry).
 */

import type { DatabaseSync } from 'node:sqlite'
import { camel, isPlain, parseBlob } from './codec'
import { createMigrationContext } from './context'
import { createScheduler } from './flush-scheduler'
import { createMigrator, openDatabase } from './migrate'
import { buildQuery, criteria, isOperator } from './query'
import {
  columnOf,
  defineTable,
  diffTable,
  ident,
  normalizeSchema,
  rebuildTable,
  tableInfo,
} from './schema'
import { bindTable, transaction } from './table'
import type { AnyRow, ColumnDef, InternalEngine, Logger, Store, StoreConfig, Table } from './types'
import { buildVirtual } from './virtual'

type Statement = ReturnType<DatabaseSync['prepare']>

export type * from './types'
export { camel, isPlain, parseBlob }

type Hook = (...args: any[]) => void

export function createStore<Row extends object = AnyRow>(cfg: StoreConfig<Row>): Store<Row> {
  const { conflict, flushMs, label } = cfg
  const stmtCache = new WeakMap<DatabaseSync, Map<string, Statement>>()
  const MAX_STATEMENTS = 200
  function prepare(db: DatabaseSync, sql: string): Statement {
    let cache = stmtCache.get(db)
    if (!cache) {
      cache = new Map()
      stmtCache.set(db, cache)
    }
    let statement = cache.get(sql)
    if (!statement) {
      statement = db.prepare(sql)
      if (cache.size >= MAX_STATEMENTS) cache.delete(cache.keys().next().value as string)
      cache.set(sql, statement)
    }
    return statement
  }
  function clearStatements(db: DatabaseSync): void {
    stmtCache.delete(db)
  }
  const keyOf = cfg.keyOf as (obj: AnyRow) => string
  ident(cfg.table, 'table')
  const columnMap: Record<string, string> = { ...(cfg.columnMap || {}) }
  const blobKeys = new Set(cfg.blobKeys || [])
  const booleanKeys = new Set(cfg.booleanKeys || [])
  const logger: Logger = cfg.logger || console
  const transientKeys = cfg.transientKeys || new Set<string>()
  const stateColumn = cfg.stateColumn === undefined ? 'state_json' : cfg.stateColumn
  const wrapResults = cfg.wrapResults !== false
  const schema = cfg.schema ? normalizeSchema(cfg.table, cfg.schema) : undefined
  const virtual =
    (cfg.virtual as Record<string, any> | undefined) ||
    buildVirtual(cfg.table, schema, conflict, logger)
  const virtualKeys = new Set(Object.keys(virtual))

  // Hooks (cfg.hooks | store.on): creating, updating (narrow path), deleting, reading, changed.
  const hooks: Record<string, Hook[]> = {
    creating: [],
    updating: [],
    deleting: [],
    reading: [],
    changed: [],
  }
  function on(name: string, fn: Hook): void {
    if (!hooks[name]) throw new Error(label + ': unknown hook ' + name)
    if (typeof fn !== 'function') throw new Error(label + ': hook ' + name + ' needs a function')
    hooks[name].push(fn)
  }
  function emit(name: string, ...args: unknown[]): void {
    for (const fn of hooks[name] || []) fn(...args)
  }

  function onChange(fn: Hook): () => void {
    on('changed', fn)
    return () => {
      const list = hooks.changed || []
      const i = list.indexOf(fn)
      if (i >= 0) list.splice(i, 1)
    }
  }
  for (const [name, fn] of Object.entries(cfg.hooks || {})) if (fn) on(name, fn)
  const keyByColumn: Record<string, string> = {}
  for (const [k, c] of Object.entries(columnMap)) keyByColumn[c] = k
  let tableColumns: string[] = Object.values(columnMap)
  let introspected = false

  // One-time column introspection (*_json -> blob); state and virtual-owned columns stay unmapped.
  function ensure(db: DatabaseSync): void {
    if (introspected) return
    const info = tableInfo(db, cfg.table)
    if (info.length === 0) return
    const owned = new Set<string>()
    for (const field of Object.values<any>(virtual)) {
      for (const column of field.owns || []) owned.add(column)
    }
    const mapped = new Set(Object.values(columnMap))
    tableColumns = info.map((c) => c.name)
    for (const name of tableColumns) {
      if (name === stateColumn || owned.has(name) || mapped.has(name)) continue
      const isBlob = name.endsWith('_json')
      const key = camel(isBlob ? name.slice(0, -5) : name)
      columnMap[key] = name
      if (isBlob) blobKeys.add(key)
    }
    for (const [k, c] of Object.entries(columnMap)) keyByColumn[c] = k
    introspected = true
  }

  function sql(db: DatabaseSync, tail = ''): string {
    ensure(db)
    return 'SELECT ' + tableColumns.join(', ') + ' FROM ' + cfg.table + (tail ? ' ' + tail : '')
  }

  // Unmapped '_'-prefixed or cfg.transientKeys key: never persisted, dropped on read.
  function isTransient(key: unknown): boolean {
    if (typeof key !== 'string' || columnMap[key] || virtualKeys.has(key)) return false
    return key.startsWith('_') || transientKeys.has(key)
  }

  function decode(row: AnyRow | undefined | null): AnyRow | null {
    if (!row) return null
    const obj: AnyRow = {}
    for (const [key, column] of Object.entries(columnMap)) {
      if (!(column in row)) continue
      let value = row[column] === undefined ? null : row[column]
      if (blobKeys.has(key)) {
        const make = cfg.defaults && cfg.defaults[key]
        value = parseBlob(
          value,
          typeof make === 'function' ? make() : null,
          cfg.table + '.' + column,
          logger,
        )
      } else if (booleanKeys.has(key)) {
        value = value === null ? null : value === 1
      }
      obj[key] = value
    }
    if (stateColumn && stateColumn in row) {
      const state = parseBlob<AnyRow>(row[stateColumn], {}, cfg.table + '.' + stateColumn, logger)
      for (const [key, value] of Object.entries(state)) {
        if (!(key in obj) && !isTransient(key)) obj[key] = value
      }
    }
    if (typeof cfg.afterDecode === 'function') cfg.afterDecode(obj as Row, row)
    return obj
  }

  function hydrate(db: DatabaseSync, rows: AnyRow[]): AnyRow[] {
    const objs = rows.map((row) => decode(row) as AnyRow)
    for (const field of Object.values<any>(virtual)) {
      if (typeof field.hydrate !== 'function') continue
      field.hydrate(
        db,
        rows.map((row, i) => ({ row, obj: objs[i] })),
      )
    }
    return objs
  }

  function encodeValue(key: string, value: unknown): unknown {
    if (blobKeys.has(key)) {
      return value === null || value === undefined ? null : JSON.stringify(value)
    }
    if (typeof value === 'boolean') return value ? 1 : 0
    if (value === undefined) return null
    // SQLite cannot store NaN/Infinity: bind NULL.
    if (typeof value === 'number' && !Number.isFinite(value)) return null
    return value
  }

  const queryDeps = { label, columnOf: (key: string) => columnMap[key], encodeValue }

  // filter: raw SQL tail (+ params array) or filter object (+ { sort, limit, offset }).
  function query(
    db: DatabaseSync,
    filter: AnyRow | string,
    extra?: AnyRow | any[],
  ): { tail: string; params: any[] } {
    ensure(db)
    return buildQuery(queryDeps, filter, extra)
  }

  const {
    pending,
    schedule,
    markDirty,
    cancel,
    cancelWhere,
    pendingMatch,
    flushAll,
    pendingCount,
    revive,
  } = createScheduler({
    label,
    flushMs,
    logger,
    keyOf,
    flush: (db, obj, dirty) => flush(db, obj, dirty),
  })

  function find(db: DatabaseSync, filter: AnyRow | string = {}, extra?: AnyRow | any[]): AnyRow[] {
    const { tail, params } = query(db, filter, extra)
    const rows = prepare(db, sql(db, tail)).all(...params) as AnyRow[]
    return hydrate(db, rows).map((obj) => {
      emit('reading', obj)
      return wrapResults ? wrap(db, obj) : obj
    })
  }

  function findOne(
    db: DatabaseSync,
    filter: AnyRow | string = {},
    extra?: AnyRow | any[],
  ): AnyRow | null {
    const { tail, params } = query(db, filter, extra)
    const row = prepare(db, sql(db, tail)).get(...params) as AnyRow | undefined
    if (!row) return null
    const obj = hydrate(db, [row])[0] as AnyRow
    emit('reading', obj)
    return wrapResults ? wrap(db, obj) : obj
  }

  function keyFilter(db: DatabaseSync, ...values: unknown[]): AnyRow {
    ensure(db)
    const filter: AnyRow = {}
    conflict.forEach((column, i) => {
      const key = keyByColumn[column]
      if (key) filter[key] = values[i]
    })
    return filter
  }

  function keyFilterOf(db: DatabaseSync, obj: AnyRow): AnyRow {
    ensure(db)
    const raw = obj && obj.__raw ? obj.__raw : obj
    const filter: AnyRow = {}
    for (const column of conflict) {
      const key = keyByColumn[column]
      if (key) filter[key] = raw[key]
    }
    return filter
  }

  function findById(db: DatabaseSync, ...values: unknown[]): AnyRow | null {
    return findOne(db, keyFilter(db, ...values))
  }

  function count(db: DatabaseSync, filter: AnyRow = {}): number {
    ensure(db)
    const { where, params } = criteria(queryDeps, filter)
    const row = prepare(
      db,
      'SELECT COUNT(*) AS n FROM ' + cfg.table + (where ? ' ' + where : ''),
    ).get(...params) as { n: number }
    return row.n
  }

  function create(db: DatabaseSync, fields: AnyRow): AnyRow {
    ensure(db)
    const now = Date.now()
    const doc: AnyRow = { ...fields }
    if (typeof cfg.beforeCreate === 'function') cfg.beforeCreate(doc as Row)
    emit('creating', doc)
    if (columnMap.createdAt && (doc.createdAt === undefined || doc.createdAt === null)) {
      doc.createdAt = now
    }
    doc.updatedAt = now
    flush(db, doc)
    revive(keyOf(doc as AnyRow))
    emit('changed', { table: cfg.table, op: 'create' })
    return wrap(db, doc)
  }

  function updateOne(db: DatabaseSync, filter: AnyRow, patch: AnyRow): AnyRow | null {
    const doc = findOne(db, filter)
    if (!doc) return null
    Object.defineProperty(doc, '__persisted', {
      value: true,
      enumerable: false,
      writable: true,
    })
    const live = wrapResults ? doc : wrap(db, doc)
    for (const [key, value] of Object.entries(patch || {})) live[key] = value
    return doc
  }

  function upsert(db: DatabaseSync, filter: AnyRow, fields: AnyRow = {}): AnyRow {
    const existing = findOne(db, filter)
    if (existing) {
      Object.defineProperty(existing, '__persisted', {
        value: true,
        enumerable: false,
        writable: true,
      })
      const live = wrapResults ? existing : wrap(db, existing)
      for (const [key, value] of Object.entries(fields)) live[key] = value
      return live
    }
    return create(db, { ...filter, ...fields })
  }

  // In-memory match for pending rows; same semantics as criteria().
  function pendingMatches(filter: AnyRow): (obj: AnyRow) => boolean {
    return (obj) => {
      for (const [key, value] of Object.entries(filter)) {
        const actual = obj[key]
        if (isOperator(value)) {
          for (const [op, operand] of Object.entries(value as AnyRow)) {
            if (op === 'above' && !(actual > operand)) return false
            if (op === 'aboveOrEqual' && !(actual >= operand)) return false
            if (op === 'below' && !(actual < operand)) return false
            if (op === 'belowOrEqual' && !(actual <= operand)) return false
            if (op === 'notEqual' && actual === operand) return false
            if (op === 'between' && !(actual >= operand[0] && actual <= operand[1])) return false
            if (op === 'startsWith' && !String(actual).startsWith(String(operand))) return false
            if (op === 'noneOf' && operand.includes(actual)) return false
          }
        } else if (value === null || value === undefined) {
          if (actual !== null && actual !== undefined) return false
        } else if (Array.isArray(value)) {
          if (!value.includes(actual)) return false
        } else {
          if (actual !== value) return false
        }
      }
      return true
    }
  }

  function deleteOne(db: DatabaseSync, filter: AnyRow): number {
    ensure(db)
    const { where, params } = criteria(queryDeps, filter)
    const row = prepare(db, sql(db, (where + ' LIMIT 1').trim())).get(...params) as
      AnyRow | undefined
    if (!row) {
      // Never-flushed row may still be queued: cancel + tombstone it.
      pendingMatch(pendingMatches(filter))
      return 0
    }
    const doc = decode(row)
    emit('deleting', doc)
    cancel(keyOf(doc as AnyRow), { tombstone: true })
    pendingMatch(pendingMatches(filter))
    const byKey = conflict.map((c) => c + ' = ?').join(' AND ')
    const changes = prepare(db, 'DELETE FROM ' + cfg.table + ' WHERE ' + byKey).run(
      ...conflict.map((c) => row[c]),
    ).changes
    emit('changed', { table: cfg.table, op: 'delete' })
    return Number(changes)
  }

  function deleteMany(db: DatabaseSync, filter: AnyRow): number {
    ensure(db)
    const { where, params } = criteria(queryDeps, filter)
    for (const row of prepare(db, sql(db, where)).all(...params) as AnyRow[]) {
      const doc = decode(row)
      emit('deleting', doc)
      cancel(keyOf(doc as AnyRow), { tombstone: true })
    }
    // Also tombstone never-flushed pending matches.
    pendingMatch(pendingMatches(filter))
    const changes = prepare(db, 'DELETE FROM ' + cfg.table + (where ? ' ' + where : '')).run(
      ...params,
    ).changes
    emit('changed', { table: cfg.table, op: 'delete' })
    return Number(changes)
  }

  // Full projection: unmapped keys -> stateColumn; virtual fields add columns.
  function columnProjection(obj: AnyRow): {
    columns: Record<string, unknown>
    state: string | null
  } {
    const columns: Record<string, unknown> = {}
    const state: AnyRow = {}
    for (const [key, value] of Object.entries(obj)) {
      const column = columnMap[key]
      if (!column) {
        if (!isTransient(key) && !virtualKeys.has(key) && stateColumn) state[key] = value
        continue
      }
      columns[column] = encodeValue(key, value)
    }
    for (const key of virtualKeys) {
      if (obj[key] === undefined) continue
      Object.assign(columns, virtual[key].columns(obj[key]))
    }
    return {
      columns,
      state: !stateColumn || Object.keys(state).length === 0 ? null : JSON.stringify(state),
    }
  }

  // Narrow projection: dirty mapped keys; a dirty unmapped key rebuilds the state blob.
  function changedProjection(
    obj: AnyRow,
    dirty: Set<string>,
  ): { columns: Record<string, unknown>; stateDirty: boolean } {
    const columns: Record<string, unknown> = {}
    let stateDirty = false
    for (const key of dirty) {
      if (virtualKeys.has(key)) {
        Object.assign(columns, virtual[key].columns(obj[key]))
        continue
      }
      const column = columnMap[key]
      if (column) columns[column] = encodeValue(key, obj[key])
      else if (!isTransient(key) && stateColumn) stateDirty = true
    }
    if (stateDirty && stateColumn) {
      columns[stateColumn] = columnProjection(obj).state
    }
    return { columns, stateDirty }
  }

  function updateSql(names: string[]): string {
    const updates = names
      .filter((n) => !conflict.includes(n))
      .map((n) => n + ' = excluded.' + n)
      .join(', ')
    return (
      'INSERT INTO ' +
      cfg.table +
      ' (' +
      names.join(', ') +
      ') VALUES (' +
      names.map(() => '?').join(', ') +
      ') ON CONFLICT(' +
      conflict.join(', ') +
      ') ' +
      // A row made only of key columns has nothing to update.
      (updates ? 'DO UPDATE SET ' + updates : 'DO NOTHING')
    )
  }

  function syncVirtual(db: DatabaseSync, raw: AnyRow, keys: string[]): void {
    for (const key of keys) {
      const hook = virtual[key]
      if (hook && typeof hook.sync === 'function') hook.sync(db, raw)
    }
  }

  // Persist a row. dirty = changed camelCase keys; omitted = full insert.
  // Never-flushed rows always take the full path (a narrow UPDATE would violate NOT NULL).
  function flush(db: DatabaseSync, obj: AnyRow, dirty: Set<string> | null = null): void {
    ensure(db)
    const raw: AnyRow = obj && obj.__raw ? obj.__raw : obj
    // Missing key columns can never succeed: permanent error, no retry.
    const missing = conflict.filter((c) => {
      const key = keyByColumn[c]
      const value = key ? raw[key] : undefined
      return value === undefined || value === null || value === ''
    })
    if (missing.length > 0) {
      const bad = new Error(label + ' row is missing key column(s): ' + missing.join(', '))
      ;(bad as any).permanent = true
      throw bad
    }
    const now = Date.now()
    raw.updatedAt = now

    let columns: Record<string, unknown>
    let narrow = false
    let syncKeys: string[]
    if (raw.__persisted && dirty && dirty.size > 0) {
      emit('updating', dirty, raw)
      columns = changedProjection(raw, dirty).columns
      narrow = true
      syncKeys = [...dirty].filter((k) => virtualKeys.has(k))
    } else {
      const projection = columnProjection(raw)
      columns = projection.columns
      if (stateColumn) columns[stateColumn] = projection.state
      syncKeys = [...virtualKeys]
    }
    if (tableColumns.includes('updated_at')) columns.updated_at = now

    const names = Object.keys(columns)
    if (names.length > 0) {
      if (narrow) {
        // Plain UPDATE: a partial-column INSERT ... ON CONFLICT fails NOT NULL on key columns.
        const sets = names.map((n) => n + ' = ?').join(', ')
        const where = conflict.map((c) => c + ' = ?').join(' AND ')
        const params = [
          ...names.map((n) => columns[n]),
          ...conflict.map((c) => raw[keyByColumn[c] || c]),
        ]
        const result = prepare(db, 'UPDATE ' + cfg.table + ' SET ' + sets + ' WHERE ' + where).run(
          ...(params as any[]),
        )
        if (result.changes === 0) {
          const gone = new Error(label + ' narrow update matched no row')
          ;(gone as any).permanent = true
          throw gone
        }
      } else {
        prepare(db, updateSql(names)).run(...(names.map((n) => columns[n]) as any[]))
      }
    }
    // Runs even when no row column changed (child-only change).
    if (syncKeys.length > 0) {
      db.exec('SAVEPOINT zk_sync')
      try {
        syncVirtual(db, raw, syncKeys)
        db.exec('RELEASE zk_sync')
      } catch (error) {
        db.exec('ROLLBACK TO zk_sync')
        db.exec('RELEASE zk_sync')
        throw error
      }
    }
    // Non-enumerable: stays out of projections and state_json.
    Object.defineProperty(raw, '__persisted', { value: true, enumerable: false, writable: true })
  }

  // Recursive Proxy: nested writes dirty the root row and schedule a flush.
  // Cache is per wrap() call: rows sharing a nested object must not share a proxy.
  // top = root-level field name that a nested write dirties.
  function deepWrap(
    db: DatabaseSync,
    root: AnyRow,
    value: any,
    cache: WeakMap<object, any>,
    top: string | symbol | null = null,
  ): any {
    if (!isPlain(value)) return value
    const cached = cache.get(value)
    if (cached) return cached
    const proxy = new Proxy(value, {
      get(target, key) {
        if (key === '__raw') return target
        return deepWrap(db, root, target[key], cache, top || key)
      },
      set(target, key, next) {
        const noop =
          key in target &&
          Object.is(target[key], next) &&
          (next === null || (typeof next !== 'object' && typeof next !== 'function'))
        target[key] = next
        if (noop) return true
        // Root updatedAt/createdAt are flush artifacts (no reschedule); nested ones are data.
        if (!top && (key === 'updatedAt' || key === 'createdAt')) return true
        if (isTransient(top || key)) return true
        markDirty(db, root, (top || key) as string)
        return true
      },
      deleteProperty(target, key) {
        delete target[key]
        if (isTransient(top || key)) return true
        markDirty(db, root, (top || key) as string)
        return true
      },
    })
    cache.set(value, proxy)
    return proxy
  }

  function define(db: DatabaseSync): void {
    if (!schema) return
    defineTable(db, cfg.table, schema, { stateColumn })
    for (const child of schema.children || []) defineTable(db, child.table, child.schema)
    clearStatements(db)
  }

  function wrap(db: DatabaseSync, obj: AnyRow): AnyRow {
    ensure(db)
    return deepWrap(db, obj, obj, new WeakMap(), null)
  }

  function flushNow(db: DatabaseSync, obj: AnyRow): void {
    const key = keyOf(obj)
    const entry = pending.get(key)
    cancel(key)
    try {
      flush(db, obj, entry ? entry.dirty : null)
    } catch (error) {
      // Log: stays visible if the caller swallows it.
      logger.error(label + ' flushNow failed: ', error)
      throw error
    }
  }

  function bind(db: DatabaseSync): Table<any> {
    ensure(db)
    const table = bindTable(engine, db)
    const base = cfg.table.replace(/s$/, '')
    const children: Record<string, Table<any>> = {}
    for (const child of (schema && schema.children) || []) {
      const fields =
        child.schema.primaryKey ||
        Object.keys(child.schema.columns).filter((k) => child.schema.columns[k]?.primary)
      const sub = createStore({
        table: child.table,
        schema: child.schema,
        conflict: fields.map((k) => columnOf(k, child.schema.columns[k] as ColumnDef)),
        keyOf: (row: AnyRow) => fields.map((k) => row[k]).join('|'),
        flushMs,
        label: child.table,
        stateColumn: null,
        logger,
      })
      const bound = sub.bind(db)
      children[child.table] = bound
      const short = child.table.startsWith(base + '_') ? child.table.slice(base.length + 1) : null
      if (short && !(short in table)) {
        children[short] = bound
        table[short] = bound
      }
    }
    table.children = children
    return table
  }

  function diff(db: DatabaseSync) {
    return diffTable(db, cfg.table, schema || { columns: {} }, { stateColumn })
  }

  // Rebuild to the schema (retype, drop, rename via `from`), keeping data. Returns the plan.
  // Needs PRAGMA foreign_keys = OFF (migrator.prepare provides it).
  function migrate(db: DatabaseSync) {
    const plan = diff(db)
    if (plan.missing.length + plan.extra.length + plan.retyped.length + plan.renamed.length > 0) {
      rebuildTable(db, cfg.table, schema || { columns: {} }, { stateColumn })
      introspected = false
      clearStatements(db)
    }
    return plan
  }

  const engine: InternalEngine<Row> = {
    bind,
    diff,
    migrate,
    on,
    onChange,
    keyFilter,
    keyFilterOf,
    cancel,
    cancelWhere,
    columnProjection,
    get schema() {
      return schema
    },
    get table() {
      return cfg.table
    },
    decode,
    count,
    create,
    define,
    deleteMany,
    deleteOne,
    find,
    findById,
    findOne,
    flush,
    flushAll,
    flushNow,
    isTransient,
    pendingCount,
    save: flushNow,
    schedule,
    sql,
    updateOne,
    upsert,
    wrap,
  }

  const PUBLIC = [
    'bind',
    'define',
    'diff',
    'migrate',
    'on',
    'onChange',
    'wrap',
    'flush',
    'flushNow',
    'flushAll',
    'schedule',
    'cancel',
    'cancelWhere',
    'sql',
    'decode',
    'columnProjection',
    'isTransient',
    'pendingCount',
  ]
  const api: Record<string, any> = {
    get schema() {
      return schema
    },
    get table() {
      return cfg.table
    },
  }
  const engineAny = engine as unknown as Record<string, any>
  for (const name of PUBLIC) api[name] = engineAny[name]
  return api as unknown as Store<Row>
}

export {
  createMigrationContext,
  createMigrator,
  defineTable,
  normalizeSchema,
  openDatabase,
  transaction,
}
