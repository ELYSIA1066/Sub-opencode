import { describe, expect, it, vi } from 'vitest'
import type { OpenCodeClient } from '@opencode/client'
import { guardSdkClient } from '../src/opencode-sdk-adapter.js'

type Options = { signal?: AbortSignal }

const calls = { bound: 0, cleanup: 0, update: 0, interrupt: 0, subscribe: 0 }

const sdk = {
  tag: 'original',
  bound(this: { tag: string }, _options?: Options) { calls.bound += 1; return this.tag },
  cleanup(_options?: Options) { calls.cleanup += 1; return Promise.resolve('cleaned') },
  session: {
    update(_options?: Options) { calls.update += 1; return Promise.resolve('updated') },
    interrupt(_options?: Options) { calls.interrupt += 1; return Promise.resolve('interrupted') },
  },
  event: {
    subscribe(_options?: Options): AsyncIterable<unknown> {
      calls.subscribe += 1
      return (async function* () { yield 'event' })()
    },
  },
}

type FakeSdk = typeof sdk

function resetCalls() {
  calls.bound = 0
  calls.cleanup = 0
  calls.update = 0
  calls.interrupt = 0
  calls.subscribe = 0
}

function deferred() {
  let resolve!: () => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** Real guard, but viewed through the controlled stand-in; no socket or real service is involved. */
function guard(verify: () => Promise<void>): FakeSdk {
  return guardSdkClient(sdk as unknown as OpenCodeClient, verify) as unknown as FakeSdk
}

describe('guardSdkClient identity guard', () => {
  it('preserves `this` binding of ordinary methods', async () => {
    resetCalls()
    const guarded = guard(async () => {})
    expect(await guarded.bound()).toBe('original')
    expect(calls.bound).toBe(1)
  })

  it('does not call the original method when verification fails', async () => {
    resetCalls()
    const guarded = guard(async () => { throw new Error('identity changed') })

    await expect(guarded.cleanup()).rejects.toThrow('identity changed')
    expect(calls.cleanup).toBe(0)
  })

  it('rejects cleanup, session.update and interrupt when the identity changed', async () => {
    resetCalls()
    const guarded = guard(async () => { throw new Error('identity mismatch') })

    await expect(guarded.cleanup()).rejects.toThrow('identity mismatch')
    await expect(guarded.session.update()).rejects.toThrow('identity mismatch')
    await expect(guarded.session.interrupt()).rejects.toThrow('identity mismatch')
    expect(calls.cleanup).toBe(0)
    expect(calls.update).toBe(0)
    expect(calls.interrupt).toBe(0)
  })

  it('keeps the closures of two guards independent', async () => {
    resetCalls()
    const verifyFirst = vi.fn(async () => {})
    const verifySecond = vi.fn(async () => {})
    const guardedFirst = guard(verifyFirst)
    const guardedSecond = guard(verifySecond)

    await guardedFirst.cleanup()
    expect(verifyFirst).toHaveBeenCalledOnce()
    expect(verifySecond).not.toHaveBeenCalled()
    expect(calls.cleanup).toBe(1)

    await guardedSecond.session.interrupt()
    expect(verifySecond).toHaveBeenCalledOnce()
    expect(calls.interrupt).toBe(1)
  })

  it('does not call the original method when the signal aborts while verify is pending', async () => {
    resetCalls()
    const gate = deferred()
    const guarded = guard(() => gate.promise)
    const controller = new AbortController()

    const pending = guarded.cleanup({ signal: controller.signal })
    controller.abort()
    gate.resolve()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls.cleanup).toBe(0)
  })

  it('skips verification and the original method for an already-aborted signal', async () => {
    resetCalls()
    const verify = vi.fn(async () => {})
    const guarded = guard(verify)
    const controller = new AbortController()
    controller.abort()

    await expect(guarded.cleanup({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(verify).not.toHaveBeenCalled()
    expect(calls.cleanup).toBe(0)
  })

  it('keeps event.subscribe as an AsyncIterable and never subscribes when verification fails', async () => {
    resetCalls()
    const guarded = guard(async () => { throw new Error('identity changed') })

    const iterable = guarded.event.subscribe()
    expect(typeof iterable[Symbol.asyncIterator]).toBe('function')

    const consume = async () => { for await (const _ of iterable) void _ }
    await expect(consume()).rejects.toThrow('identity changed')
    expect(calls.subscribe).toBe(0)
  })

  it('rejects a subscription when verify resolves but the signal was aborted meanwhile', async () => {
    resetCalls()
    const gate = deferred()
    const guarded = guard(() => gate.promise)
    const controller = new AbortController()

    const iterable = guarded.event.subscribe({ signal: controller.signal })
    const consume = (async () => { for await (const _ of iterable) void _ })()
    await Promise.resolve()

    controller.abort()
    gate.resolve()

    await expect(consume).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls.subscribe).toBe(0)
  })
})
