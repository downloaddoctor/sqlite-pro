'use strict'

const { DatabaseSync } = require('node:sqlite')
const { createStore } = require('../dist/index.cjs')

const N = Number(process.env.BENCH_N || 20000)
const Q = Math.max(200, Math.floor(N / 10))
const KIND_COUNT = 5

function nowMs() {
  return Number(process.hrtime.bigint()) / 1e6
}

function createTable(db) {
  db.exec(
    'CREATE TABLE items (id TEXT PRIMARY KEY, kind TEXT NOT NULL, price REAL NOT NULL, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1)',
  )
  db.exec('CREATE INDEX IF NOT EXISTS idx_items_kind ON items(kind)')
}

function row(i) {
  return { id: 'i' + i, kind: 'kind' + (i % KIND_COUNT), price: i / 100, name: 'name' + i }
}

function seed(n) {
  const db = new DatabaseSync(':memory:')
  createTable(db)
  const stmt = db.prepare(
    'INSERT INTO items (id, kind, price, name, active) VALUES (?, ?, ?, ?, 1)',
  )
  db.exec('BEGIN IMMEDIATE')
  for (let i = 0; i < n; i++) {
    const r = row(i)
    stmt.run(r.id, r.kind, r.price, r.name)
  }
  db.exec('COMMIT')
  return db
}

function storeFor(db) {
  return createStore({
    table: 'items',
    conflict: ['id'],
    keyOf: (r) => r.id,
    flushMs: 60000,
    label: 'items',
    stateColumn: null,
  })
}

function runCase(name, fn) {
  fn(Math.min(2000, N)) // warmup
  const t0 = nowMs()
  const ops = fn(N)
  const dt = nowMs() - t0
  return { name, ops, ms: Math.round(dt * 10) / 10, rate: Math.round(ops / (dt / 1000)) }
}

const cases = []

cases.push(
  runCase('direct insert (tx)', (n) => {
    const db = new DatabaseSync(':memory:')
    createTable(db)
    const stmt = db.prepare(
      'INSERT INTO items (id, kind, price, name, active) VALUES (?, ?, ?, ?, 1)',
    )
    db.exec('BEGIN IMMEDIATE')
    for (let i = 0; i < n; i++) {
      const r = row(i)
      stmt.run(r.id, r.kind, r.price, r.name)
    }
    db.exec('COMMIT')
    return n
  }),
)

cases.push(
  runCase('proxy insert (add + flushAll)', (n) => {
    const db = new DatabaseSync(':memory:')
    createTable(db)
    const items = storeFor(db).bind(db)
    for (let i = 0; i < n; i++) items.add(row(i))
    items.flush()
    return n
  }),
)

cases.push(
  runCase('direct update (pk)', (n) => {
    const db = seed(n)
    const stmt = db.prepare('UPDATE items SET price = ? WHERE id = ?')
    for (let i = 0; i < n; i++) stmt.run(i / 200, 'i' + i)
    return n
  }),
)

cases.push(
  runCase('proxy update (narrow + flushAll)', (n) => {
    const db = seed(n)
    const items = storeFor(db).bind(db)
    for (let i = 0; i < n; i++) {
      const item = items.get('i' + i)
      if (item) item.price = i / 200
    }
    items.flush()
    return n
  }),
)

cases.push(
  runCase('direct get (pk)', (n) => {
    const db = seed(n)
    const stmt = db.prepare('SELECT * FROM items WHERE id = ?')
    for (let i = 0; i < n; i++) stmt.get('i' + i)
    return n
  }),
)

cases.push(
  runCase('proxy get (pk)', (n) => {
    const db = seed(n)
    const items = storeFor(db).bind(db)
    for (let i = 0; i < n; i++) items.get('i' + i)
    return n
  }),
)

cases.push(
  runCase('direct filter (kind)', () => {
    const db = seed(N)
    const stmt = db.prepare('SELECT * FROM items WHERE kind = ?')
    for (let q = 0; q < Q; q++) stmt.all('kind' + (q % KIND_COUNT))
    return Q
  }),
)

cases.push(
  runCase('proxy filter (kind)', () => {
    const db = seed(N)
    const items = storeFor(db).bind(db)
    for (let q = 0; q < Q; q++) items.where({ kind: 'kind' + (q % KIND_COUNT) }).toArray()
    return Q
  }),
)

console.log('\nbenchmark (BENCH_N=' + N + ', queries=' + Q + ')')
console.log('case'.padEnd(32) + 'ops'.padStart(8) + 'ms'.padStart(9) + 'ops/s'.padStart(12))
for (const c of cases) {
  console.log(
    c.name.padEnd(32) +
      String(c.ops).padStart(8) +
      String(c.ms).padStart(9) +
      String(c.rate).padStart(12),
  )
}

function stability() {
  // Starts empty: first 1000 iterations add rows, the rest update them.
  const db = new DatabaseSync(':memory:')
  createTable(db)
  const items = storeFor(db).bind(db)
  const total = 50000
  for (let i = 0; i < total; i++) {
    const id = 's' + (i % 1000)
    const item = items.get(id)
    if (!item) {
      items.add({ id, kind: 'kind' + (i % KIND_COUNT), price: i, name: 'n' + i })
      continue
    }
    item.price = i
    if (i % 1000 === 999) items.flush()
  }
  items.flush()
  const count = items.count()
  if (count !== 1000) throw new Error('stability: expected 1000 rows, got ' + count)
  console.log('stability: 50k mixed ops kept 1000 rows intact')
}

stability()
