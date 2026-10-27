import type { DatabaseSync } from 'node:sqlite'
import type { AnyRow } from './types'

// Filter operators, e.g. { age: { above: 18 } }; between takes [lo, hi], noneOf takes an array, startsWith takes a prefix (LIKE with %, _ escaped).
const OPERATORS: Record<string, string> = {
  above: '>',
  aboveOrEqual: '>=',
  below: '<',
  belowOrEqual: '<=',
  notEqual: '<>',
  between: 'BETWEEN',
  startsWith: 'LIKE',
  noneOf: 'NOT IN',
}

export const isOperator = (value: unknown): boolean =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  !(value instanceof Date) &&
  Object.keys(value).length > 0 &&
  Object.keys(value).every((k) => k in OPERATORS)

export interface QueryDeps {
  label: string
  columnOf(key: string): string | undefined
  encodeValue(key: string, value: unknown): unknown
}

// { field: value } -> WHERE (null -> IS NULL, array -> IN, operator object). Unknown fields throw.
export function criteria(
  deps: QueryDeps,
  filter: AnyRow | undefined,
): { where: string; params: any[] } {
  const parts: string[] = []
  const params: any[] = []
  for (const [key, value] of Object.entries(filter || {})) {
    const column = deps.columnOf(key)
    if (!column) throw new Error(deps.label + ': unknown field in filter: ' + key)
    if (isOperator(value)) {
      for (const [op, operand] of Object.entries(value as AnyRow)) {
        const sqlOp = OPERATORS[op]
        if (!sqlOp) throw new Error(deps.label + ': unknown operator in filter: ' + op)
        if (op === 'noneOf') {
          if (operand.length === 0) continue
          parts.push(column + ' NOT IN (' + operand.map(() => '?').join(', ') + ')')
          for (const item of operand) params.push(deps.encodeValue(key, item))
        } else if (op === 'between') {
          parts.push(column + ' BETWEEN ? AND ?')
          params.push(deps.encodeValue(key, operand[0]), deps.encodeValue(key, operand[1]))
        } else if (op === 'startsWith') {
          parts.push(column + " LIKE ? ESCAPE '!'")
          params.push(String(operand).replace(/[!%_]/g, (c) => '!' + c) + '%')
        } else {
          parts.push(column + ' ' + sqlOp + ' ?')
          params.push(deps.encodeValue(key, operand))
        }
      }
    } else if (value === null || value === undefined) {
      parts.push(column + ' IS NULL')
    } else if (Array.isArray(value)) {
      if (value.length === 0) {
        parts.push('0')
        continue
      }
      parts.push(column + ' IN (' + value.map(() => '?').join(', ') + ')')
      for (const item of value) params.push(deps.encodeValue(key, item))
    } else {
      parts.push(column + ' = ?')
      params.push(deps.encodeValue(key, value))
    }
  }
  return { where: parts.length > 0 ? 'WHERE ' + parts.join(' AND ') : '', params }
}

// filter = raw SQL tail (+ params) or filter object (+ { sort, limit, offset }).
export function buildQuery(
  deps: QueryDeps,
  filter: AnyRow | string,
  extra?: AnyRow | any[],
): { tail: string; params: any[] } {
  if (typeof filter === 'string') {
    return { tail: filter, params: Array.isArray(extra) ? extra : [] }
  }
  const { where, params } = criteria(deps, filter)
  const opts: AnyRow = extra && !Array.isArray(extra) ? extra : {}
  const order = Object.entries<number>(opts.sort || {}).map(([key, dir]) => {
    const column = deps.columnOf(key)
    if (!column) throw new Error(deps.label + ': unknown field in sort: ' + key)
    return column + (dir < 0 ? ' DESC' : ' ASC')
  })
  let tail = where
  if (order.length > 0) tail += ' ORDER BY ' + order.join(', ')
  if (opts.limit || opts.offset) {
    tail += ' LIMIT ?'
    params.push(opts.limit ? Number(opts.limit) : -1)
    if (opts.offset) {
      tail += ' OFFSET ?'
      params.push(Number(opts.offset))
    }
  }
  return { tail: tail.trim(), params }
}

export { OPERATORS }
export type { DatabaseSync }
