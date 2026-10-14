import { resolve } from 'node:path'
import type { OpenCodeClient, OpenCodeEvent } from '@opencode/client'
import { safeCase3Events } from './case3-recheck.js'

export type ControlOptions = {
  sessionId: () => string | undefined
  workspace: string
  seeds: [string, string]
  marker: string
  deadline: () => number
  holdMs?: number
  audit: (record: Record<string, unknown>) => void
}
const audited = new Set(['permission.asked', 'permission.replied', 'session.inbox.enqueued', 'session.inbox.delivered', 'session.step.started', 'session.step.finished', 'session.idle',
  'session.execution.started', 'session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted'])

function rank(event: OpenCodeEvent, options: ControlOptions): number | undefined {
  if (event.type !== 'permission.asked' || event.data.sessionID !== options.sessionId()
    || !event.data.source?.messageID || !event.data.source.id) return undefined
  if (event.data.action === 'shell' && event.data.resources.some((resource) => resource.includes(options.marker))) return 0
  if (event.data.action === 'read' && event.data.resources.length === 1) {
    const target = resolve(options.workspace, event.data.resources[0]!)
    const index = options.seeds.findIndex((seed) => resolve(seed) === target)
    if (index >= 0) return index + 1
  }
  return undefined
}

/** Only reorders original target asks. Reading continues while asks are held. */
export async function* controlEventStream(source: AsyncIterable<OpenCodeEvent>, signal: AbortSignal, options: ControlOptions): AsyncGenerator<OpenCodeEvent> {
  const output: OpenCodeEvent[] = []
  const held: Array<{ event: OpenCodeEvent; rank: number }> = []
  let assistant: string | undefined
  let enabled = true
  let complete = false
  let error: unknown
  let wake: (() => void) | undefined
  let timer: NodeJS.Timeout | undefined
  let auditSequence = 0
  let receivedCount = 0
  let deliveredCount = 0
  const receivedIndices = new WeakMap<object, number>()
  const audit = (record: Record<string, unknown>) => {
    const sequence = ++auditSequence
    try { options.audit({ ...record, auditSequence: sequence }) } catch { /* A missing sequence invalidates proof without changing delivery or cleanup. */ }
  }
  const push = (event: OpenCodeEvent) => { output.push(event); wake?.() }
  const flush = (ordered: boolean, reason: string) => {
    if (timer) clearTimeout(timer)
    enabled = false
    if (ordered) held.sort((a, b) => a.rank - b.rank)
    audit({ kind: 'barrier', complete: ordered, reason, heldCount: held.length, assistantMessageID: assistant,
      requestIDs: held.map((row) => row.event.type === 'permission.asked' ? row.event.data.id : null) })
    for (const row of held.splice(0)) push(row.event)
  }
  const project = (event: OpenCodeEvent) => {
    const sessionId = 'data' in event ? (event.data as { sessionID?: string }).sessionID : undefined
    return sessionId === options.sessionId() && sessionId ? safeCase3Events([{ at: new Date().toISOString(), event }], sessionId)[0] : undefined
  }
  const onAbort = () => { if (timer) clearTimeout(timer); wake?.() }
  signal.addEventListener('abort', onAbort, { once: true })
  const pump = (async () => {
    try {
      for await (const event of source) {
        if (signal.aborted) break
        const projection = audited.has(event.type) ? project(event) : undefined
        if (projection) {
          const receiveIndex = ++receivedCount
          receivedIndices.set(event, receiveIndex)
          audit({ kind: 'raw', ...projection, receiveIndex })
        }
        const priority = enabled ? rank(event, options) : undefined
        const sourceId = event.type === 'permission.asked' ? event.data.source?.messageID : undefined
        if (priority !== undefined && (!assistant || sourceId === assistant) && !held.some((row) => row.rank === priority)) {
          assistant ??= sourceId
          held.push({ event, rank: priority })
          if (held.length === 1) timer = setTimeout(() => flush(false, 'target_group_timeout'), Math.max(0, Math.min(options.holdMs ?? 5_000, 5_000, options.deadline() - Date.now())))
          if (held.length === 3) flush(true, 'target_group_ready')
        } else push(event)
        if (output.length > 2048) throw new Error('controlled_event_buffer_limit')
      }
      if (!signal.aborted) { if (held.length) flush(false, 'raw_eof'); error = new Error('controlled_raw_eof') }
    } catch (cause) { error = cause; if (held.length && !signal.aborted) flush(false, 'raw_error') }
    finally { complete = true; wake?.() }
  })()
  try {
    while (!signal.aborted) {
      if (output.length) {
        const event = output.shift()!
        const projection = audited.has(event.type) ? project(event) : undefined
        if (projection) audit({ kind: 'delivered', ...projection, receiveIndex: receivedIndices.get(event), deliveryIndex: ++deliveredCount })
        yield event
      } else if (complete) { if (error) throw error; break }
      else await new Promise<void>((done) => { wake = done; if (signal.aborted || complete || output.length) done() })
    }
  } finally {
    if (timer) clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
    audit({ kind: 'end', reason: error ? 'raw_error' : signal.aborted ? 'canceled' : 'closed', receivedCount, deliveredCount, heldCount: held.length })
    // Never block cleanup on a source which ignores abort; the production deadline
    // owns final process exit. No new asks are delivered after cancellation.
    void pump.catch(() => undefined)
  }
}

/** SDK test factory only; forwarding keeps the original methods and decisions. */
export function controlledClient(raw: OpenCodeClient, options: Omit<ControlOptions, 'sessionId' | 'deadline'> & { timeoutMs: number }): OpenCodeClient {
  let targetSession: string | undefined
  let deadline = Date.now() + options.timeoutMs
  const control: ControlOptions = { ...options, sessionId: () => targetSession, deadline: () => deadline }
  const session = new Proxy(raw.session, { get(target, key) {
    const method = Reflect.get(target, key)
    if (key === 'create') return async (...args: Parameters<OpenCodeClient['session']['create']>) => {
      const result = await raw.session.create(...args)
      if (resolve(args[0]?.location?.directory ?? '') === resolve(options.workspace)) {
        if (targetSession) throw new Error('controlled_second_session')
        targetSession = result.id; deadline = Date.now() + options.timeoutMs
      }
      return result
    }
    return typeof method === 'function' ? method.bind(target) : method
  } })
  const event = { ...raw.event, subscribe: (args?: Parameters<OpenCodeClient['event']['subscribe']>[0]) => {
    if (!args?.signal) throw new Error('controlled_subscription_requires_signal')
    return controlEventStream(raw.event.subscribe(args), args.signal, control)
  } }
  return new Proxy(raw, { get(target, key) {
    if (key === 'session') return session
    if (key === 'event') return event
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } })
}
