import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'

export const PROMPT_BUDGET = 16
export const LIVE_LEDGER = 'work/agent-repair/20260930-go-acceptance/runs/acceptance-budget.ndjson'

export interface PromptInput { task?: string; [key: string]: unknown }
export interface ReservationOptions {
  runId: string
  caseId: string
  input: PromptInput
  // Optional redacted projection persisted in the ledger in place of `input`.
  // The reservation hash and prompt budget still key off the actual `input`.
  recordInput?: PromptInput
  maximum?: number
  now?: string
  reason?: string | null
  unexpected?: boolean
}

export function rows(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
}

export function usedSlots(path: string): number { return rows(path).filter((row) => row.type === 'RESERVE').length }

export function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[depth-limit]'
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') return value.replace(/(authorization\s*[:=]\s*|password\s*[:=]\s*|bearer\s+|(?:access|refresh)?token\s*[:=]\s*|api[-_]?key\s*[:=]\s*)[^\s,;]+/giu, '$1[redacted]').slice(0, 2000)
  if (Array.isArray(value)) return value.slice(0, 500).map((item) => sanitize(item, depth + 1))
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /pass|secret|token|key|authorization|credential|cookie/i.test(key) ? '[redacted]' : sanitize(item, depth + 1)]))
  }
  return '[unserializable]'
}

function sha256(value: string): string { return createHash('sha256').update(value).digest('hex') }

export function tryReserve(path: string, lockPath: string, options: ReservationOptions): { seq: number; reservedAt: string } {
  const { runId, caseId, input, recordInput, maximum = PROMPT_BUDGET, now = new Date().toISOString(), reason, unexpected } = options
  mkdirSync(dirname(path), { recursive: true })
  let fd: number
  try { fd = openSync(lockPath, 'wx') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Budget ledger is locked; no prompt was submitted.')
    throw error
  }
  try {
    const reservations = rows(path).filter((row) => row.type === 'RESERVE')
    if (reservations.length >= maximum) throw new Error(`Global prompt budget exhausted (${reservations.length}/${maximum}); no prompt was submitted.`)
    const seq = reservations.length + 1
    const record = { type: 'RESERVE', seq, runId, caseId, reservedAt: now, promptSHA256: sha256(input.task ?? ''), input: sanitize(recordInput ?? input), countsEvenIfFailedOrCanceled: true, ...(reason && { reason }), ...(unexpected && { unexpected: true }) }
    appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8')
    return { seq, reservedAt: now }
  } finally {
    closeSync(fd)
    try { unlinkSync(lockPath) } catch { /* lock may already be removed */ }
  }
}

export function appendCompletion(path: string, event: Record<string, unknown>): void {
  appendFileSync(path, `${JSON.stringify({ type: 'RESULT', ...(sanitize(event) as Record<string, unknown>) })}\n`, 'utf8')
}

export function recordUnexpectedSubmission(path: string, lockPath: string, runId: string, caseId: string, input: PromptInput): void {
  tryReserve(path, lockPath, { runId, caseId, input, maximum: Number.MAX_SAFE_INTEGER, reason: 'Unexpected SDK inbox submission; counted and acceptance must stop.', unexpected: true })
}
