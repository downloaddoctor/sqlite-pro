# Sqlite Pro (Proxy debounced write-through row store for node:sqlite)

Debounced write-through Proxy row store for `node:sqlite`. Assigning a field on a row persists it as a narrow per-column `UPDATE` after a debounce window. Zero runtime dependencies, Node >= 22.13.

```js
const { createStore, openDatabase } = require('sqlite-pro')

const widgets = createStore({
  table: 'widgets',
  conflict: ['id'],
  keyOf: (row) => row.id,
  flushMs: 50,
  label: 'widgets',
  schema: {
    columns: {
      id: 'text primary',
      name: 'text',
      tags: 'json',
      createdAt: 'integer',
      updatedAt: 'integer required',
    },
  },
})

const db = openDatabase({ file: 'app.db', stores: [widgets] }).open()
const table = db.table('widgets')

const row = table.add({ id: 'a', name: 'x', tags: [] })
row.tags.push('hot') // marks `tags` dirty; written after flushMs
table.flush() // write all pending rows now
```

## Features

- Dexie-style table facade: `get`, `add`, `put`, `update`, `delete`, `where`, `orderBy`, `bulk*`, `liveQuery`.
- Recursive Proxy rows: nested edits dirty the root field.
- Virtual fields mapped to columns and child tables.
- Nestable `transaction()` (BEGIN IMMEDIATE, then SAVEPOINT).
- Versioned migrations with `createMigrator` and `openDatabase`.

See [docs/API.md](docs/API.md) for the generated API reference and [CONTRIBUTING.md](CONTRIBUTING.md) for development.

## License

MIT
