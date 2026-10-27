/**
 * Declarative virtual fields: schema.virtual derives owns/columns/hydrate/sync.
 *
 *   virtual: {
 *     capture: {
 *       fields: { url: 'captureUrl', body: 'captureBody' },   // object key -> declared column field
 *       extra: 'captureExtra',                                 // optional json column for all other keys
 *       children: {                                            // object key -> { key: value } map as child rows
 *         headers: { table: 'widget_headers', parent: 'widgetId', key: 'name', value: 'value', order: 'pos' },
 *       },
 *     },
 *   }
 *
 * Parent key = first conflict column. children names fields of the matching
 * schema.children table; optional `order` preserves map key order.
 */

import type { DatabaseSync } from 'node:sqlite'
import { columnOf } from './schema'
import type {
  AnyRow,
  ColumnDef,
  Logger,
  NormalizedSchema,
  VirtualField,
  VirtualSpec,
} from './types'

const CHUNK = 500

interface ChildLink {
  prop: string
  table: string
  parent: string
  key: string
  value: string
  order: string | null
}

function parseJson(text: string, context: string, logger: Logger): unknown {
  try {
    return JSON.parse(text)
  } catch (caughtErr) {
    logger.error('sqlite-pro: corrupt JSON in ' + context + ': ' + (caughtErr as Error).message)
    return undefined
  }
}

function encode(def: ColumnDef, value: unknown): unknown {
  if (value === undefined) return null
  if (def.type === 'json') return JSON.stringify(value)
  if (def.type === 'text') return typeof value === 'string' ? value : null
  if (typeof value === 'boolean') return value ? 1 : 0
  return value
}

function columnFor(table: string, columns: Record<string, ColumnDef>, field: string): string {
  const def = columns[field]
  if (!def) throw new Error('sqlite-pro virtual ' + table + ': unknown field ' + field)
  return columnOf(field, def)
}

function loadChildren(
  db: DatabaseSync,
  child: ChildLink,
  ids: unknown[],
): Map<unknown, { p: unknown; k: string; v: string }[]> {
  const byParent = new Map<unknown, { p: unknown; k: string; v: string }[]>()
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK)
    const rows = db
      .prepare(
        'SELECT ' +
          child.parent +
          ' AS p, ' +
          child.key +
          ' AS k, ' +
          child.value +
          ' AS v FROM ' +
          child.table +
          ' WHERE ' +
          child.parent +
          ' IN (' +
          slice.map(() => '?').join(', ') +
          ') ORDER BY ' +
          child.parent +
          ', ' +
          (child.order || child.key),
      )
      .all(...(slice as any[])) as unknown as { p: unknown; k: string; v: string }[]
    for (const row of rows) {
      const list = byParent.get(row.p)
      if (list) list.push(row)
      else byParent.set(row.p, [row])
    }
  }
  return byParent
}

function buildOne(
  table: string,
  schema: NormalizedSchema,
  conflict: string[],
  name: string,
  spec: VirtualSpec,
  logger: Logger,
): Required<Pick<VirtualField, 'owns' | 'columns' | 'hydrate' | 'sync'>> {
  const parentKey = Object.keys(schema.columns).find((key) => {
    const def = schema.columns[key]
    return def ? columnOf(key, def) === conflict[0] : false
  })
  if (!parentKey) throw new Error('sqlite-pro virtual ' + table + ': conflict column not declared')
  const fields = Object.entries(spec.fields || {}).map(([prop, field]) => ({
    prop,
    def: schema.columns[field],
    column: columnFor(table, schema.columns, field),
  }))
  const extra = spec.extra ? columnFor(table, schema.columns, spec.extra) : null
  const children: ChildLink[] = Object.entries(spec.children || {}).map(([prop, link]) => {
    const child = (schema.children || []).find((entry) => entry.table === link.table)
    if (!child) throw new Error('sqlite-pro virtual ' + table + ': unknown child ' + link.table)
    const col = (field: string) => columnFor(link.table, child.schema.columns, field)
    return {
      prop,
      table: link.table,
      parent: col(link.parent),
      key: col(link.key),
      value: col(link.value),
      order: link.order ? col(link.order) : null,
    }
  })
  const known = new Set([...fields.map((f) => f.prop), ...children.map((c) => c.prop)])

  function columns(value: any): Record<string, unknown> {
    const source: AnyRow = value && typeof value === 'object' ? value : {}
    const out: Record<string, unknown> = {}
    for (const field of fields) {
      if (field.def) out[field.column] = encode(field.def, source[field.prop])
    }
    if (extra) {
      const rest: AnyRow = {}
      for (const [key, entry] of Object.entries(source)) {
        if (!known.has(key) && entry !== undefined) rest[key] = entry
      }
      out[extra] = Object.keys(rest).length === 0 ? null : JSON.stringify(rest)
    }
    return out
  }

  function hydrate(db: DatabaseSync, pairs: { row: AnyRow; obj: AnyRow }[]): void {
    if (pairs.length === 0) return
    const parentColumn = conflict[0] as string
    const ids = pairs.map(({ row }) => row[parentColumn])
    const loaded = children.map((child) => loadChildren(db, child, ids))
    for (const { row, obj } of pairs) {
      const value: AnyRow = {}
      for (const field of fields) {
        const raw = row[field.column]
        if (raw === null || raw === undefined) continue
        if (field.def?.type === 'json') {
          const parsed = parseJson(raw, table + '.' + field.column, logger)
          if (parsed !== undefined) value[field.prop] = parsed
        } else {
          value[field.prop] = raw
        }
      }
      children.forEach((child, i) => {
        const rows = loaded[i]?.get(row[parentColumn]) || []
        value[child.prop] = Object.fromEntries(rows.map((r) => [r.k, r.v]))
      })
      if (extra && typeof row[extra] === 'string') {
        const parsed = parseJson(row[extra], table + '.' + extra, logger)
        if (parsed && typeof parsed === 'object') Object.assign(value, parsed)
      }
      obj[name] = value
    }
  }

  // Align child rows with the object's map (upsert new/changed, delete removed); runs in the store's savepoint.
  function sync(db: DatabaseSync, raw: AnyRow): void {
    const source = raw[name]
    const parent = raw[parentKey as string]
    for (const child of children) {
      const entry = source && source[child.prop]
      const map: AnyRow = entry && typeof entry === 'object' ? entry : {}
      const wanted: [string, string][] = []
      for (const [key, value] of Object.entries(map)) {
        if (value === undefined || value === null) continue
        wanted.push([key, String(value)])
      }
      const existing = db
        .prepare(
          'SELECT ' +
            child.key +
            ' AS k, ' +
            child.value +
            ' AS v' +
            (child.order ? ', ' + child.order + ' AS o' : '') +
            ' FROM ' +
            child.table +
            ' WHERE ' +
            child.parent +
            ' = ?',
        )
        .all(parent) as unknown as { k: string; v: string; o?: number }[]
      const have = new Map(existing.map((row) => [row.k, row]))
      const names = [child.parent, child.key, child.value]
      if (child.order) names.push(child.order)
      const upsert = db.prepare(
        'INSERT INTO ' +
          child.table +
          ' (' +
          names.join(', ') +
          ') VALUES (' +
          names.map(() => '?').join(', ') +
          ') ON CONFLICT(' +
          child.parent +
          ', ' +
          child.key +
          ') DO UPDATE SET ' +
          child.value +
          ' = excluded.' +
          child.value +
          (child.order ? ', ' + child.order + ' = excluded.' + child.order : ''),
      )
      wanted.forEach(([key, value], pos) => {
        const current = have.get(key)
        have.delete(key)
        if (current && current.v === value && (!child.order || current.o === pos)) return
        upsert.run(...(child.order ? [parent, key, value, pos] : [parent, key, value]))
      })
      const remove = db.prepare(
        'DELETE FROM ' + child.table + ' WHERE ' + child.parent + ' = ? AND ' + child.key + ' = ?',
      )
      for (const key of have.keys()) remove.run(parent, key)
    }
  }

  const owns = [...fields.map((f) => f.column)]
  if (extra) owns.push(extra)
  return { owns, columns, hydrate, sync }
}

export function buildVirtual(
  table: string,
  schema: NormalizedSchema | undefined,
  conflict: string[],
  logger: Logger,
): Record<string, VirtualField> {
  const out: Record<string, VirtualField> = {}
  if (!schema || !schema.virtual) return out
  for (const [name, spec] of Object.entries(schema.virtual)) {
    out[name] = buildOne(table, schema, conflict, name, spec, logger)
  }
  return out
}
