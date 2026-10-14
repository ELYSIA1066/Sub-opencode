import { afterEach, describe, expect, it, vi } from 'vitest'
import { shutdownTogether } from '../src/shutdown.js'

afterEach(() => vi.useRealTimers())

describe('bounded shutdown coordination', () => {
  it('begins cancellation before starting transport and task close in parallel', async () => {
    const order: string[] = []
    const result = await shutdownTogether({
      timeoutMs: 500,
      beginShutdown: () => { order.push('cancel') },
      closeTransport: () => { order.push('transport'); return Promise.resolve() },
      closeTasks: () => { order.push('tasks'); return Promise.resolve() },
    })
    expect(order).toEqual(['cancel', 'transport', 'tasks'])
    expect(result.status).toBe('closed')
  })

  it('returns at the single deadline when transport, task cleanup, or service stop never settles', async () => {
    vi.useFakeTimers()
    const order: string[] = []
    const forever = () => new Promise<void>(() => {})
    const closing = shutdownTogether({
      timeoutMs: 1_000,
      beginShutdown: () => { order.push('cancel') },
      closeTransport: () => { order.push('transport'); return forever() },
      closeTasks: () => { order.push('tasks'); return forever() },
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(order).toEqual(['cancel', 'transport', 'tasks'])
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(closing).resolves.toMatchObject({ status: 'timed_out', failures: 1 })
  })

  it('reports cleanup failures so the CLI can exit nonzero', async () => {
    const result = await shutdownTogether({
      timeoutMs: 500,
      beginShutdown: () => undefined,
      closeTransport: async () => undefined,
      closeTasks: async () => { throw new Error('permission recovery failed') },
    })
    expect(result).toMatchObject({ status: 'failed', failures: 1 })
  })
})
