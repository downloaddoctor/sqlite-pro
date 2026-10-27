/**
 * Dexie-style facade over a store, bound to one db:
 *
 *   const widgets = store.bind(db)
 *   widgets.add({ id: 'a' })                    // INSERT ... ON CONFLICT: an existing key is overwritten, not rejected
 *   widgets.get('a')                            // by primary key (composite: get(a, b))
 *   widgets.put({ id: 'a', name: 'x' })         // upsert by primary key
 *   widgets.update('a', { name: 'y' })          // patch by key
 *   widgets.delete('a')
 *   widgets.where('kind').equals('x').toArray()
 *   widgets.where({ kind: 'x', vip: true }).first()
 *   widgets.orderBy('updatedAt').reverse().limit(10).toArray()
 *   widgets.where('kind').anyOf(['x', 'y']).modify({ vip: true })
 *   widgets.bulkAdd([...]) / bulkPut([...]) / bulkDelete([...]) / clear()
 *   widgets.liveQuery((t) => t.count()).subscribe(cb)   // re-runs after create/delete
 *
 * Methods forward to the store (debounced writes, narrow UPDATEs, virtual fields).
 * Rows are live proxies: assigning a field persists it; save(doc) writes now;
 * pending() counts unflushed rows.
 */

import type { DatabaseSync } from 'node:sqlite'
import type {
  AnyRow,
  Collection,
  Filter,
  HookName,
  InternalEngine,
  StoreLike,
  Table,
} from './types'

interface QueryOpts {
  limit?: number
  offset?: number
  sort?: Record<string, number>
}

const isFilter = (value: unknown): value is Filter =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function collection(
  store: InternalEngine,
  db: DatabaseSync,
  filter: Filter,
  opts: QueryOpts = {},
): Collection<any> {
  const next = (extra: QueryOpts) => collection(store, db, filter, { ...opts, ...extra })
  return {
    limit: (n) => next({ limit: n }),
    offset: (n) => next({ offset: n }),
    each: (fn) => store.find(db, filter, opts).forEach(fn),
    primaryKeys: () =>
      store.find(db, filter, opts).map((row: AnyRow) => Object.values(store.keyFilterOf(db, row))),
    sortBy: (field) => next({ sort: { [field]: 1 } }).toArray(),
    orderBy: (field) => next({ sort: { ...(opts.sort || {}), [field]: 1 } }),
    reverse: () =>
      next({
        sort: Object.fromEntries(Object.entries(opts.sort || {}).map(([k, dir]) => [k, -dir])),
      }),
    toArray: () => store.find(db, filter, opts),
    first: () => store.find(db, filter, { ...opts, limit: 1 })[0] || null,
    count: () => store.count(db, filter),
    delete: () => store.deleteMany(db, filter),
    modify(change) {
      const rows = store.find(db, filter, opts)
      for (const row of rows) {
        const raw = row.__raw || row
        Object.defineProperty(raw, '__persisted', {
          value: true,
          enumerable: false,
          writable: true,
        })
        const live = row.__raw ? row : store.wrap(db, raw)
        if (typeof change === 'function') change(live)
        else Object.assign(live, change)
      }
      return rows.length
    },
  }
}

export function bindTable(store: InternalEngine, db: DatabaseSync): Table<any> {
  const filterOf = (key: unknown[]): Filter =>
    isFilter(key[0]) ? key[0] : store.keyFilter(db, ...key)
  const table: AnyRow = {
    name: store.table,
    store,
    get: (...key: unknown[]) =>
      isFilter(key[0]) ? store.findOne(db, key[0]) : store.findById(db, ...key),
    add: (doc: AnyRow) => store.create(db, doc),
    put: (doc: AnyRow) => store.upsert(db, store.keyFilterOf(db, doc), doc),
    update(key: unknown, patch: AnyRow) {
      return store.updateOne(db, filterOf([key].flat()), patch)
    },
    delete: (...key: unknown[]) => store.deleteOne(db, filterOf(key)),
    where(arg: string | Filter) {
      if (typeof arg !== 'string') return collection(store, db, arg || {})
      return {
        equals: (value: unknown) => collection(store, db, { [arg]: value }),
        anyOf: (list: unknown[]) => collection(store, db, { [arg]: list }),
        noneOf: (list: unknown[]) => collection(store, db, { [arg]: { noneOf: list } }),
        notEqual: (value: unknown) => collection(store, db, { [arg]: { notEqual: value } }),
        above: (value: unknown) => collection(store, db, { [arg]: { above: value } }),
        aboveOrEqual: (value: unknown) => collection(store, db, { [arg]: { aboveOrEqual: value } }),
        below: (value: unknown) => collection(store, db, { [arg]: { below: value } }),
        belowOrEqual: (value: unknown) => collection(store, db, { [arg]: { belowOrEqual: value } }),
        between: (low: unknown, high: unknown) =>
          collection(store, db, { [arg]: { between: [low, high] } }),
        startsWith: (prefix: string) => collection(store, db, { [arg]: { startsWith: prefix } }),
        isNull: () => collection(store, db, { [arg]: null }),
      }
    },
    toArray: () => store.find(db, {}),
    count: () => store.count(db),
    first: () => store.find(db, {}, { limit: 1 })[0] || null,
    orderBy: (field: string) => collection(store, db, {}, { sort: { [field]: 1 } }),
    limit: (n: number) => collection(store, db, {}, { limit: n }),
    bulkAdd: (docs: AnyRow[]) => transaction(db, () => docs.map((doc) => store.create(db, doc))),
    bulkPut: (docs: AnyRow[]) => transaction(db, () => docs.map((doc) => table.put(doc))),
    bulkDelete: (keys: unknown[]) =>
      transaction(db, () => keys.reduce<number>((n, key) => n + table.delete(...[key].flat()), 0)),
    clear: () => store.deleteMany(db, {}),
    save: (doc: AnyRow) => store.flushNow(db, doc),
    flush: () => store.flushAll(),
    pending: () => store.pendingCount(),
    hook: (name: HookName, fn: (...args: any[]) => void) => store.on(name, fn),
    diff: () => store.diff(db),
    migrate: () => store.migrate(db),
    // liveQuery(fn).subscribe(cb): cb(fn(table)) now and after each create/delete (not field edits); returns unsubscribe.
    liveQuery: (fn: (t: Table<any>) => unknown) => ({
      subscribe(cb: (value: unknown) => void) {
        const run = () => cb(fn(table as Table<any>))
        const off = store.onChange(run)
        run()
        return off
      },
    }),
  }
  return table as Table<any>
}

const depths = new WeakMap<DatabaseSync, number>()

// Nestable sync transaction: outer = BEGIN IMMEDIATE/COMMIT, inner = SAVEPOINT.
// add/delete join it; field edits, update() and put() on an existing row are debounced, so call save(doc) inside.
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  const depth = depths.get(db) || 0
  const name = 'zk_tx' + depth
  db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : 'SAVEPOINT ' + name)
  depths.set(db, depth + 1)
  try {
    const result = fn()
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      throw new Error('sqlite-pro: transaction callback must be synchronous')
    }
    db.exec(depth === 0 ? 'COMMIT' : 'RELEASE ' + name)
    return result
  } catch (error) {
    if (depth === 0) db.exec('ROLLBACK')
    else db.exec('ROLLBACK TO ' + name + '; RELEASE ' + name)
    throw error
  } finally {
    depths.set(db, depth)
  }
}

export function attachHelpers(db: DatabaseSync, stores: StoreLike[]): void {
  const bound = new Map<string, Table<any>>()
  db.table = (name: string) => {
    let table = bound.get(name)
    if (!table) {
      const store = stores.find((entry) => entry.table === name)
      if (!store || !store.bind) throw new Error('sqlite-pro: no store for table ' + name)
      table = store.bind(db)
      bound.set(name, table)
    }
    return table
  }
  db.transaction = (fn) => transaction(db, fn)
}
