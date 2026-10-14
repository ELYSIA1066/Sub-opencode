import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { collectCase3Proof, safeCase3Events, inspectCase3SessionLog } from '../tools/acceptance/case3-recheck.js'
import { Schema } from 'effect'
import { SessionEvent } from '@opencode/schema/session-event'
import { OpenCode } from '@opencode/client'

function fixture(errorType = 'tool.execution') {
  const workspaceRoot = process.cwd(), task = 'original task', sessionId = 'ours'
  const tools = ['shell', 'read', 'read'].map((name, index) => ({ type: 'tool', id: `call-${index}`, name,
    state: { status: 'error', input: name === 'shell' ? { command: 'write marker.txt' } : { path: `seed-${index}.txt` }, error: { type: errorType } } }))
  const events: any[] = [
    { event: { type: 'session.inbox.enqueued', data: { sessionID: sessionId, inboxID: 'user', item: { payload: { text: task } } } } },
    { event: { type: 'session.inbox.delivered', data: { sessionID: sessionId, inboxID: 'user' } } },
    { event: { type: 'session.step.started', data: { sessionID: sessionId, assistantMessageID: 'assistant' } } },
    ...tools.map((tool, index) => ({ at: '2026-10-02T12:00:00.010Z', event: { type: 'permission.asked', data: { sessionID: sessionId, id: `request-${index}`, action: tool.name,
      resources: [], source: { messageID: 'assistant', id: tool.id } } } })),
    ...tools.map((_, index) => ({ at: '2026-10-02T12:00:00.030Z', event: { type: 'permission.replied', data: { sessionID: sessionId, requestID: `request-${index}`, reply: 'reject' } } })),
  ]
  const request = createHash('sha256').update('request-0').digest('hex').slice(0, 16)
  return { workspaceRoot, task, sessionId, events,
    messages: [{ type: 'assistant', id: 'assistant', content: tools }, { type: 'user', id: 'user', text: task }],
    sdk: { sdkPromptId: 'user', modelVerified: true, assistantModelsVerified: true, assistantMessages: [], messageCosts: [], permissionEvents: [], toolResults: [], denyAllVerified: true },
    diagnostics: [{ event: 'permission_reply_started', request, decision: 'reject', timestamp: '2026-10-02T12:00:00.020Z' },
      { event: 'permission_reply_completed', request, status: 'accepted' }],
    seedA: resolve(workspaceRoot, 'seed-1.txt'), seedB: resolve(workspaceRoot, 'seed-2.txt'), markerRelative: 'marker.txt' }
}
describe('real-shaped Case3 proof collection', () => {
  it('collects exactly one current execution and exposes missing, multiple and external interruptions', () => {
    const f = fixture('aborted')
    const lifecycle = (type: string, seq: number, reason?: string) => ({ event: { type, durable: { aggregateID: 'ours', seq, version: 1 }, data: { sessionID: 'ours', ...(reason && { reason }) } } })
    const start = lifecycle('session.execution.started', 1), terminal = lifecycle('session.execution.interrupted', 9, 'shutdown')
    f.events.unshift(start); f.events.push(terminal)
    const input = { ...f, serviceVersion: '2.0.18' }
    expect(collectCase3Proof(input).interruption).toMatchObject({ uniqueExecution: true, reason: 'shutdown', startedSequence: 1, terminalSequence: 9, localInterrupt: false })
    expect(collectCase3Proof({ ...input, events: [...f.events, lifecycle('session.execution.started', 10)] }).interruption.uniqueExecution).toBe(false)
    expect(collectCase3Proof({ ...input, events: f.events.slice(1) }).interruption.uniqueExecution).toBe(false)
    expect(collectCase3Proof({ ...input, events: [...f.events.slice(0, -1), lifecycle('session.execution.interrupted', 9)] }).interruption.reason).toBeNull()
    expect(collectCase3Proof({ ...input, events: [...f.events.slice(0, -1), lifecycle('session.execution.interrupted', 9, 'unrecognised-private-reason')] }).interruption.reason).toBe('unknown')
    const session = createHash('sha256').update('ours').digest('hex').slice(0, 16)
    expect(collectCase3Proof({ ...input, diagnostics: [...f.diagnostics, { event: 'session_interrupt_started', session, source: 'caller_cancel' }] }).interruption.localInterrupt).toBe(true)
    expect(collectCase3Proof({ ...input, diagnostics: [...f.diagnostics, { event: 'session_interrupt_started', session: 'other' }] }).interruption.localInterrupt).toBe(false)
  })
  it('projects a decoded official SDK interruption without leaking metadata', () => {
    const sessionID = 'ses_fixture'
    const event = Schema.decodeUnknownSync(SessionEvent.Execution.Interrupted)({ type: 'session.execution.interrupted', id: 'evt_fixture', created: 1,
      durable: { aggregateID: sessionID, seq: 24, version: 1 }, data: { sessionID, reason: 'shutdown' }, metadata: { secret: 'private' } })
    const projection = safeCase3Events([{ at: '', event: { type: 'other', data: { sessionID: 'ses_other' } } }, { at: 'now', event }], sessionID)
    expect(projection).toHaveLength(1)
    expect(projection[0]).toMatchObject({ receiveIndex: 2, sequence: 24, reason: 'shutdown' })
    expect(JSON.stringify(projection)).not.toContain('private')
    expect(safeCase3Events([{ at: '', event: { type: event.type, data: event.data } }], sessionID)[0]?.sequence).toBeNull()
  })
  it.each([true, false])('checks the actual SDK log request and decoder with execution records=%s', async (includeExecution) => {
    const sessionID = 'ses_fixture'
    const event = { type: 'session.execution.interrupted', durable: { aggregateID: sessionID, seq: 24, version: 1 }, data: { sessionID, reason: 'shutdown' } }
    const rows = [...(includeExecution ? [event] : []), { type: 'log.synced', aggregateID: sessionID, seq: 24 }]
    const requests: Array<{ method?: string; path: string; query: Record<string, string> }> = []
    const api = OpenCode.make({ baseUrl: 'http://127.0.0.1:1', fetch: async (input, init) => {
      const url = new URL(String(input)); requests.push({ method: init?.method, path: url.pathname, query: Object.fromEntries(url.searchParams) })
      return new Response(rows.map((row) => `data: ${JSON.stringify(row)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
    } })
    const decoded = []
    for await (const row of api.session.log({ sessionID, after: 0, follow: false })) decoded.push(row)
    expect(decoded).toEqual(rows)
    expect(requests).toEqual([{ method: 'GET', path: `/api/experimental/session/${sessionID}/log`, query: { after: '0', follow: 'false' } }])
    expect(inspectCase3SessionLog(decoded, sessionID)).toMatchObject({ status: includeExecution ? 'EXECUTION_EVENTS_AVAILABLE' : 'UNVERIFIED', watermark: 24 })
  })
  it('preserves generic tool error types and proves exact requests and pending reads', () => {
    const proof = collectCase3Proof(fixture())
    expect(proof.sdk.toolCalls).toHaveLength(3)
    expect(proof.sdk.toolCalls.every((call) => call.errorType === 'tool.execution' && call.asked && call.replied && call.sessionId === 'ours' && call.requestID)).toBe(true)
    expect(proof.diagnostics).toEqual({ bridgeReadAllowReply: false, pendingReadsAtShellReject: true })
  })
  it('cannot use another session reply or an unrelated tool source', () => {
    const f = fixture(); f.events.at(-1).event.data.sessionID = 'other'
    expect(collectCase3Proof(f).sdk.toolCalls.at(-1)?.replied).toBe(false)
    const g = fixture(); g.events[5].event.data.source.id = 'other-call'
    expect(collectCase3Proof(g).sdk.toolCalls.at(-1)?.asked).toBe(false)
  })
  it('rejects unknown tool error types and earlier terminal reads as cascade evidence', () => {
    const unknown = collectCase3Proof(fixture('unrelated'))
    expect(unknown.sdk.toolCalls.every((call) => call.errorType === 'unrelated')).toBe(true)
    expect(unknown.diagnostics.pendingReadsAtShellReject).toBe(true) // API lifecycle only, not tool-denial proof.
    const f = fixture(); f.events.at(-1).at = '2026-10-02T12:00:00.015Z'
    expect(collectCase3Proof(f).diagnostics.pendingReadsAtShellReject).toBe(false)
  })
})
