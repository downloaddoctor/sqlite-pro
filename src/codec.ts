import type { Logger } from './types'

// context = 'table.column'. Corrupt JSON: log error, return fallback (next write overwrites). Non-string, empty and non-object/array values return the fallback silently.
export function parseBlob<T>(
  value: unknown,
  fallback: T,
  context = 'blob',
  logger: Pick<Logger, 'error'> = console,
): T {
  if (typeof value !== 'string' || value === '') return fallback
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch (caughtErr) {
    logger.error('parseBlob: corrupt JSON in ' + context + ': ' + (caughtErr as Error).message)
    return fallback
  }
}

// Only arrays and plain objects are proxied; Date/Buffer/Map/class instances pass through untouched.
export function isPlain(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  if (Array.isArray(value)) return true
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

// snake_case -> camelCase ('created_at' -> 'createdAt').
export const camel = (name: string): string =>
  name.replace(/_([a-z0-9])/g, (_m, ch) => ch.toUpperCase())
