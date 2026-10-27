/**
 * Table schema declaration (types in types.ts) and DDL helpers: normalizeSchema, buildCreate, buildIndexes, diffTable, rebuildTable, defineTable.
 *
 * schema:
 *   columns       { field: { type, column?, primary?, required?, default?, unique?, from?, references? } }
 *                 | { field: 'integer required =0' } compact strings: type, primary, required, unique, =default, <-old_column (rename), ->table.column:onDelete (foreign key)
 *                 | one Dexie list 'id, kind, &slug, n:integer'
 *   primaryKey    ['a', 'b'] | 'a+b'
 *   unique        [['a', 'b']] | ['a+b']
 *   indexes       [{ name, columns: ['field', '-other'] }] | ['a,-b'] | ['name: a,-b']  ('-' = DESC)
 *   withoutRowid  true
 *   autoMigrate   true: define() rebuilds on retype, rename (from) or drop
 *   children      [{ table, schema }] created with the parent
 *   virtual       { field: spec } column-less fields (virtual.ts)
 *
 * type: text | integer | real | boolean | json. Column = snake_case of the field
 * (json adds _json suffix and a json_valid CHECK) unless `column` overrides.
 * references: { table, column, onDelete? } adds a FOREIGN KEY.
 */

import type { DatabaseSync } from 'node:sqlite'
import type { ColumnDef, ColumnType, NormalizedSchema, Schema, SchemaDiff } from './types'

const TYPES: Record<ColumnType, string> = {
  text: 'TEXT',
  integer: 'INTEGER',
  real: 'REAL',
  boolean: 'INTEGER',
  json: 'TEXT',
}

interface StateOpts {
  stateColumn?: string | null
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Identifiers are concatenated into SQL: only [A-Za-z_][A-Za-z0-9_]* passes. */
export function ident(name: string, what = 'identifier'): string {
  if (typeof name !== 'string' || !IDENT.test(name)) {
    throw new Error('sqlite-pro: invalid ' + what + ': ' + String(name))
  }
  return name
}

const snake = (key: string): string => key.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())

export function columnOf(key: string, def: ColumnDef): string {
  return ident(def.column || (def.type === 'json' ? snake(key) + '_json' : snake(key)), 'column')
}

/** Rows of PRAGMA table_info(table). */
export function tableInfo(
  db: DatabaseSync,
  table: string,
): { name: string; type: string; pk: number }[] {
  return db.prepare('PRAGMA table_info(' + ident(table, 'table') + ')').all() as unknown as {
    name: string
    type: string
    pk: number
  }[]
}

const TYPE_NAMES = new Set(Object.keys(TYPES))

function parseDefault(text: string): string | number | boolean {
  if (text === 'true') return true
  if (text === 'false') return false
  if (text !== '' && !Number.isNaN(Number(text))) return Number(text)
  return text
}

// 'integer required =0'  'text primary'  'text required ->owners.id:cascade'
function parseColumn(key: string, text: string): ColumnDef {
  const def: ColumnDef = {}
  for (const token of text.trim().split(/\s+/)) {
    if (!token) continue
    if (TYPE_NAMES.has(token)) def.type = token as ColumnType
    else if (token === 'primary') def.primary = true
    else if (token === 'required') def.required = true
    else if (token === 'unique') def.unique = true
    else if (token.startsWith('<-')) def.from = token.slice(2)
    else if (token.startsWith('=')) def.default = parseDefault(token.slice(1))
    else if (token.startsWith('->')) {
      const [ref = '', action] = token.slice(2).split(':')
      const [table = '', column] = ref.split('.')
      const references: NonNullable<ColumnDef['references']> = { table, column: column || 'id' }
      if (action) references.onDelete = action as NonNullable<ColumnDef['references']>['onDelete']
      def.references = references
    } else {
      throw new Error('sqlite-pro schema: unknown token "' + token + '" for ' + key)
    }
  }
  return def
}

// Dexie list 'id, kind, &slug, n:integer': first = primary key, '&' = unique,
// 'name:type' (default text), other entries get an index. Leading '++' is ignored.
function parseStores(text: string): { columns: Record<string, ColumnDef>; indexes: string[] } {
  const columns: Record<string, ColumnDef> = {}
  const indexes: string[] = []
  text
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((raw, i) => {
      let token = raw.replace(/^\+\+/, '')
      const unique = token.startsWith('&')
      if (unique) token = token.slice(1)
      const [name = '', type] = token.split(':')
      const def: ColumnDef = { type: (type || 'text') as ColumnType }
      columns[name] = def
      if (i === 0) def.primary = true
      else if (unique) def.unique = true
      else indexes.push(name)
    })
  return { columns, indexes }
}

// Expand compact forms to object form (idempotent):
//   columns { id: 'text primary' }, primaryKey 'a+b', unique ['a+b'], indexes ['a,-b']
export function normalizeSchema(table: string, schema: Schema | NormalizedSchema): NormalizedSchema
export function normalizeSchema(table: string, schema: undefined): undefined
export function normalizeSchema(
  table: string,
  schema: Schema | NormalizedSchema | undefined,
): NormalizedSchema | undefined {
  if (!schema) return schema
  let columnsIn: Record<string, ColumnDef | string>
  let indexesIn: (string | { name: string; columns: string[] })[] = schema.indexes || []
  if (typeof schema.columns === 'string') {
    const parsed = parseStores(schema.columns)
    columnsIn = parsed.columns
    indexesIn = [...indexesIn, ...parsed.indexes]
  } else {
    columnsIn = schema.columns || {}
  }
  const columns: Record<string, ColumnDef> = {}
  for (const [key, def] of Object.entries(columnsIn)) {
    columns[key] = typeof def === 'string' ? parseColumn(key, def) : def
  }
  const out: NormalizedSchema = {
    columns,
    withoutRowid: schema.withoutRowid,
    autoMigrate: schema.autoMigrate,
    virtual: schema.virtual,
  }
  if (typeof schema.primaryKey === 'string') out.primaryKey = schema.primaryKey.split('+')
  else if (schema.primaryKey) out.primaryKey = schema.primaryKey
  if (schema.unique) {
    out.unique = schema.unique.map((group) =>
      typeof group === 'string' ? group.split('+') : group,
    )
  }
  if (indexesIn.length > 0) {
    out.indexes = indexesIn.map((entry) => {
      if (typeof entry !== 'string') return entry
      const named = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+)$/.exec(entry)
      const spec = (named ? named[2] : entry) as string
      return {
        name: (named
          ? named[1]
          : 'idx_' + table + '_' + spec.replace(/[^a-zA-Z0-9]+/g, '_')) as string,
        columns: spec.split(/[+,]/).map((part) => part.trim()),
      }
    })
  }
  if (schema.children) {
    out.children = schema.children.map((child) => ({
      table: child.table,
      schema: normalizeSchema(child.table, child.schema),
    }))
  }
  return out
}

function literal(value: string | number | boolean): string {
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? '1' : '0'
  return "'" + String(value).replace(/'/g, "''") + "'"
}

function jsonCheck(name: string): string {
  return 'CHECK (' + name + ' IS NULL OR json_valid(' + name + '))'
}

function columnSql(key: string, def: ColumnDef): string {
  const name = columnOf(key, def)
  const type = TYPES[def.type || 'text']
  if (!type) throw new Error('sqlite-pro schema: unknown type ' + def.type + ' for ' + key)
  let out = name + ' ' + type
  if (def.primary) out += ' PRIMARY KEY'
  if (def.required) out += ' NOT NULL'
  if (def.default !== undefined) out += ' DEFAULT ' + literal(def.default)
  if (def.unique) out += ' UNIQUE'
  if (def.type === 'json') out += ' ' + jsonCheck(name)
  return out
}

function resolver(table: string, schema: NormalizedSchema): (key: string) => string {
  return (key) => {
    const def = schema.columns[key]
    if (!def) throw new Error('sqlite-pro schema ' + table + ': unknown field ' + key)
    return columnOf(key, def)
  }
}

export function buildCreate(table: string, schema: NormalizedSchema, opts: StateOpts = {}): string {
  ident(table, 'table')
  const col = resolver(table, schema)
  const parts = Object.entries(schema.columns).map(([key, def]) => columnSql(key, def))
  if (opts.stateColumn) {
    ident(opts.stateColumn, 'state column')
    parts.push(opts.stateColumn + ' TEXT ' + jsonCheck(opts.stateColumn))
  }
  if (schema.primaryKey) parts.push('PRIMARY KEY (' + schema.primaryKey.map(col).join(', ') + ')')
  for (const group of schema.unique || []) parts.push('UNIQUE (' + group.map(col).join(', ') + ')')
  for (const [key, def] of Object.entries(schema.columns)) {
    if (!def.references) continue
    const ref = def.references
    let clause =
      'FOREIGN KEY (' +
      columnOf(key, def) +
      ') REFERENCES ' +
      ident(ref.table, 'table') +
      '(' +
      ident(ref.column, 'column') +
      ')'
    if (ref.onDelete) clause += ' ON DELETE ' + String(ref.onDelete).toUpperCase()
    parts.push(clause)
  }
  return (
    'CREATE TABLE IF NOT EXISTS ' +
    table +
    ' (\n  ' +
    parts.join(',\n  ') +
    '\n)' +
    (schema.withoutRowid ? ' WITHOUT ROWID' : '')
  )
}

export function buildIndexes(table: string, schema: NormalizedSchema): string[] {
  const col = resolver(table, schema)
  return (schema.indexes || []).map((index) => {
    const cols = index.columns.map((entry) =>
      entry.startsWith('-') ? col(entry.slice(1)) + ' DESC' : col(entry),
    )
    return (
      'CREATE INDEX IF NOT EXISTS ' +
      ident(index.name, 'index') +
      ' ON ' +
      table +
      '(' +
      cols.join(', ') +
      ')'
    )
  })
}

// Add missing declared columns (NOT NULL only with a default; never UNIQUE).
export function addMissingColumns(
  db: DatabaseSync,
  table: string,
  schema: NormalizedSchema,
  opts: StateOpts = {},
): void {
  const have = new Set(tableInfo(db, table).map((c) => c.name))
  for (const [key, def] of Object.entries(schema.columns)) {
    if (have.has(columnOf(key, def)) || def.primary) continue
    const relaxed: ColumnDef = {
      ...def,
      unique: false,
      required: Boolean(def.required) && def.default !== undefined,
    }
    db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + columnSql(key, relaxed))
  }
  if (opts.stateColumn && !have.has(opts.stateColumn)) {
    db.exec(
      'ALTER TABLE ' +
        table +
        ' ADD COLUMN ' +
        opts.stateColumn +
        ' TEXT ' +
        jsonCheck(opts.stateColumn),
    )
  }
}

// Declared schema vs live table; read-only. renamed = `from` columns still present.
export function diffTable(
  db: DatabaseSync,
  table: string,
  schema: Schema | NormalizedSchema,
  opts: StateOpts = {},
): SchemaDiff {
  const declared = normalizeSchema(table, schema)
  const have = new Map(tableInfo(db, table).map((c) => [c.name, c]))
  const want = new Map<string, string>()
  const renamed: { from: string; to: string }[] = []
  for (const [key, def] of Object.entries(declared.columns)) {
    const name = columnOf(key, def)
    want.set(name, TYPES[def.type || 'text'])
    if (def.from && have.has(def.from) && !have.has(name)) {
      renamed.push({ from: def.from, to: name })
    }
  }
  if (opts.stateColumn) want.set(opts.stateColumn, 'TEXT')
  const moved = new Set(renamed.map((r) => r.from))
  const arrived = new Set(renamed.map((r) => r.to))
  return {
    missing: [...want.keys()].filter((name) => !have.has(name) && !arrived.has(name)),
    extra: [...have.keys()].filter((name) => !want.has(name) && !moved.has(name)),
    retyped: [...want]
      .filter(
        ([name, type]) => have.has(name) && String(have.get(name)?.type).toUpperCase() !== type,
      )
      .map(([name, type]) => ({ column: name, from: String(have.get(name)?.type), to: type })),
    renamed,
  }
}

// Rebuild: temp table, copy shared/`from` columns, drop old, rename, re-index. Drops undeclared columns.
// Needs foreign_keys OFF (else DROP cascades into children).
export function rebuildTable(
  db: DatabaseSync,
  table: string,
  schema: Schema | NormalizedSchema,
  opts: StateOpts = {},
): void {
  ident(table, 'table')
  const fk = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }
  if (fk.foreign_keys) {
    throw new Error('sqlite-pro: rebuilding ' + table + ' needs PRAGMA foreign_keys = OFF')
  }
  const declared = normalizeSchema(table, schema)
  const have = new Set(tableInfo(db, table).map((c) => c.name))
  const pairs: [string, string | null | undefined][] = Object.entries(declared.columns).map(
    ([key, def]) => [columnOf(key, def), def.from],
  )
  if (opts.stateColumn) pairs.push([opts.stateColumn, null])
  const target: string[] = []
  const source: string[] = []
  for (const [name, from] of pairs) {
    const origin = have.has(name) ? name : from && have.has(from) ? from : null
    if (!origin) continue
    target.push(name)
    source.push(origin)
  }
  const tmp = table + '__rebuild'
  db.exec('SAVEPOINT zk_rebuild')
  try {
    db.exec('DROP TABLE IF EXISTS ' + tmp)
    db.exec(buildCreate(tmp, declared, opts))
    if (target.length > 0) {
      db.exec(
        'INSERT INTO ' +
          tmp +
          ' (' +
          target.join(', ') +
          ') SELECT ' +
          source.join(', ') +
          ' FROM ' +
          table,
      )
    }
    db.exec('DROP TABLE ' + table)
    db.exec('ALTER TABLE ' + tmp + ' RENAME TO ' + table)
    for (const statement of buildIndexes(table, declared)) db.exec(statement)
    db.exec('RELEASE zk_rebuild')
  } catch (error) {
    db.exec('ROLLBACK TO zk_rebuild')
    db.exec('RELEASE zk_rebuild')
    throw error
  }
}

// Create, then rebuild (autoMigrate + retype/rename/drop) or add missing columns; then indexes.
export function defineTable(
  db: DatabaseSync,
  table: string,
  schema: Schema | NormalizedSchema,
  opts: StateOpts = {},
): void {
  const declared = normalizeSchema(table, schema)
  db.exec(buildCreate(table, declared, opts))
  const plan = declared.autoMigrate ? diffTable(db, table, declared, opts) : null
  if (plan && plan.retyped.length + plan.extra.length + plan.renamed.length > 0) {
    rebuildTable(db, table, declared, opts)
  } else {
    addMissingColumns(db, table, declared, opts)
  }
  for (const statement of buildIndexes(table, declared)) db.exec(statement)
}
