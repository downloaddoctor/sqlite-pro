import type { DatabaseSync } from 'node:sqlite'
import type { AnyRow, Logger } from './types'

const MAX_FLUSH_ATTEMPTS = 3

export interface Pending {
  timer: ReturnType<typeof setTimeout>
  db: DatabaseSync
  obj: AnyRow
  dirty: Set<string>
  attempts: number
}

export interface SchedulerDeps {
  label: string
  flushMs: number
  logger: Logger
  keyOf(obj: AnyRow): string
  /** Persist one row; dirty null = full write. May throw. */
  flush(db: DatabaseSync, obj: AnyRow, dirty: Set<string> | null): void
}

export interface Scheduler {
  pending: Map<string, Pending>
  schedule(db: DatabaseSync, obj: AnyRow, attempts?: number, dirty?: Set<string> | null): void
  markDirty(db: DatabaseSync, obj: AnyRow, camelKey: string): void
  /** Drop the pending write; tombstone also blocks later schedules for the key. */
  cancel(key: string, options?: { tombstone?: boolean }): void
  cancelWhere(predicate: (key: string) => boolean, options?: { tombstone?: boolean }): void
  /** Cancel + tombstone pending rows matching the predicate. */
  pendingMatch(predicate: (obj: AnyRow) => boolean): void
  flushAll(): void
  pendingCount(): number
  revive(key: string): void
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const { label, flushMs, logger, keyOf, flush } = deps
  const pending = new Map<string, Pending>()
  // Deleted keys: schedules dropped until revive(key).
  const tombstones = new Set<string>()

  function attemptFlush(
    db: DatabaseSync,
    obj: AnyRow,
    dirty: Set<string> | null,
    attempts: number,
  ): void {
    if (!db.isOpen) return
    try {
      flush(db, obj, dirty)
    } catch (error) {
      const failure = error as Error & { permanent?: boolean }
      if (!failure.permanent && attempts < MAX_FLUSH_ATTEMPTS) {
        logger.warn(
          label + ' flush failed (attempt ' + attempts + '), retrying: ' + failure.message,
        )
        schedule(db, obj, attempts + 1, dirty)
        return
      }
      logger.error(label + ' flush failed after ' + attempts + ' attempts: ', error)
    }
  }

  function schedule(
    db: DatabaseSync,
    obj: AnyRow,
    attempts = 0,
    dirty: Set<string> | null = null,
  ): void {
    const key = keyOf(obj)
    if (tombstones.has(key)) return
    const existing = pending.get(key)
    const merge = new Set<string>(existing ? existing.dirty : [])
    if (dirty) for (const k of dirty) merge.add(k)

    if (existing) clearTimeout(existing.timer)
    const timer = setTimeout(() => {
      pending.delete(key)
      attemptFlush(db, obj, merge, attempts)
    }, flushMs)
    if (typeof timer.unref === 'function') timer.unref()
    pending.set(key, { timer, db, obj, dirty: merge, attempts })
  }

  // Add a dirty key to the pending entry without re-arming its timer; schedule if none.
  function markDirty(db: DatabaseSync, obj: AnyRow, camelKey: string): void {
    const entry = pending.get(keyOf(obj))
    if (entry) {
      entry.dirty.add(camelKey)
      return
    }
    schedule(db, obj, 0, new Set([camelKey]))
  }

  function cancel(key: string, options: { tombstone?: boolean } = {}): void {
    if (options.tombstone) tombstones.add(key)
    const entry = pending.get(key)
    if (!entry) return
    clearTimeout(entry.timer)
    pending.delete(key)
  }

  function cancelWhere(
    predicate: (key: string) => boolean,
    options: { tombstone?: boolean } = {},
  ): void {
    for (const key of [...pending.keys()]) if (predicate(key)) cancel(key, options)
  }

  function pendingMatch(predicate: (obj: AnyRow) => boolean): void {
    for (const entry of pending.values()) {
      if (predicate(entry.obj)) cancel(keyOf(entry.obj), { tombstone: true })
    }
  }

  function revive(key: string): void {
    tombstones.delete(key)
  }

  // Drain all pending writes synchronously (shutdown), one transaction per db.
  // Fast path: no savepoints; on a row failure roll back and redo with a SAVEPOINT per row. If BEGIN fails, rows are written untransacted. Failed rows are logged and dropped (no retry).
  function flushAll(): void {
    const byDb = new Map<DatabaseSync, Pending[]>()
    for (const [key, entry] of [...pending]) {
      clearTimeout(entry.timer)
      pending.delete(key)
      if (!entry.db.isOpen) continue
      const list = byDb.get(entry.db)
      if (list) list.push(entry)
      else byDb.set(entry.db, [entry])
    }
    for (const [db, entries] of byDb) {
      let began = false
      try {
        db.exec('BEGIN IMMEDIATE')
        began = true
        let failed = false
        for (const entry of entries) {
          try {
            flush(db, entry.obj, entry.dirty)
          } catch (rowError) {
            logger.error(label + ' flushAll row failed: ', rowError)
            failed = true
            break
          }
        }
        if (failed) {
          // Roll back, redo with a savepoint per row so healthy rows commit.
          db.exec('ROLLBACK')
          began = false
          db.exec('BEGIN IMMEDIATE')
          began = true
          for (const entry of entries) {
            db.exec('SAVEPOINT zk_row')
            try {
              flush(db, entry.obj, entry.dirty)
              db.exec('RELEASE zk_row')
            } catch (rowError) {
              db.exec('ROLLBACK TO zk_row')
              db.exec('RELEASE zk_row')
              logger.error(label + ' flushAll row failed: ', rowError)
            }
          }
        }
        db.exec('COMMIT')
      } catch (error) {
        if (began) {
          try {
            db.exec('ROLLBACK')
          } catch (rollbackErr) {
            logger.error(label + ' flushAll rollback failed: ', rollbackErr)
          }
          logger.error(label + ' flushAll failed: ', error)
        } else {
          // BEGIN failed (likely a lock): write rows untransacted rather than drop the batch.
          logger.warn(
            label +
              ' flushAll BEGIN failed, writing rows untransacted: ' +
              (error as Error).message,
          )
          for (const entry of entries) {
            try {
              flush(db, entry.obj, entry.dirty)
            } catch (rowError) {
              logger.error(label + ' flushAll row failed: ', rowError)
            }
          }
        }
      }
    }
  }

  function pendingCount(): number {
    return pending.size
  }

  return {
    pending,
    schedule,
    markDirty,
    cancel,
    cancelWhere,
    pendingMatch,
    flushAll,
    pendingCount,
    revive,
  }
}
