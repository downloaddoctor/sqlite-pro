# Changelog

All notable changes are listed here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- Corrected source comments, type docs, CONTRIBUTING and workflow notes to match the code.
- `docs/API.md` now includes member-level doc comments.
- `OpenDatabaseMigrator` chain methods (`version`, `beforeDefine`, `upgrade`, `legacy`) return `OpenDatabaseMigrator`, so `.open()` stays reachable after chaining.

## [0.1.0]

- Initial release: debounced write-through Proxy row store for `node:sqlite`, Dexie-style table facade, virtual fields, SAVEPOINT transactions, versioned migrations.
