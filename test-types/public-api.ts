import type { DatabaseSync } from 'node:sqlite'
import { createMigrator, createStore, openDatabase } from '../src/index'
import type { Store, Table } from '../src/index'

interface Widget {
  id: string
  name?: string
}

declare const db: DatabaseSync

export const store: Store<Widget> = createStore<Widget>({
  table: 'widgets',
  conflict: ['id'],
  keyOf: (row) => row.id,
  flushMs: 10,
  label: 'widgets',
})

export const widgets: Table<Widget> = store.bind(db)
export const added: Widget = widgets.add({ id: 'a' })
export const found: Widget | null = widgets.get('a')
export const names: string[] = widgets.toArray().map((row) => row.id)
export const live = widgets.liveQuery((t) => t.count()).subscribe((n: number) => n)

// @ts-expect-error id must be a string
widgets.add({ id: 1 })

// @ts-expect-error unknown hook name
store.on('nope', () => {})

// @ts-expect-error missing required options
createStore({ table: 'widgets' })

createStore<Widget>({
  table: 'w',
  conflict: ['id'],
  keyOf: (row) => row.id,
  flushMs: 1,
  label: 'w',
  wrapResults: false,
})

export const migrator = createMigrator({ baseline: 1 })
  .version(2, 'two')
  .upgrade((handle, ctx) => {
    ctx.table('widgets').rows()
    handle.exec('SELECT 1')
  })

// @ts-expect-error version needs a number
migrator.version('2')

export const opened: DatabaseSync = openDatabase({ file: 'x.db', stores: [store] }).open()
export const cached: Table<any> = opened.table('widgets')
export const result: number = opened.transaction(() => 1)
