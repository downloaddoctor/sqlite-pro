/**
 * Migration helpers: second argument of every upgrade callback.
 * Rows are read/written as camelCase objects through the owning store, no hand-written SQL:
 *
 *   .version(5, 'split displayName')
 *   .upgrade((db, ctx) => {
 *     ctx.rename('widgets', 'widgets_old')
 *     ctx.storeFor('widgets')?.define(db)   // recreate the renamed-away table before copying into it
 *     ctx.copy('widgets', 'widgets_old', (row) => ({ ...row, firstName: row.displayName }))
 *     ctx.drop('widgets_old')
 *   })
 *
 * ctx.table(name) uses the matching store (or live PRAGMA table_info if none); ctx.copy/rename/drop are shortcuts over it, ctx.storeFor(name) returns the owning store. Table methods:
 *   rows()          all rows, decoded to camelCase
 *   insert(obj)     one row, encoded through the store
 *   rename(to)      ALTER TABLE ... RENAME TO
 *   drop()          DROP TABLE (also insertMany(list), columns(), sql(stmt, ...params), get(stmt, ...params))
 */

import type { DatabaseSync } from 'node:sqlite'
import { columnOf, ident, tableInfo } from './schema'
import type { AnyRow, MigrationContext, MigrationTable, StoreLike } from './types'

const camel = (name: string): string => name.replace(/_([a-z0-9])/g, (_m, ch) => ch.toUpperCase())

interface Shape {
  keyByColumn: Record<string, string>
  columnByKey: Record<string, string>
  store: StoreLike | null
}

// Column maps for a table: from the store schema, else from PRAGMA table_info.
function shapeOf(db: DatabaseSync, store: StoreLike | undefined, name: string): Shape {
  const keyByColumn: Record<string, string> = {}
  const columnByKey: Record<string, string> = {}
  if (store && store.schema && store.schema.columns) {
    for (const key of Object.keys(store.schema.columns)) {
      const def = store.schema.columns[key]
      if (!def) throw new Error('sqlite-pro: unknown field ' + key)
      const column = columnOf(key, def)
      keyByColumn[column] = key
      columnByKey[key] = column
    }
    return { keyByColumn, columnByKey, store }
  }
  for (const info of tableInfo(db, name)) {
    const key = info.name.endsWith('_json') ? camel(info.name.slice(0, -5)) : camel(info.name)
    keyByColumn[info.name] = key
    columnByKey[key] = info.name
  }
  return { keyByColumn, columnByKey, store: null }
}

export function createMigrationContext(
  db: DatabaseSync,
  cfg: { stores?: StoreLike[] } = {},
): MigrationContext {
  const stores = cfg.stores || []

  function storeFor(name: string): StoreLike | undefined {
    return stores.find((store) => store.table === name)
  }

  function table(name: string, explicitStore?: StoreLike): MigrationTable {
    ident(name, 'table')
    const info = shapeOf(db, explicitStore || storeFor(name), name)

    function rows(): AnyRow[] {
      const store = info.store
      const raw = db.prepare('SELECT * FROM ' + name).all() as AnyRow[]
      if (store && typeof store.decode === 'function') {
        return raw.map((row) => store.decode?.(row) as AnyRow)
      }
      return raw.map((row) => {
        const obj: AnyRow = {}
        for (const [column, value] of Object.entries(row)) {
          obj[info.keyByColumn[column] || column] = value
        }
        return obj
      })
    }

    function encode(obj: AnyRow): { columns: Record<string, unknown>; state: string | null } {
      const store = info.store
      if (store && typeof store.columnProjection === 'function') {
        const projection = store.columnProjection(obj)
        return { columns: { ...projection.columns }, state: projection.state }
      }
      const columns: Record<string, unknown> = {}
      const state: AnyRow = {}
      for (const [key, value] of Object.entries(obj)) {
        const column = info.columnByKey[key]
        if (column) columns[column] = value
        else if (!key.startsWith('_')) state[key] = value
      }
      return { columns, state: Object.keys(state).length ? JSON.stringify(state) : null }
    }

    function insert(obj: AnyRow): void {
      if (info.store && typeof info.store.flush === 'function' && name === info.store.table) {
        // Store's own table: delegate so virtual child rows sync.
        info.store.flush(db, obj)
        return
      }
      const { columns, state } = encode(obj)
      if (state !== null) columns[info.columnByKey.state || 'state_json'] = state
      const names = Object.keys(columns)
      if (names.length === 0) return
      const sql =
        'INSERT INTO ' +
        name +
        ' (' +
        names.join(', ') +
        ') VALUES (' +
        names.map(() => '?').join(', ') +
        ')'
      db.prepare(sql).run(...names.map((n) => columns[n] as any))
    }

    return {
      name,
      rows,
      insert,
      insertMany(list) {
        for (const row of list) insert(row)
      },
      columns() {
        return Object.keys(info.columnByKey)
      },
      rename(to) {
        db.exec('ALTER TABLE ' + name + ' RENAME TO ' + ident(to, 'table'))
        return table(to)
      },
      drop() {
        db.exec('DROP TABLE ' + name)
      },
      sql(statement, ...params) {
        return db.prepare(statement).run(...(params as any[]))
      },
      get(statement, ...params) {
        return db.prepare(statement).get(...(params as any[]))
      },
    }
  }

  // Copy all rows from -> to through fn (default identity); returns the count.
  function copy(to: string, from: string, fn?: (row: AnyRow) => AnyRow): number {
    const source = table(from)
    const target = table(to)
    const list = source.rows()
    for (const row of list) target.insert(fn ? fn(row) : row)
    return list.length
  }

  return {
    copy,
    rename(from, to) {
      return table(from).rename(to)
    },
    drop(name) {
      table(name).drop()
    },
    storeFor,
    table,
  }
}
