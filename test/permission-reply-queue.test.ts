import { afterEach, describe, expect, it, vi } from 'vitest'
import { PermissionReplyQueue } from '../src/permission-reply-queue.js'

function createQueue(onError: (error: unknown) => void = () => {}) {
  const controller = new AbortController()
  const queue = new PermissionReplyQueue(controller.signal, onError)
  return { queue, controller }
}

describe('PermissionReplyQueue', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs enqueued work serially without overlap', async () => {
    const { queue } = createQueue()
    const order: string[] = []
    let active = 0
    let maxActive = 0

    const make = (id: string) => async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      order.push(`start:${id}`)
      await Promise.resolve()
      active -= 1
      order.push(`end:${id}`)
    }

    queue.enqueue('a', make('a'))
    queue.enqueue('b', make('b'))
    queue.enqueue('c', make('c'))
    await queue.idle()

    expect(maxActive).toBe(1)
    expect(order).toEqual([
      'start:a',
      'end:a',
      'start:b',
      'end:b',
      'start:c',
      'end:c',
    ])
  })

  it('does not run a duplicate enqueue more than once', async () => {
    const { queue } = createQueue()
    let calls = 0
    const work = async () => {
      calls += 1
    }

    queue.enqueue('dup', work)
    queue.enqueue('dup', work)
    queue.enqueue('dup', work)
    await queue.idle()

    expect(calls).toBe(1)
  })

  it('skips entries settled while an earlier work is still pending', async () => {
    const { queue } = createQueue()
    let releaseShell!: () => void
    const shellGate = new Promise<void>((resolve) => {
      releaseShell = resolve
    })

    let shellStarted = false
    let readACalls = 0
    let readBCalls = 0
    queue.enqueue('shell', async () => {
      shellStarted = true
      await shellGate
    })
    queue.enqueue('readA', async () => {
      readACalls += 1
    })
    queue.enqueue('readB', async () => {
      readBCalls += 1
    })

    await vi.waitFor(() => expect(shellStarted).toBe(true))

    const readA = queue.waitForReject('readA', 1000)
    const readB = queue.waitForReject('readB', 1000)
    queue.settle('readA', 'reject')
    queue.settle('readB', 'reject')

    await expect(readA).resolves.toBe(true)
    await expect(readB).resolves.toBe(true)

    releaseShell()
    await queue.idle()

    expect(readACalls).toBe(0)
    expect(readBCalls).toBe(0)
  })

  it('does not run work enqueued after its id was settled', async () => {
    const { queue } = createQueue()
    let calls = 0

    queue.settle('x', 'reject')
    queue.enqueue('x', async () => {
      calls += 1
    })
    await queue.idle()

    expect(calls).toBe(0)
    expect(queue.isSettled('x')).toBe(true)
    expect(queue.replyFor('x')).toBe('reject')
  })

  it('keeps the first settle and ignores duplicates', () => {
    const { queue } = createQueue()

    queue.settle('x', 'once')
    queue.settle('x', 'reject')
    queue.settle('x', 'always')

    expect(queue.replyFor('x')).toBe('once')
  })

  it('resolves waitForReject true for a later reject', async () => {
    const { queue } = createQueue()

    const pending = queue.waitForReject('x', 1000)
    queue.settle('x', 'reject')

    await expect(pending).resolves.toBe(true)
  })

  it('resolves waitForReject false for once/always', async () => {
    const { queue } = createQueue()

    const once = queue.waitForReject('once', 1000)
    queue.settle('once', 'once')
    await expect(once).resolves.toBe(false)

    const always = queue.waitForReject('always', 1000)
    queue.settle('always', 'always')
    await expect(always).resolves.toBe(false)
  })

  it('ignores a settle for a different id', async () => {
    const { queue } = createQueue()
    let resolved: boolean | undefined

    const pending = queue.waitForReject('x', 1000)
    void pending.then((value) => {
      resolved = value
    })
    queue.settle('y', 'reject')
    await Promise.resolve()

    expect(resolved).toBeUndefined()

    queue.settle('x', 'once')
    await expect(pending).resolves.toBe(false)
  })

  it('resolves waitForReject immediately when already settled', async () => {
    const { queue } = createQueue()

    queue.settle('rejected', 'reject')
    queue.settle('accepted', 'once')

    await expect(queue.waitForReject('rejected', 1000)).resolves.toBe(true)
    await expect(queue.waitForReject('accepted', 1000)).resolves.toBe(false)
  })

  it('times out after at most 1000ms', async () => {
    vi.useFakeTimers()
    const { queue } = createQueue()
    let resolved: boolean | undefined

    const pending = queue.waitForReject('x', 5000)
    void pending.then((value) => {
      resolved = value
    })

    await vi.advanceTimersByTimeAsync(999)
    expect(resolved).toBeUndefined()

    await vi.advanceTimersByTimeAsync(1)
    expect(resolved).toBe(false)
    await expect(pending).resolves.toBe(false)
  })

  it('rejects waitForReject and resolves idle on abort', async () => {
    const { queue, controller } = createQueue()
    const reason = new Error('aborted')
    const pending = queue.waitForReject('x', 1000)
    const idle = queue.idle()

    controller.abort(reason)

    await expect(pending).rejects.toBe(reason)
    await expect(idle).resolves.toBeUndefined()
  })

  it('clears pending work and settles idle when aborted before draining', async () => {
    const { queue, controller } = createQueue()
    const calls: string[] = []

    queue.enqueue('a', async () => {
      calls.push('a')
    })
    queue.enqueue('b', async () => {
      calls.push('b')
    })
    const idle = queue.idle()

    controller.abort(new Error('stop'))

    await idle
    await Promise.resolve()
    expect(calls).toEqual([])
  })

  it('reports a worker error once and stops further work', async () => {
    const errors: unknown[] = []
    const { queue } = createQueue((error) => errors.push(error))
    const runs: string[] = []

    queue.enqueue('a', async () => {
      runs.push('a')
      throw new Error('boom')
    })
    queue.enqueue('b', async () => {
      runs.push('b')
    })
    queue.enqueue('c', async () => {
      runs.push('c')
    })
    await queue.idle()

    expect(runs).toEqual(['a'])
    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toBe('boom')
  })

  it('does not run new work after a worker error stopped the queue', async () => {
    const errors: unknown[] = []
    const { queue } = createQueue((error) => errors.push(error))
    let lateCalls = 0

    queue.enqueue('a', async () => {
      throw new Error('boom')
    })
    await queue.idle()

    queue.enqueue('late', async () => {
      lateCalls += 1
    })
    await queue.idle()

    expect(lateCalls).toBe(0)
    expect(errors).toHaveLength(1)
  })
})
