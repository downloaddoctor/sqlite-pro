# PROJECT
sqlite-pro 0.1.0 — debounced write-through Proxy row store for node:sqlite
TypeScript sources in src/, esbuild bundles to dist/ (ESM + CJS), declarations emitted by tsc, zero runtime deps, Node >= 22.13, pnpm
MIT, built for ZeroKey

# DIRECTORY
src/ — TypeScript sources
dist/ — build output, gitignored: index.mjs + index.cjs bundles, index.d.ts + per-module .d.ts, version.txt (sourcemaps only via pnpm build:map)
scripts/ — build.mjs (esbuild bundles + tsc decl emit, --no-types skips, --sourcemap), release.mjs (pnpm release patch|minor|major), pack-check.mjs (npm pack --dry-run file-list gate), api-ref.mjs (generates docs/API.md from TS sources)
test/ — node:test suites *.test.js
bench/ — benchmark vs raw node:sqlite (insert/update/point-get/filter + 50k mixed stability); eslint-ignored
test-types/ — compile-time public API tests (@ts-expect-error), included by tsconfig.json
docs/ — generated API reference (docs/API.md); tracked, prettier-ignored
.githooks/ — pre-commit runs pnpm check; package.json postinstall sets core.hooksPath
.github/workflows/ — ci.yml publish.yml
CHANGELOG.md CONTRIBUTING.md README.md

# ENTRY-POINTS
src/index.ts — main; exports createStore createMigrator openDatabase createMigrationContext defineTable normalizeSchema isPlain parseBlob camel transaction
src/types.ts — public and internal types, re-exported by index.ts; node:sqlite DatabaseSync augmented with table() and transaction()
tsconfig.json — strict, noEmit typecheck of src + test-types; tsconfig.build.json — declaration emit to dist
npm scripts: build build:map typecheck lint format format:fix test (builds dist without types, then node --test with --experimental-test-coverage, lines >= 85) check (typecheck lint format test) bench docs pack-check postinstall prepublishOnly
docs script: run as pnpm run docs (plain pnpm docs is a pnpm built-in)
tests are plain JS in test/ and require ../dist/index.cjs

# MODULES
src/index.ts — createStore(cfg): column introspection, decode/encode, find/create/upsert/delete, flush, deepWrap Proxy, hooks, bind, diff, migrate; delete tombstones its key, create revives it; re-exports codec helpers and the other modules; wrapResults=false returns plain decoded rows; per-db prepared-statement cache cleared on define/migrate
src/codec.ts — parseBlob (corrupt JSON -> fallback + error log), isPlain, camel
src/query.ts — criteria (filter object -> WHERE + params, operators, IN/IS NULL), buildQuery (adds sort/limit/offset), OPERATORS
src/flush-scheduler.ts — createScheduler: pending map, debounce, retry up to MAX_FLUSH_ATTEMPTS=3, markDirty, cancel/cancelWhere (tombstone option), revive, flushAll fast path (one BEGIN, no per-row savepoints; falls back to per-row savepoints on any row failure, then to untransacted writes when BEGIN fails)
src/schema.ts — ident (SQL identifier guard: table/column/index names must match [A-Za-z_][A-Za-z0-9_]*), tableInfo, normalizeSchema (compact strings, Dexie index list), buildCreate, buildIndexes, addMissingColumns, diffTable, rebuildTable, defineTable, columnOf
src/table.ts — bindTable (Dexie facade: collection, where operators, bulk_, liveQuery), transaction (nested SAVEPOINT), attachHelpers (db.table, db.transaction)
src/virtual.ts — buildVirtual: derive owns/columns/hydrate/sync from schema.virtual (fields, extra json, children map rows)
src/migrate.ts — createMigrator (ladder, legacy, beforeDefine, prepare; steps without an upgrade callback are refused), openDatabase (PRAGMAs + open; closes the handle when prepare throws)
src/context.ts — createMigrationContext: table(name) rows/insert/rename/drop, copy, storeFor, hasTable, hasColumn
scripts/api-ref.mjs — reads src/types.ts + src/index.ts via TS compiler API, emits docs/API.md (type and member doc comments included)
eslint.config.js prettier: single quotes, no semis, width 100, LF

# ARCHITECTURE
src/index.ts → schema table virtual migrate context
src/migrate.ts → schema context table
src/context.ts → schema
src/virtual.ts → schema
src/table.ts talks to the typed InternalEngine<Row> object of createStore; public API object exposes only the PUBLIC list
deleteOne/deleteMany cancel + tombstone pending rows matching the filter (pendingMatch) so a ghost row never resurrects
First flush of a row = full INSERT ON CONFLICT; later flushes = narrow UPDATE of dirty columns
Narrow UPDATE matching no row or missing key column = permanent error, no retry
Other failures retry up to 3 times (MAX_FLUSH_ATTEMPTS)
flushAll = one BEGIN IMMEDIATE per db; fast path runs the whole batch with no savepoints, falling back to one SAVEPOINT zk_row per row on any failure, then to untransacted per-row writes when BEGIN fails
virtual sync runs in SAVEPOINT zk_sync
Unmapped keys fold into stateColumn (default state_json); _-prefixed keys are transient
migrator.prepare order: attachStores, FK OFF, assertSupported, legacy, meta table, beforeDefine steps, define, FK ON, ladder, schema_version

# SCHEMA
meta(key TEXT PRIMARY KEY, value TEXT) — holds schema_version
column types: text integer real boolean json (json → TEXT + _json suffix + json_valid CHECK)
rebuildTable needs PRAGMA foreign_keys = OFF

# ENV
node:sqlite DatabaseSync required
tsconfig: strict + noUncheckedIndexedAccess
CI: ubuntu,node 24, pnpm format typecheck lint test build pack-check docs (git diff --exit-code docs/API.md) audit --audit-level=high
publish: tag v* → npm publish with provenance; secret NPM_TOKEN
