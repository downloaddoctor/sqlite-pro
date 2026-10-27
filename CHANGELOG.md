# Changelog

All notable changes are listed here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.1.2] - 2026-10-27

### Fixed

- Reads inside the debounce window now return the live pending row, so a second read-modify-write before the flush no longer overwrites the first (whole-object reassigns of virtual fields were reverted).

## [0.1.1] - 2026-10-27

### Added

- `ctx.hasTable(name)` and `ctx.hasColumn(table, column)` on the migration context, so upgrade callbacks can probe the live schema without hand-written SQL.

### Changed

- Corrected source comments, type docs, CONTRIBUTING and workflow notes to match the code.
- `docs/API.md` now includes member-level doc comments.
- `OpenDatabaseMigrator` chain methods (`version`, `beforeDefine`, `upgrade`, `legacy`) return `OpenDatabaseMigrator`, so `.open()` stays reachable after chaining.

## [0.1.0]

- Initial release: debounced write-through Proxy row store for `node:sqlite`, Dexie-style table facade, virtual fields, SAVEPOINT transactions, versioned migrations.
