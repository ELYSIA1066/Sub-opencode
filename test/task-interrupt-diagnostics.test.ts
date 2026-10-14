import { createHash } from 'node:crypto'
import type { OpenCodeClient } from '@opencode/client'
import { expect, it, vi } from 'vitest'
import { cleanupTask, type InterruptSource } from '../src/task-cleanup.js'

function fixture(source: InterruptSource, options: { hang?: boolean; logThrows?: boolean; aborted?: boolean } = {}) {
  const diagnostics: Record<string, unknown>[] = []
  const api = { session: { interrupt: vi.fn(async () => options.hang ? new Promise<never>(() => {}) : { interrupted: true }), wait: vi.fn(async () => ({})) } }
  const revoke = vi.fn(async () => true), quarantine = vi.fn(() => true), release = vi.fn(() => true)
  const deadline = Date.now() + (options.hang ? 400 : 1000)
  return { diagnostics, api, revoke, quarantine, release,
    run: () => cleanupTask({ api: api as unknown as OpenCodeClient, sessionId: 'ses_fixture', sessionCreateStarted: true,
      taskAborted: options.aborted ?? true, interruptSource: source, forceQuarantine: false, contextId: 'context', leaseToken: 'token',
      shutdownRequested: () => false, cleanupControllers: new Set(), inFlight: new Set(), eventPump: undefined,
      shutdownSignal: new AbortController().signal, deadline: () => deadline, releaseLease: release, quarantine,
      onShutdownFailure: () => {}, onDiagnostic: (event, errorType, fields) => { if (options.logThrows) throw new Error('broken logger'); diagnostics.push({ event, errorType, ...fields }) },
      revokeAndVerify: revoke }) }
}

it.each(['caller_cancel', 'task_timeout', 'mcp_shutdown', 'event_stream_failure', 'permission_reply_failure', 'unknown'] as const)('records actual bounded interruption with source %s', async (source) => {
  const f = fixture(source)
  expect(await f.run()).toMatchObject({ idleVerified: true, denyAllVerified: true, leaseReleased: true, errors: [] })
  expect(f.api.session.interrupt).toHaveBeenCalledOnce()
  expect(f.diagnostics).toHaveLength(2)
  const session = createHash('sha256').update('ses_fixture').digest('hex').slice(0, 16)
  expect(f.diagnostics[0]).toMatchObject({ event: 'session_interrupt_started', session, source })
  expect(f.diagnostics[1]).toMatchObject({ event: 'session_interrupt_completed', source, status: 'accepted', interrupted: true })
  expect(JSON.stringify(f.diagnostics)).not.toContain('ses_fixture')
})
it('does not let logger exceptions prevent deny-all, wait or lease release', async () => {
  const f = fixture('caller_cancel', { logThrows: true })
  expect(await f.run()).toMatchObject({ idleVerified: true, denyAllVerified: true, leaseReleased: true, errors: [] })
  expect(f.api.session.wait).toHaveBeenCalledOnce(); expect(f.revoke).toHaveBeenCalledOnce(); expect(f.release).toHaveBeenCalledOnce()
})
it('does not send or log an interrupt for a task which was not aborted', async () => {
  const f = fixture('unknown', { aborted: false })
  expect(await f.run()).toMatchObject({ denyAllVerified: true, leaseReleased: true })
  expect(f.api.session.interrupt).not.toHaveBeenCalled(); expect(f.diagnostics).toEqual([])
})
it('bounds a hanging interrupt and retains quarantine rather than claiming clean release', async () => {
  const f = fixture('task_timeout', { hang: true }), start = Date.now()
  const receipt = await f.run()
  expect(Date.now() - start).toBeLessThan(800)
  expect(receipt.quarantined).toBe(true)
  expect(f.quarantine).toHaveBeenCalledOnce(); expect(f.release).not.toHaveBeenCalled()
  expect(f.diagnostics).toContainEqual(expect.objectContaining({ event: 'session_interrupt_completed', source: 'task_timeout', status: 'failed' }))
})
