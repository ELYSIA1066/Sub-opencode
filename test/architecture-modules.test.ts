import { describe, expect, it, vi } from 'vitest'
import type { OpenCodeClient } from '@opencode/client'
import { OpenCodeSdkAdapter } from '../src/opencode-sdk-adapter.js'
import { cleanupReceipt } from '../src/task-cleanup.js'
import { TurnEvidence } from '../src/turn-result-matcher.js'
import { cleanupCall } from '../src/deadline.js'

describe('architecture boundaries', () => {
  it('keeps SDK calls one-shot: no fallback or replay after a transport error', async () => {
    const failure = new Error('offline')
    const method = vi.fn(async () => { throw failure })
    const raw = { session: { prompt: method } } as unknown as OpenCodeClient
    const factory = vi.fn(() => raw)
    const adapter = new OpenCodeSdkAdapter(() => 'http://127.0.0.1:4096', () => ({}), factory)
    const client = await adapter.getClient()
    await expect(client.session.prompt({ sessionID: 's', text: 'test' })).rejects.toBe(failure)
    expect(factory).toHaveBeenCalledOnce()
    expect(method).toHaveBeenCalledOnce()
  })

  it('returns an immutable cleanup receipt', () => {
    const errors = ['permission_reset_failed']
    const receipt = cleanupReceipt({ idleVerified: true, denyAllVerified: false, quarantined: true, leaseRetained: false, leaseReleased: false, errors })
    errors.push('mutated')
    expect(receipt.errors).toEqual(['permission_reset_failed'])
    expect(Object.isFrozen(receipt)).toBe(true)
    expect(Object.isFrozen(receipt.errors)).toBe(true)
  })

  it('clears deadline timers after successful cleanup calls', async () => {
    vi.useFakeTimers()
    try {
      const result = await cleanupCall(async () => 'done', Date.now() + 5_000)
      expect(result).toBe('done')
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it('binds each inbox to only the steps delivered after that inbox event', () => {
    const evidence = new TurnEvidence()
    evidence.observe({ type: 'session.inbox.delivered', data: { sessionID: 's', inboxID: 'old' } } as never, 's')
    evidence.observe({ type: 'session.step.started', data: { sessionID: 's', assistantMessageID: 'old-step' } } as never, 's')
    evidence.observe({ type: 'session.inbox.delivered', data: { sessionID: 's', inboxID: 'current' } } as never, 's')
    expect(evidence.assistantIds('current')).toEqual([])
    evidence.observe({ type: 'session.step.started', data: { sessionID: 's', assistantMessageID: 'current-step' } } as never, 's')
    expect(evidence.assistantIds('old')).toEqual(['old-step'])
    expect(evidence.assistantIds('current')).toEqual(['current-step'])
  })
})
