import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenCodeDelegator, type DelegateInput } from '../src/delegation.js'
import type { OpenCodeServerManager } from '../src/opencode-server.js'
import { OpenCodeServerError } from '../src/opencode-server.js'
import { ClientError, type OpenCodeClient } from '@opencode/client'

const roots: string[] = []
const delegators: OpenCodeDelegator[] = []

function workspace(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'opencode-delegation-'))
  roots.push(root)
  return root
}

function setup(options: {
  prompt?: () => Promise<unknown>
  wait?: () => Promise<unknown>
  interruptResult?: boolean
  failServer?: boolean
  promptTimeoutMs?: number
  permissionRequests?: unknown[]
  sessionUnavailable?: boolean
  failPermissionReset?: boolean
  resetDoesNotApply?: boolean
  omitCreatePermissions?: boolean
  omitGetPermissions?: boolean
  steps?: Array<{ id: string; finish: string; text: string }>
  stepDelayMs?: number
  eventMode?: 'eof' | 'disconnect' | 'abort-error' | 'hang' | 'disconnect-after-prompt'
  clientFailures?: number
  hangPermissionReset?: boolean
  hangTaskPermissionUpdate?: boolean
  hangServer?: boolean
  onPermissionResetStart?: () => void
  onWaitStart?: () => void
  onTaskPermissionUpdateStart?: (release: () => void) => void
  releaseTaskPermissionUpdate?: () => void
  onPromptStart?: () => void
  onEventPumpHang?: () => void
  prepare?: (deadline: number, signal: AbortSignal) => Promise<void>
  hangPermissionReply?: 'honor-signal' | 'ignore-signal'
  onPermissionReplyStart?: (signal: AbortSignal | undefined, release: () => void, reject: () => void) => void
} = {}) {
  const workspaceRoot = workspace()
  let currentUrl = 'http://127.0.0.1:4096'
  const clientUrls: string[] = []
  const server = {
    get baseUrl() { return currentUrl },
    get diagnosticInfo() { return { source: 'shared', identity: { id: 'test-service', pid: 456, url: currentUrl }, version: 'unknown' } },
    headers: {},
    ensureReady: vi.fn(async () => {
      if (options.hangServer) return new Promise<never>(() => {})
      if (options.failServer) throw new Error('server startup failed')
      return { healthy: true as const, version: 'test' }
    }),
    invalidate: vi.fn((expectedUrl: string) => {
      if (expectedUrl !== currentUrl) return false
      currentUrl = 'http://127.0.0.1:4097'
      return true
    }),
    close: vi.fn(async () => {}),
  }
  let nextSession = 0
  const calls = { create: 0, prompt: 0, update: [] as unknown[], interrupt: 0 }
  let currentPermissions: unknown = [{ action: '*', resource: '*', effect: 'deny' }]
  let clientFailures = options.clientFailures ?? 0
  const messagesBySession = new Map<string, Array<Record<string, unknown>>>()
  const eventSubscribers: Array<{ queue: unknown[]; wake?: () => void }> = []
  const pushEvent = (event: unknown) => {
    for (const subscriber of eventSubscribers) {
      subscriber.queue.push(event)
      subscriber.wake?.()
      subscriber.wake = undefined
    }
  }
  const api = {
    session: {
      create: vi.fn(async () => {
        const id = `session-${++nextSession}`
        messagesBySession.set(id, [])
        return {
        id,
        ...(!options.omitCreatePermissions && { permissions: currentPermissions }),
      }}),
      switchModel: vi.fn(async () => {}),
      get: vi.fn(async () => {
        if (options.sessionUnavailable) throw new Error('session not found')
        return {
          location: { directory: workspaceRoot },
          ...(!options.omitGetPermissions && { permissions: currentPermissions }),
        }
      }),
      update: vi.fn(async (request: unknown) => {
        calls.update.push(request)
        const permissions = (request as { permissions?: { action: string; resource: string; effect: string }[] }).permissions
        const rules = permissions
        if (rules?.length === 1 && rules[0].action === '*' && rules[0].effect === 'deny') options.onPermissionResetStart?.()
        if (options.failPermissionReset && rules?.length === 1 && rules[0].action === '*' && rules[0].effect === 'deny') {
          throw new Error('forced reset failure')
        }
        if (options.hangPermissionReset && rules?.length === 1 && rules[0].action === '*' && rules[0].effect === 'deny' && calls.update.length > 1) {
          options.onPermissionResetStart?.()
          return new Promise(() => {})
        }
        if (options.hangTaskPermissionUpdate && rules?.some((rule) => rule.effect === 'ask')) {
          return new Promise<void>((resolve) => {
            const release = () => { currentPermissions = permissions; resolve() }
            options.releaseTaskPermissionUpdate = release
            options.onTaskPermissionUpdateStart?.(release)
          })
        }
        if (permissions && !(options.resetDoesNotApply && permissions.length === 1 && permissions[0].effect === 'deny')) {
          currentPermissions = permissions
        }
        return {}
      }),
      prompt: vi.fn(async (request: { sessionID: string }, requestOptions?: { signal?: AbortSignal }) => {
        calls.prompt++
        options.onPromptStart?.()
        if (options.prompt) return abortable(options.prompt(), requestOptions?.signal)
        const id = `user-${calls.prompt}`
        const steps = options.steps ?? [{ id: `assistant-${calls.prompt}`, finish: 'stop', text: 'done' }]
        const messages = messagesBySession.get(request.sessionID) ?? []
        messages.unshift({ id, type: 'user', text: 'Make a change' })
        for (const step of steps) {
          messages.unshift({ id: step.id, type: 'assistant', finish: step.finish, content: [{ type: 'text', text: step.text }] })
        }
        pushEvent({ type: 'session.inbox.delivered', data: { sessionID: request.sessionID, inboxID: id } })
        for (const step of steps) pushEvent({ type: 'session.step.started', data: { sessionID: request.sessionID, assistantMessageID: step.id } })
        return { id, sessionID: request.sessionID, time: { created: calls.prompt }, type: 'user', payload: { text: 'Make a change' }, delivery: 'delivered' }
      }),
      wait: vi.fn(async (_request: unknown, requestOptions?: { signal?: AbortSignal }) => {
        options.onWaitStart?.()
        return options.wait ? abortable(options.wait(), requestOptions?.signal) : {}
      }),
      interrupt: vi.fn(async () => { calls.interrupt++; return { interrupted: options.interruptResult ?? true } }),
    },
    message: {
      list: vi.fn(async ({ sessionID, cursor }: { sessionID: string; cursor?: string }) => {
        const offset = cursor ? Number(cursor) : 0
        const next = offset + 100
        const messages = messagesBySession.get(sessionID) ?? []
        return {
          data: messages.slice(offset, next),
          cursor: { ...(messages.length > next && { next: String(next) }) },
        }
      }),
    },
    permission: { reply: vi.fn(async (_request: unknown, requestOptions?: { signal?: AbortSignal }) => {
      if (!options.hangPermissionReply) return {}
      let release!: () => void
      let reject!: () => void
      const pending = new Promise<void>((resolve, rejectPromise) => {
        release = resolve
        reject = () => rejectPromise(new Error('late permission reply rejection'))
      })
      options.onPermissionReplyStart?.(requestOptions?.signal, release, reject)
      return options.hangPermissionReply === 'honor-signal'
        ? abortable(pending, requestOptions?.signal)
        : pending
    }) },
    event: {
      subscribe: vi.fn(({ signal }: { signal: AbortSignal }) => events(signal)),
    },
  }
  async function* events(signal: AbortSignal) {
    const subscriber: { queue: unknown[]; wake?: () => void } = { queue: [] }
    eventSubscribers.push(subscriber)
    try {
      yield { type: 'server.connected', data: {} }
      if (options.eventMode === 'eof') return
      if (options.eventMode === 'disconnect') throw new Error('event stream disconnected')
      if (options.eventMode === 'abort-error') throw new DOMException('stream aborted', 'AbortError')
      for (const data of options.permissionRequests ?? []) yield { type: 'permission.asked', data }
      while (!signal.aborted) {
        if (subscriber.queue.length) {
          const event = subscriber.queue.shift() as { type?: string }
          if (options.eventMode === 'disconnect-after-prompt' && event.type === 'session.inbox.delivered') {
            throw Object.assign(new Error('event stream disconnected after prompt'), { code: 'ECONNRESET' })
          }
          if (event.type === 'session.step.started' && options.stepDelayMs) {
            await new Promise((resolve) => setTimeout(resolve, options.stepDelayMs))
          }
          yield event
        } else {
          if (options.eventMode === 'hang') {
            options.onEventPumpHang?.()
            await new Promise(() => {})
          }
          await new Promise<void>((resolve) => {
            let settled = false
            const finish = () => {
              if (settled) return
              settled = true
              signal.removeEventListener('abort', finish)
              subscriber.wake = undefined
              resolve()
            }
            subscriber.wake = finish
            signal.addEventListener('abort', finish, { once: true })
            if (signal.aborted) finish()
          })
        }
      }
    } finally {
      const index = eventSubscribers.indexOf(subscriber)
      if (index >= 0) eventSubscribers.splice(index, 1)
    }
  }
  const delegator = new OpenCodeDelegator(
    server as unknown as OpenCodeServerManager,
    {
      opencodeCommand: 'opencode',
      model: 'opencode/mimo-v2.6-flash-free',
      promptTimeoutMs: options.promptTimeoutMs ?? 1_000,
      contextStorePath: path.join(workspaceRoot, 'contexts.sqlite'),
    },
    () => {
      if (clientFailures > 0) { clientFailures--; throw new Error('client initialization failed') }
      clientUrls.push(server.baseUrl)
      return api as unknown as OpenCodeClient
    },
    options.prepare,
  )
  delegators.push(delegator)
  const input: DelegateInput = {
    task: 'Make a change',
    workspace_root: workspaceRoot,
    permission_scope: { fileAccess: 'workspace_write', shellCommands: [] },
  }
  return { delegator, server, api, calls, input, options, clientUrls, pushEvent }
}

describe('task service preparation boundary', () => {
  it('does no preparation at construction and prepares before session or prompt', async () => {
    const prepare = vi.fn(async (deadline: number, signal: AbortSignal) => {
      expect(deadline).toBeGreaterThan(Date.now()); expect(signal.aborted).toBe(false)
      expect(f.api.session.create).not.toHaveBeenCalled(); expect(f.api.session.prompt).not.toHaveBeenCalled()
    })
    const f = setup({ prepare }); expect(prepare).not.toHaveBeenCalled()
    expect((await f.delegator.delegate(f.input)).status).toBe('completed')
    expect(prepare).toHaveBeenCalledOnce(); expect(f.calls.prompt).toBe(1)
  })
  it('preparation failure submits zero prompts and does not create a session', async () => {
    const f = setup({ prepare: async () => { throw new OpenCodeServerError('preparation refused') } })
    expect(await f.delegator.delegate(f.input)).toMatchObject({ status: 'failed', error_code: 'service_unavailable' })
    expect(f.calls.prompt).toBe(0); expect(f.api.session.create).not.toHaveBeenCalled()
  })
  it('deadline cancellation stops preparation before any session and prompt', async () => {
    const f = setup({ promptTimeoutMs: 25, prepare: (_deadline, signal) => new Promise((_res, rej) => signal.addEventListener('abort', () => rej(signal.reason), { once: true })) })
    expect(await f.delegator.delegate(f.input)).toMatchObject({ status: 'failed', error_code: 'task_timeout' })
    expect(f.calls.prompt).toBe(0); expect(f.api.session.create).not.toHaveBeenCalled()
  })
  it('close cancels in-progress preparation and does not submit any prompt', async () => {
    let started!: () => void; const ready = new Promise<void>((res) => { started = res })
    const f = setup({ prepare: (_deadline, signal) => new Promise((_res, rej) => { started(); signal.addEventListener('abort', () => rej(signal.reason), { once: true }) }) })
    const task = f.delegator.delegate(f.input); await ready; await f.delegator.close()
    expect((await task).status).toBe('canceled'); expect(f.calls.prompt).toBe(0)
  })
})

afterEach(async () => {
  await Promise.all(delegators.splice(0).map((delegator) => delegator.close()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('OpenCode delegation', () => {
  it.each(['caller_cancel', 'task_timeout', 'mcp_shutdown', 'event_stream_failure', 'permission_reply_failure'] as const)('preserves the real abort origin in cleanup diagnostics: %s', async (source) => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    let promptStarted!: () => void
    const started = new Promise<void>((resolve) => { promptStarted = resolve })
    const opts = source === 'event_stream_failure'
      ? { eventMode: 'disconnect-after-prompt' as const, wait: () => new Promise(() => {}) }
      : source === 'permission_reply_failure'
        ? { permissionRequests: [{ id: 'request', sessionID: 'session-1', action: 'shell', resources: ['blocked'] }] }
        : { prompt: () => new Promise(() => {}), promptTimeoutMs: source === 'task_timeout' ? 70 : 1000, onPromptStart: promptStarted }
    const { delegator, api, input } = setup(opts)
    if (source === 'permission_reply_failure') api.permission.reply.mockRejectedValueOnce(new Error('reply failure'))
    const caller = new AbortController()
    try {
      const pending = delegator.delegate(input, source === 'caller_cancel' ? caller.signal : undefined)
      if (source === 'caller_cancel' || source === 'mcp_shutdown') {
        await started
        if (source === 'caller_cancel') caller.abort()
        else delegator.beginShutdown()
      }
      const result = await pending
      expect(result.status).toBe(['caller_cancel', 'mcp_shutdown'].includes(source) ? 'canceled' : 'failed')
      const entries = logged.mock.calls.flatMap(([line]) => { try { return [JSON.parse(String(line))] } catch { return [] } })
      expect(entries).toContainEqual(expect.objectContaining({ event: 'session_interrupt_started', source, correlationId: expect.any(String), session: expect.any(String) }))
      expect(api.session.interrupt).toHaveBeenCalledOnce()
    } finally { logged.mockRestore() }
  })
  it('aborts work immediately at shutdown, enforces the task cleanup deadline, and fails close when recovery quarantines', async () => {
    let updateStarted!: () => void
    let releaseUpdate!: () => void
    const started = new Promise<void>((resolve) => { updateStarted = resolve })
    const { delegator, input, api } = setup({
      hangTaskPermissionUpdate: true,
      failPermissionReset: true,
      onTaskPermissionUpdateStart: (release) => { releaseUpdate = release; updateStarted() },
    })
    const task = delegator.delegate(input)
    await started
    const deadline = Date.now() + 1_500
    expect(delegator.beginShutdown(deadline)).toBe(deadline)
    expect(delegator.beginShutdown(Date.now() + 30_000)).toBe(deadline)
    let closeError: unknown
    try { await delegator.close(deadline) } catch (error) { closeError = error }
    expect(closeError).toMatchObject({ errorCode: 'shutdown_failed' })
    delegators.splice(delegators.indexOf(delegator), 1)
    releaseUpdate()
    const result = await task
    expect(result).toMatchObject({ status: 'failed', error_code: 'permission_reset_failed' })
    expect(api.session.prompt).not.toHaveBeenCalled()
  })

  it('keeps the context database open until an in-flight task cleanup has actually settled', async () => {
    let updateStarted!: () => void
    let releaseUpdate!: () => void
    const started = new Promise<void>((resolve) => { updateStarted = resolve })
    const { delegator, input } = setup({
      hangTaskPermissionUpdate: true,
      onTaskPermissionUpdateStart: (release) => { releaseUpdate = release; updateStarted() },
    })
    const task = delegator.delegate(input)
    await started
    const deadline = Date.now() + 1_500
    const closing = delegator.close(deadline)
    const store = (delegator as unknown as { contextStore: { closed: boolean; db: DatabaseSync } }).contextStore
    expect(store.closed).toBe(false)
    expect(store.db.prepare('SELECT 1 AS open').get()).toEqual({ open: 1 })
    releaseUpdate()
    const result = await task
    expect(result.status).toBe('canceled')
    await expect(closing).resolves.toBeUndefined()
    expect(store.closed).toBe(true)
  })

  it('creates a session, then reuses it for a context in the same workspace', async () => {
    const { delegator, server, api, input } = setup()
    const first = await delegator.delegate(input)
    await delegator.close()
    const restarted = new OpenCodeDelegator(
      server as unknown as OpenCodeServerManager,
      {
        opencodeCommand: 'opencode',
        model: 'opencode/mimo-v2.6-flash-free',
        promptTimeoutMs: 1_000,
        contextStorePath: path.join(input.workspace_root, 'contexts.sqlite'),
      },
      () => api as unknown as OpenCodeClient,
    )
    delegators.push(restarted)
    const second = await restarted.delegate({ ...input, context_id: first.context_id, task: 'Continue' })

    expect(first).toMatchObject({ status: 'completed', session_id: 'session-1', result: 'done' })
    expect(first.attach_command).toBe('opencode --server http://127.0.0.1:4096')
    expect(second.session_id).toBe('session-1')
    expect(api.session.create).toHaveBeenCalledTimes(1)
    expect(api.session.create).toHaveBeenCalledWith(expect.objectContaining({
      model: { providerID: 'opencode', id: 'mimo-v2.6-flash-free' },
    }), { signal: expect.any(AbortSignal) })
    expect(api.session.switchModel).toHaveBeenCalledWith({
      sessionID: 'session-1', model: { providerID: 'opencode', id: 'mimo-v2.6-flash-free' },
    }, { signal: expect.any(AbortSignal) })
    expect(api.session.get).toHaveBeenCalledWith({ sessionID: 'session-1' }, { signal: expect.any(AbortSignal) })
    expect(api.session.prompt).toHaveBeenCalledTimes(2)
    await restarted.close()
  })

  it('rejects a context reused with another workspace', async () => {
    const { delegator, input } = setup()
    const first = await delegator.delegate(input)
    await expect(delegator.delegate({ ...input, workspace_root: workspace(), context_id: first.context_id }))
      .rejects.toThrow('different workspace_root')
  })

  it('returns a clear failure if the server cannot start', async () => {
    const { delegator, input } = setup({ failServer: true })
    const result = await delegator.delegate(input)
    expect(result).toMatchObject({ status: 'failed', error: 'OpenCode task failed. Check that OpenCode is installed, authenticated, and reachable.' })
  })

  it('does not create a session or prompt after explicit-port service_unavailable', async () => {
    const { delegator, server, api, input } = setup()
    server.ensureReady.mockRejectedValue(new OpenCodeServerError('The configured OpenCode port is already in use.'))
    const result = await delegator.delegate(input)
    expect(result).toMatchObject({ status: 'failed', error_code: 'service_unavailable' })
    expect(server.ensureReady).toHaveBeenCalledOnce()
    expect(api.session.create).not.toHaveBeenCalled()
    expect(api.session.prompt).not.toHaveBeenCalled()
  })

  it('releases the context lease after server initialization fails before any session mutation', async () => {
    const { delegator, input, options } = setup({ failServer: true })
    const first = await delegator.delegate(input)
    options.failServer = false
    const second = await delegator.delegate({ ...input, context_id: first.context_id })
    expect(first.status).toBe('failed')
    expect(second).toMatchObject({ status: 'completed', result: 'done' })
  })

  it('rejects invalid workspaces before contacting OpenCode', async () => {
    const { delegator, api, input } = setup()
    await expect(delegator.delegate({ ...input, workspace_root: 'relative/path' })).rejects.toThrow('absolute path')
    expect(api.session.create).not.toHaveBeenCalled()
  })

  it('does not create a replacement session when a persisted OpenCode session is unavailable', async () => {
    const { delegator, api, input } = setup()
    const first = await delegator.delegate(input)
    ;(api.session.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('session not found'))

    const result = await delegator.delegate({ ...input, context_id: first.context_id, task: 'Continue' })

    expect(result).toMatchObject({
      status: 'failed',
      session_id: 'session-1',
      error: expect.stringContaining('if the session was deleted, start a new context_id'),
    })
    expect(api.session.create).toHaveBeenCalledTimes(1)
  })

  it('fails clearly when the context database cannot be opened', async () => {
    const { server, input } = setup()
    const blockedParent = path.join(input.workspace_root, 'not-a-directory')
    writeFileSync(blockedParent, 'file')
    expect(() => new OpenCodeDelegator(
      server as unknown as OpenCodeServerManager,
      {
        opencodeCommand: 'opencode',
        model: 'opencode/mimo-v2.6-flash-free',
        promptTimeoutMs: 1_000,
        contextStorePath: path.join(blockedParent, 'contexts.sqlite'),
      },
    )).toThrow('Unable to open the local context database')
  })

  it('returns a clear failure when persisting a newly created context fails', async () => {
    const { delegator, input } = setup()
    const database = new DatabaseSync(path.join(input.workspace_root, 'contexts.sqlite'))
    database.exec(`
      CREATE TRIGGER fail_context_insert BEFORE INSERT ON contexts
      BEGIN SELECT RAISE(FAIL, 'forced write failure'); END;
    `)
    database.close()

    const result = await delegator.delegate(input)

    expect(result).toMatchObject({
      status: 'failed',
      session_id: 'session-1',
      error: 'Unable to persist the OpenCode context mapping.',
    })
    await delegator.close()
  })

  it('interrupts the OpenCode session when the MCP request is canceled', async () => {
    const { delegator, api, input, calls } = setup({ prompt: () => new Promise(() => {}) })
    const controller = new AbortController()
    const pending = delegator.delegate(input, controller.signal)
    await vi.waitFor(() => expect(api.session.prompt).toHaveBeenCalledOnce())
    controller.abort()
    const result = await pending
    expect(result.status).toBe('canceled')
    expect(calls.interrupt).toBe(1)
    expect(api.session.wait).toHaveBeenCalledOnce()
    expect(api.session.wait.mock.calls[0]?.[1]?.signal?.aborted).toBe(false)
  })

  it.each([true, false])('requires cleanup wait to confirm idle after interrupt=%s before allowing reuse', async (interrupted) => {
    const { delegator, api, input, options } = setup({ prompt: () => new Promise(() => {}), interruptResult: interrupted })
    const controller = new AbortController()
    const pending = delegator.delegate(input, controller.signal)
    await vi.waitFor(() => expect(api.session.prompt).toHaveBeenCalledOnce())
    controller.abort()
    const first = await pending
    expect(first.status).toBe('canceled')
    expect(api.session.interrupt).toHaveBeenCalledOnce()
    expect(api.session.wait).toHaveBeenCalledOnce()

    options.prompt = undefined
    const next = await delegator.delegate({ ...input, context_id: first.context_id })
    expect(next).toMatchObject({ status: 'completed', result: 'done' })
  })

  it.each([1, 2])('quarantines when cleanup wait cannot confirm remote idle (run %i)', async () => {
    vi.useFakeTimers()
    let notifyWaitStarted!: () => void
    const waitStarted = new Promise<void>((resolve) => { notifyWaitStarted = resolve })
    try {
      const { delegator, api, input } = setup({
        prompt: () => new Promise(() => {}),
        interruptResult: false,
        wait: () => new Promise(() => {}),
        onWaitStart: () => notifyWaitStarted(),
      })
      const controller = new AbortController()
      const pending = delegator.delegate(input, controller.signal)
      await vi.waitFor(() => expect(api.session.prompt).toHaveBeenCalledOnce())
      controller.abort()
      await waitStarted
      await vi.advanceTimersByTimeAsync(10_000)
      const first = await pending
      expect(first).toMatchObject({ status: 'failed', error_code: 'permission_reset_failed' })
      expect(api.session.update).toHaveBeenLastCalledWith({
        sessionID: first.session_id, permissions: [{ action: '*', resource: '*', effect: 'deny' }],
      }, { signal: expect.any(AbortSignal) })
      await expect(delegator.delegate({ ...input, context_id: first.context_id })).rejects.toMatchObject({ errorCode: 'session_quarantined' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits for active delegation cleanup before closing the context store', async () => {
    const { delegator, api, input } = setup({ prompt: () => new Promise(() => {}) })
    const pending = delegator.delegate(input)
    await vi.waitFor(() => expect(api.session.prompt).toHaveBeenCalledOnce())
    await delegator.close()
    const result = await pending
    expect(result.status).toBe('canceled')
    expect(api.session.wait).toHaveBeenCalledOnce()
    expect(api.session.update).toHaveBeenLastCalledWith({
      sessionID: 'session-1', permissions: [{ action: '*', resource: '*', effect: 'deny' }],
    }, { signal: expect.any(AbortSignal) })
    await expect(delegator.delegate(input)).rejects.toThrow('delegator is closed')
  })

  it('recovers the same context after caller cancellation', async () => {
    let waits = 0
    const { delegator, input } = setup({ wait: () => ++waits === 1 ? new Promise(() => {}) : Promise.resolve() })
    const controller = new AbortController()
    const firstPending = delegator.delegate(input, controller.signal)
    await vi.waitFor(() => expect(waits).toBe(1))
    controller.abort()
    const first = await firstPending
    const second = await delegator.delegate({ ...input, context_id: first.context_id })
    expect(first.status).toBe('canceled')
    expect(second).toMatchObject({ status: 'completed', result: 'done' })
  })

  it('allows distinct contexts to overlap within the mock service', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let waiting = 0
    const { delegator, input } = setup({ wait: async () => {
      waiting++
      if (waiting === 2) release()
      await gate
    } })
    const [first, second] = await Promise.all([
      delegator.delegate({ ...input, context_id: 'context-a' }),
      delegator.delegate({ ...input, context_id: 'context-b' }),
    ])
    expect(first.status).toBe('completed')
    expect(second.status).toBe('completed')
    expect(first.session_id).not.toBe(second.session_id)
  })

  it('uses the SQLite lease to keep a second delegator from touching an active session', async () => {
    let releaseFirst!: () => void
    let waits = 0
    const { delegator, server, api, input } = setup({ wait: () => {
      waits++
      if (waits > 1) return Promise.resolve()
      return new Promise<void>((resolve) => { releaseFirst = resolve })
    } })
    const contextId = 'shared-cross-client-context'
    const firstPromise = delegator.delegate({ ...input, context_id: contextId })
    await vi.waitFor(() => expect(api.session.wait).toHaveBeenCalledOnce())

    const peer = new OpenCodeDelegator(
      server as unknown as OpenCodeServerManager,
      {
        opencodeCommand: 'opencode', model: 'opencode/mimo-v2.6-flash-free', promptTimeoutMs: 1_000,
        contextStorePath: path.join(input.workspace_root, 'contexts.sqlite'),
      },
      () => api as unknown as OpenCodeClient,
    )
    delegators.push(peer)
    const updatesBefore = api.session.update.mock.calls.length
    await expect(peer.delegate({ ...input, context_id: contextId })).rejects.toMatchObject({ errorCode: 'context_busy' })
    expect(api.session.update).toHaveBeenCalledTimes(updatesBefore)

    releaseFirst()
    await expect(firstPromise).resolves.toMatchObject({ status: 'completed' })
    await expect(peer.delegate({ ...input, context_id: contextId })).resolves.toMatchObject({ status: 'completed' })
  })

  it('interrupts the OpenCode session when the prompt times out', async () => {
    const { delegator, api, input, calls } = setup({ prompt: () => new Promise(() => {}), promptTimeoutMs: 20 })
    const result = await delegator.delegate(input)
    expect(result).toMatchObject({ status: 'failed', error: 'OpenCode task deadline exceeded.', error_code: 'task_timeout' })
    expect(api.session.prompt).toHaveBeenCalledOnce()
    expect(calls.interrupt).toBe(1)
  })

  it('applies the overall deadline while server discovery is pending', async () => {
    const { delegator, input, api } = setup({ hangServer: true, promptTimeoutMs: 20 })
    const result = await delegator.delegate(input)
    expect(result).toMatchObject({ status: 'failed', error_code: 'task_timeout' })
    expect(api.session.create).not.toHaveBeenCalled()
  })

  it('resets session permissions to deny-all after completion', async () => {
    const { delegator, input, calls } = setup()
    await delegator.delegate(input)
    expect(calls.update).toHaveLength(2)
    expect(calls.update.at(-1)).toMatchObject({ permissions: [{ action: '*', resource: '*', effect: 'deny' }] })
  })

  it.each([1, 2])('fails and quarantines the context when permission reset cannot be applied (run %i)', async () => {
    const { delegator, input, api } = setup({ failPermissionReset: true })
    const first = await delegator.delegate(input)
    expect(first).toMatchObject({ status: 'failed', error_code: 'permission_reset_failed' })
    await expect(delegator.delegate({ ...input, context_id: first.context_id, task: 'Try reuse' }))
      .rejects.toMatchObject({ errorCode: 'session_quarantined' })
    expect(api.session.prompt).toHaveBeenCalledOnce()
  })

  it('counts a cleanup failure as shutdown failure when shutdown starts during cleanup', async () => {
    let signalCleanup!: () => void
    const cleanupStarted = new Promise<void>((resolve) => { signalCleanup = resolve })
    const { delegator, input } = setup({ failPermissionReset: true, onPermissionResetStart: signalCleanup })
    const task = delegator.delegate(input)
    await cleanupStarted
    delegator.beginShutdown(Date.now() + 10_000)
    const shutdownFailure = await delegator.close().then(() => undefined, (error) => error)
    expect(shutdownFailure).toBeInstanceOf(Error)
    expect((shutdownFailure as Error).message).toContain('Shutdown did not complete cleanly')
    expect(await task).toMatchObject({ status: 'failed', error_code: 'permission_reset_failed' })
    delegators.splice(delegators.indexOf(delegator), 1)
  })

  it.each([1, 2])('fails when a successful reset request leaves the reported rules open (run %i)', async () => {
    const { delegator, input, api } = setup({ resetDoesNotApply: true })
    const result = await delegator.delegate(input)
    expect(result).toMatchObject({ status: 'failed', error_code: 'permission_reset_failed' })
    expect(api.session.prompt).toHaveBeenCalledOnce()
  })

  it('refuses to prompt when session creation does not report deny-all rules', async () => {
    const { delegator, input, api } = setup({ omitCreatePermissions: true })
    const result = await delegator.delegate(input)
    expect(result).toMatchObject({ status: 'failed', error: expect.stringContaining('did not confirm deny-all') })
    expect(api.session.prompt).not.toHaveBeenCalled()
    expect(api.session.update).toHaveBeenCalledWith({
      sessionID: 'session-1', permissions: [{ action: '*', resource: '*', effect: 'deny' }],
    }, { signal: expect.any(AbortSignal) })
  })

  it('fails closed when session.get omits the permission rules', async () => {
    const { delegator, input, api } = setup({ omitGetPermissions: true })
    const result = await delegator.delegate(input)
    expect(result).toMatchObject({ status: 'failed', error_code: 'permission_reset_failed' })
    expect(api.session.prompt).toHaveBeenCalledOnce()
  })

  it('subscribes to permission events before opening the per-call permission policy', async () => {
    const { delegator, input, api, calls } = setup()
    await delegator.delegate(input)
    const activePolicyIndex = calls.update.findIndex((request) =>
      (request as { permissions?: { effect: string }[] }).permissions?.some((rule) => rule.effect === 'ask'),
    )
    expect(api.event.subscribe.mock.invocationCallOrder[0]).toBeLessThan(
      api.session.update.mock.invocationCallOrder[activePolicyIndex],
    )
  })

  it('approves an in-scope permission once and rejects an out-of-scope path', async () => {
    const { delegator, input, api } = setup({ permissionRequests: [
      { id: 'permission-1', sessionID: 'session-1', action: 'read', resources: ['inside.txt'] },
      { id: 'permission-2', sessionID: 'session-1', action: 'edit', resources: ['../outside.txt'] },
    ] })
    await delegator.delegate(input)
    expect(api.permission.reply).toHaveBeenNthCalledWith(1, {
      sessionID: 'session-1', requestID: 'permission-1', decision: 'once',
    }, { signal: expect.any(AbortSignal) })
    expect(api.permission.reply).toHaveBeenNthCalledWith(2, {
      sessionID: 'session-1', requestID: 'permission-2', decision: 'reject',
      message: 'Blocked by the per-task permission scope.',
    }, { signal: expect.any(AbortSignal) })
  })

  it.each(['caller cancellation', 'task timeout', 'shutdown'] as const)(
    'passes an abort signal to permission.reply and stops waiting on %s', async (cause) => {
      if (cause === 'task timeout') vi.useFakeTimers()
      let notifyReplyStarted!: () => void
      const replyStarted = new Promise<void>((resolve) => { notifyReplyStarted = resolve })
      let replySignal: AbortSignal | undefined
      let releaseReply!: () => void
      const { delegator, input, api } = setup({
        prompt: () => new Promise(() => {}), promptTimeoutMs: 50,
        permissionRequests: [{ id: 'permission-hang', sessionID: 'session-1', action: 'read', resources: ['inside.txt'] }],
        hangPermissionReply: 'honor-signal',
        onPermissionReplyStart: (signal, release) => { replySignal = signal; releaseReply = release; notifyReplyStarted() },
      })
      const caller = new AbortController()
      try {
        const task = delegator.delegate(input, cause === 'caller cancellation' ? caller.signal : undefined)
        await replyStarted
        expect(replySignal).toBeInstanceOf(AbortSignal)
        if (cause === 'caller cancellation') caller.abort()
        if (cause === 'task timeout') await vi.advanceTimersByTimeAsync(50)
        if (cause === 'shutdown') delegator.beginShutdown(Date.now() + 10_000)

        const result = await task
        expect(replySignal?.aborted).toBe(true)
        expect(api.permission.reply).toHaveBeenCalledOnce()
        expect(result.status).toBe(cause === 'task timeout' ? 'failed' : 'canceled')
        if (cause === 'task timeout') expect(result.error_code).toBe('task_timeout')
        expect(api.session.interrupt).toHaveBeenCalledOnce()
      } finally {
        releaseReply?.()
        if (cause === 'task timeout') vi.useRealTimers()
      }
    },
  )

  it('keeps an ignored permission.reply in flight through task timeout and quarantines after bounded cleanup', async () => {
    vi.useFakeTimers()
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
    let notifyReplyStarted!: () => void
    const replyStarted = new Promise<void>((resolve) => { notifyReplyStarted = resolve })
    let replySignal: AbortSignal | undefined
    let releaseReply!: () => void
    let rejectReply!: () => void
    try {
      const { delegator, input, api } = setup({
        prompt: () => new Promise(() => {}), promptTimeoutMs: 50,
        permissionRequests: [
          { id: 'permission-late', sessionID: 'session-1', action: 'read', resources: ['inside.txt'] },
          { id: 'permission-late-queued', sessionID: 'session-1', action: 'edit', resources: ['inside.txt'] },
        ],
        hangPermissionReply: 'ignore-signal',
        onPermissionReplyStart: (signal, release, reject) => { replySignal = signal; releaseReply = release; rejectReply = reject; notifyReplyStarted() },
      })
      const task = delegator.delegate(input)
      await replyStarted
      for (let i = 0; i < 12; i++) await Promise.resolve()
      expect(api.session.prompt).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(4_000)
      const result = await task

      expect(replySignal?.aborted).toBe(true)
      expect(result).toMatchObject({ status: 'failed', error_code: 'permission_reset_failed' })
      expect(result.error).toContain('OpenCode task deadline exceeded.')
      expect(api.session.interrupt).toHaveBeenCalledOnce()
      expect(api.permission.reply).toHaveBeenCalledOnce()
      await expect(delegator.delegate({ ...input, context_id: result.context_id }))
        .rejects.toMatchObject({ errorCode: 'session_quarantined' })

      rejectReply()
      await vi.advanceTimersByTimeAsync(0)
      expect(api.permission.reply).toHaveBeenCalledOnce()
      const lateFailure = stderr.mock.calls
        .map(([line]) => JSON.parse(String(line)) as Record<string, any>)
        .find((entry) => entry.event === 'permission_reply_late_failed')
      expect(lateFailure).toMatchObject({ status: 'failed', errorClass: 'unknown' })
      await expect(delegator.delegate({ ...input, context_id: result.context_id }))
        .rejects.toMatchObject({ errorCode: 'session_quarantined' })
    } finally {
      releaseReply?.()
      stderr.mockRestore()
      vi.useRealTimers()
    }
  })

  it('logs a late successful permission reply without processing queued asks after cancellation', async () => {
    vi.useFakeTimers()
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
    let notifyReplyStarted!: () => void
    const replyStarted = new Promise<void>((resolve) => { notifyReplyStarted = resolve })
    let releaseReply!: () => void
    try {
      const { delegator, input, api } = setup({
        prompt: () => new Promise(() => {}), promptTimeoutMs: 50,
        permissionRequests: [
          { id: 'permission-late-success', sessionID: 'session-1', action: 'read', resources: ['inside.txt'] },
          { id: 'permission-success-queued', sessionID: 'session-1', action: 'edit', resources: ['inside.txt'] },
        ],
        hangPermissionReply: 'ignore-signal',
        onPermissionReplyStart: (_signal, release) => { releaseReply = release; notifyReplyStarted() },
      })
      const task = delegator.delegate(input)
      await replyStarted
      for (let i = 0; i < 12; i++) await Promise.resolve()
      await vi.advanceTimersByTimeAsync(4_000)
      await task
      releaseReply()
      await vi.advanceTimersByTimeAsync(0)

      const lateSuccess = stderr.mock.calls
        .map(([line]) => JSON.parse(String(line)) as Record<string, any>)
        .find((entry) => entry.event === 'permission_reply_late_completed')
      expect(lateSuccess).toMatchObject({ status: 'success' })
      expect(api.permission.reply).toHaveBeenCalledOnce()
    } finally {
      releaseReply?.()
      stderr.mockRestore()
      vi.useRealTimers()
    }
  })

  it('re-evaluates permissions for every call after restoring a context', async () => {
    const { delegator, input, api } = setup({ permissionRequests: [
      { id: 'permission-edit', sessionID: 'session-1', action: 'edit', resources: ['inside.txt'] },
    ] })
    const first = await delegator.delegate(input)
    const second = await delegator.delegate({
      ...input,
      context_id: first.context_id,
      permission_scope: { fileAccess: 'read_only', shellCommands: [] },
    })

    expect(second).toMatchObject({ status: 'rejected', error_code: 'permission_rejected' })
    expect(api.permission.reply).toHaveBeenNthCalledWith(1, {
      sessionID: 'session-1', requestID: 'permission-edit', decision: 'once',
    }, { signal: expect.any(AbortSignal) })
    expect(api.permission.reply).toHaveBeenNthCalledWith(2, {
      sessionID: 'session-1', requestID: 'permission-edit', decision: 'reject',
      message: 'Blocked by the per-task permission scope.',
    }, { signal: expect.any(AbortSignal) })
  })

  it.each([1, 2])('preserves quota details before checking empty content (run %i)', async () => {
    const { delegator, input, api } = setup()
    api.message.list.mockImplementation(async () => ({ data: [{
      id: 'assistant-1', type: 'assistant', finish: 'error',
      error: { type: 'provider.quota', status: 402, message: 'Insufficient funds' }, content: [],
    }, { id: 'user-1', type: 'user', text: 'Make a change' }], cursor: {} } as never))
    const result = await delegator.delegate(input)
    expect(result).toMatchObject({ status: 'failed', error_code: 'provider_quota' })
    expect(result.error).toContain('provider.quota')
    expect(result.error).toContain('402')
    expect(result.error).toContain('Insufficient funds')
  })

  it.each([1, 2])('refuses an old assistant when the current user boundary is absent (run %i)', async () => {
    const { delegator, input, api } = setup()
    api.message.list.mockImplementation(async () => ({ data: [
      { id: 'assistant-old', type: 'assistant', finish: 'stop', content: [{ type: 'text', text: 'OLD-HISTORY' }] },
      { id: 'user-old', type: 'user', text: 'Earlier task' },
    ], cursor: {} } as never))
    const result = await delegator.delegate(input)
    expect(result).toMatchObject({ status: 'failed', error_code: 'turn_unmatched' })
    expect(result.error).toContain('newer user message')
  })

  it('follows message.list cursor.next pages to find the current user boundary', async () => {
    const { delegator, input, api } = setup()
    api.message.list.mockImplementation(async ({ cursor }: { cursor?: string }) => cursor
      ? ({ data: [{ id: 'user-1', type: 'user', text: 'Make a change' }], cursor: {} } as never)
      : ({ data: [
          { id: 'assistant-1', type: 'assistant', finish: 'stop', content: [{ type: 'text', text: 'paged result' }] },
          ...Array.from({ length: 99 }, (_, index) => ({ id: `old-${index}`, type: 'system' })),
        ], cursor: { next: 'older-page' } } as never))
    const result = await delegator.delegate(input)
    expect(result).toMatchObject({ status: 'completed', result: 'paged result' })
    expect(api.message.list).toHaveBeenCalledTimes(2)
    expect(api.message.list).toHaveBeenLastCalledWith({ sessionID: 'session-1', limit: 100, cursor: 'older-page' }, { signal: expect.any(AbortSignal) })
  })

  it('uses the last assistant step as the final response', async () => {
    const { delegator, input } = setup({ steps: [
      { id: 'assistant-step-1', finish: 'tool-calls', text: 'intermediate tool note' },
      { id: 'assistant-step-2', finish: 'stop', text: 'final answer' },
    ] })
    const result = await delegator.delegate(input)
    expect(result).toMatchObject({ status: 'completed', result: 'final answer' })
  })

  it.each([1, 2])('waits briefly for a step event that trails session.wait (run %i)', async () => {
    const { delegator, input } = setup({ stepDelayMs: 70 })
    const result = await delegator.delegate(input)
    expect(result).toMatchObject({ status: 'completed', result: 'done' })
  })

  it.each([1, 2])('does not return text from a nonterminal tool-calls step (run %i)', async () => {
    const { delegator, input } = setup({ steps: [{ id: 'assistant-tool', finish: 'tool-calls', text: 'intermediate text' }] })
    const result = await delegator.delegate(input)
    expect(result).toMatchObject({ status: 'failed', error_code: 'turn_unmatched' })
  })

  it.each([404, 500])('classifies permission reply HTTP %i without invalidating the service and stops queued replies', async (status) => {
    let promptStarted!: () => void
    const prompt = new Promise<void>((resolve) => { promptStarted = resolve })
    const { delegator, input, api, server } = setup({
      promptTimeoutMs: 3000,
      onPromptStart: promptStarted,
      permissionRequests: [
        { id: 'permission-http', sessionID: 'session-1', action: 'read', resources: ['inside.txt'] },
        { id: 'permission-queued', sessionID: 'session-1', action: 'edit', resources: ['inside.txt'] },
      ],
    })
    api.permission.reply.mockImplementationOnce(async () => {
      await prompt
      throw new ClientError('UnexpectedStatus', { cause: { status }, detail: String(status) })
    })
    const result = await delegator.delegate({ ...input, context_id: 'reply-http-context' })

    expect(result).toMatchObject({ status: 'failed', error_code: 'permission_reply_failed' })
    expect(result.error).toContain(`HTTP ${status}`)
    expect(result.error).toContain('http_status')
    expect(api.permission.reply).toHaveBeenCalledOnce()
    expect(server.invalidate).not.toHaveBeenCalled()
    await expect(delegator.delegate({ ...input, context_id: result.context_id }))
      .rejects.toMatchObject({ errorCode: 'session_quarantined' })
  })

  it('classifies a synchronous permission.reply throw as a permission failure and stops queued replies', async () => {
    const { delegator, input, api } = setup({ promptTimeoutMs: 3000, permissionRequests: [
      { id: 'permission-sync', sessionID: 'session-1', action: 'read', resources: ['inside.txt'] },
      { id: 'permission-sync-queued', sessionID: 'session-1', action: 'edit', resources: ['inside.txt'] },
    ] })
    api.permission.reply.mockImplementationOnce(() => {
      throw new ClientError('UnexpectedStatus', { cause: { status: 404 }, detail: 'SENSITIVE_SYNC_FAILURE' })
    })
    const result = await delegator.delegate({ ...input, context_id: 'sync-reply-context' })

    expect(result).toMatchObject({ status: 'failed', error_code: 'permission_reply_failed' })
    expect(result.error).toContain('HTTP 404')
    expect(api.permission.reply).toHaveBeenCalledOnce()
  })

  it('preserves permission HTTP failure while prioritizing a real permission cleanup failure', async () => {
    const { delegator, input, api } = setup({ promptTimeoutMs: 3000, failPermissionReset: true, permissionRequests: [
      { id: 'permission-cleanup-failure', sessionID: 'session-1', action: 'read', resources: ['inside.txt'] },
    ] })
    api.permission.reply.mockRejectedValueOnce(new ClientError('UnexpectedStatus', {
      cause: { status: 404 }, detail: 'SENSITIVE_REPLY_DETAIL',
    }))
    const result = await delegator.delegate({ ...input, context_id: 'reply-cleanup-context' })

    expect(result).toMatchObject({ status: 'failed', error_code: 'permission_reset_failed' })
    expect(result.error).toContain('HTTP 404')
    expect(result.error).toContain('Cleanup could not be fully verified')
    await expect(delegator.delegate({ ...input, context_id: result.context_id }))
      .rejects.toMatchObject({ errorCode: 'session_quarantined' })
  })

  it('retains the context lease when permission quarantine persistence fails', async () => {
    const { delegator, input, api } = setup({ promptTimeoutMs: 3000, permissionRequests: [
      { id: 'permission-persist-failure', sessionID: 'session-1', action: 'read', resources: ['inside.txt'] },
    ] })
    api.permission.reply.mockRejectedValueOnce(new ClientError('UnexpectedStatus', {
      cause: { status: 404 }, detail: 'SENSITIVE_REPLY_DETAIL',
    }))
    const store = (delegator as unknown as { contextStore: { quarantineAndRelease: (...args: unknown[]) => void } }).contextStore
    store.quarantineAndRelease = () => { throw new Error('forced quarantine persistence failure') }
    const result = await delegator.delegate({ ...input, context_id: 'reply-persist-context' })

    expect(result).toMatchObject({ status: 'failed', error_code: 'context_store_failed' })
    expect(result.error).toContain('HTTP 404')
    expect(result.error).toContain('could not be safely persisted')
    await expect(delegator.delegate({ ...input, context_id: result.context_id }))
      .rejects.toMatchObject({ errorCode: 'context_busy' })
  })

  it('classifies a permission reply transport failure without exposing SDK error text', async () => {
    let promptStarted!: () => void
    const prompt = new Promise<void>((resolve) => { promptStarted = resolve })
    const { delegator, input, api, server } = setup({
      onPromptStart: promptStarted,
      permissionRequests: [{ id: 'permission-transport', sessionID: 'session-1', action: 'read', resources: ['inside.txt'] }],
    })
    api.permission.reply.mockImplementationOnce(async () => {
      await prompt
      throw new ClientError('Transport', { cause: new Error('SENSITIVE_TRANSPORT_CAUSE') })
    })
    const result = await delegator.delegate({ ...input, context_id: 'reply-transport-context' })

    expect(result).toMatchObject({ status: 'failed', error_code: 'permission_reply_failed' })
    expect(result.error).toContain('[transport]')
    expect(result.error).not.toContain('SENSITIVE_TRANSPORT_CAUSE')
    expect(server.invalidate).toHaveBeenCalledWith('http://127.0.0.1:4096')
    await expect(delegator.delegate({ ...input, context_id: result.context_id }))
      .rejects.toMatchObject({ errorCode: 'session_quarantined' })
  })

  it('logs permission reply lifecycle as valid redacted JSON with safe correlation fields', async () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { delegator, input, api } = setup({ promptTimeoutMs: 3000, permissionRequests: [{
        id: 'SENSITIVE_REQUEST_ID', sessionID: 'session-1', action: 'shell',
        resources: ['SENSITIVE_SHELL_COMMAND'], message: 'SENSITIVE_PERMISSION_MESSAGE',
        source: { type: 'tool', messageID: 'SENSITIVE_TOOL_MESSAGE', id: 'SENSITIVE_TOOL_ID' },
      }] })
      api.permission.reply.mockRejectedValueOnce(new ClientError('UnexpectedStatus', {
        cause: { status: 404 }, detail: 'SENSITIVE_ERROR_DETAIL',
      }))
      const result = await delegator.delegate({
        ...input, context_id: 'SENSITIVE_CONTEXT_ID', task: 'SENSITIVE_TASK_BODY',
        permission_scope: { fileAccess: 'read_only', shellCommands: ['SENSITIVE_ALLOWED_COMMAND'] },
      })
      const entries = stderr.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, any>)
      const asked = entries.find((entry) => entry.event === 'permission_asked')
      const started = entries.find((entry) => entry.event === 'permission_reply_started')
      const completed = entries.find((entry) => entry.event === 'permission_reply_completed')
      const cleanup = entries.find((entry) => entry.event === 'task_cleanup_complete')
      const json = JSON.stringify(entries)

      expect(result.error_code).toBe('permission_reply_failed')
      if (!asked || !started || !completed || !cleanup) throw new Error('Missing lifecycle diagnostic event')
      expect(asked).toMatchObject({
        process: { pid: process.pid, version: '0.1.0', runtime: process.version },
        service: { source: 'shared', identity: { id: 'test-service', pid: 456, url: 'http://127.0.0.1:4096' } },
        scope: { fileAccess: 'read_only', allowedShellCount: 1 }, decision: 'reject',
      })
      expect(asked.request).not.toBe('SENSITIVE_REQUEST_ID')
      expect(started).toHaveProperty('monotonicMs')
      expect(started.deadlineRemainingMs).toEqual(expect.any(Number))
      expect(completed).toMatchObject({ status: 404, errorClass: 'http_status' })
      expect(completed.durationMs).toEqual(expect.any(Number))
      expect(cleanup).toHaveProperty('cleanup.quarantined', true)
      for (const secret of [
        'SENSITIVE_REQUEST_ID', 'SENSITIVE_SHELL_COMMAND', 'SENSITIVE_PERMISSION_MESSAGE',
        'SENSITIVE_TOOL_MESSAGE', 'SENSITIVE_TOOL_ID', 'SENSITIVE_ERROR_DETAIL',
        'SENSITIVE_CONTEXT_ID', 'SENSITIVE_TASK_BODY', 'SENSITIVE_ALLOWED_COMMAND',
      ]) {
        expect(json).not.toContain(secret)
      }
      expect(entries.every((entry) => typeof entry.component === 'string' && typeof entry.event === 'string')).toBe(true)
    } finally {
      stderr.mockRestore()
    }
  })

  it.each([1, 2])('classifies a clean event stream EOF as failure (run %i)', async () => {
    const { delegator, input } = setup({ eventMode: 'eof' })
    const result = await delegator.delegate(input)
    expect(result).toMatchObject({ status: 'failed', error_code: 'event_stream_failed' })
  })

  it.each([1, 2])('classifies an event stream disconnect as failure (run %i)', async () => {
    const { delegator, input } = setup({ eventMode: 'disconnect' })
    const result = await delegator.delegate(input)
    expect(result).toMatchObject({ status: 'failed', error_code: 'event_stream_failed' })
  })

  it('invalidates the old server/client cache after an event EOF and uses the rediscovered endpoint next time', async () => {
    const { delegator, input, server, options, clientUrls } = setup({ eventMode: 'eof' })
    const first = await delegator.delegate(input)
    expect(first).toMatchObject({ status: 'failed', error_code: 'event_stream_failed' })
    expect(first.server_url).toBe('http://127.0.0.1:4096')
    expect(server.invalidate).toHaveBeenCalledWith('http://127.0.0.1:4096')
    options.eventMode = undefined

    const second = await delegator.delegate({ ...input, context_id: first.context_id })
    expect(second).toMatchObject({ status: 'completed', result: 'done' })
    expect(clientUrls).toEqual(['http://127.0.0.1:4096', 'http://127.0.0.1:4097'])
  })

  it('quarantines a session when the event connection drops after prompt submission and never replays it', async () => {
    const { delegator, input, api } = setup({ eventMode: 'disconnect-after-prompt' })
    const first = await delegator.delegate(input)
    expect(first).toMatchObject({ status: 'failed', error_code: 'session_quarantined' })
    await expect(delegator.delegate({ ...input, context_id: first.context_id })).rejects.toMatchObject({ errorCode: 'session_quarantined' })
    expect(api.session.prompt).toHaveBeenCalledOnce()
  })

  it('does not mistake an event stream AbortError for a caller cancellation', async () => {
    const { delegator, input } = setup({ eventMode: 'abort-error' })
    const result = await delegator.delegate(input)
    expect(result).toMatchObject({ status: 'failed', error_code: 'event_stream_failed' })
  })

  it.each([1, 2])('clears failed client initialization so the next task can retry (run %i)', async () => {
    const { delegator, input, api } = setup({ clientFailures: 1 })
    const first = await delegator.delegate(input)
    expect(first.status).toBe('failed')
    const second = await delegator.delegate({ ...input, context_id: first.context_id })
    expect(second).toMatchObject({ status: 'completed', result: 'done' })
    expect(api.session.create).toHaveBeenCalledOnce()
  })

  it.each([1, 2])('quarantines when deny reset ignores its cleanup signal (run %i)', async () => {
    vi.useFakeTimers()
    let notifyResetStarted!: () => void
    const resetStarted = new Promise<void>((resolve) => { notifyResetStarted = resolve })
    try {
      const { delegator, api, input } = setup({
        hangPermissionReset: true,
        onPermissionResetStart: () => notifyResetStarted(),
      })
      const resultPromise = delegator.delegate(input)
      await resetStarted
      await vi.advanceTimersByTimeAsync(10_000)
      const result = await resultPromise
      expect(result).toMatchObject({ status: 'failed', error_code: 'permission_reset_failed' })
      await expect(delegator.delegate({ ...input, context_id: result.context_id }))
        .rejects.toMatchObject({ errorCode: 'session_quarantined' })
      expect(api.session.prompt).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([1, 2])('still attempts deny reset when the event pump ignores abort (run %i)', async () => {
    vi.useFakeTimers()
    let notifyPumpHung!: () => void
    const pumpHung = new Promise<void>((resolve) => { notifyPumpHung = resolve })
    try {
      const { delegator, api, input } = setup({ eventMode: 'hang', onEventPumpHang: () => notifyPumpHung() })
      const task = delegator.delegate(input)
      let settled = false
      void task.then(() => { settled = true })
      await pumpHung
      for (let attempt = 0; attempt < 10 && !settled; attempt++) await vi.advanceTimersByTimeAsync(1_000)
      const result = await task
      expect(result).toMatchObject({ status: 'failed', error_code: 'permission_reset_failed' })
      expect(api.session.update).toHaveBeenLastCalledWith({
        sessionID: 'session-1', permissions: [{ action: '*', resource: '*', effect: 'deny' }],
      }, { signal: expect.any(AbortSignal) })
      expect(api.session.get).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([1, 2])('quarantines if an open permission update completes after reset (run %i)', async () => {
    vi.useFakeTimers()
    let notifyUpdateStarted!: () => void
    const updateStarted = new Promise<void>((resolve) => { notifyUpdateStarted = resolve })
    let releaseLateUpdate!: () => void
    try {
      const { delegator, api, input } = setup({
        hangTaskPermissionUpdate: true,
        onTaskPermissionUpdateStart: (release) => { releaseLateUpdate = release; notifyUpdateStarted() },
      })
      const task = delegator.delegate(input)
      await updateStarted
      await vi.advanceTimersByTimeAsync(20)
      let settled = false
      void task.then(() => { settled = true })
      for (let attempt = 0; attempt < 5 && !settled; attempt++) await vi.advanceTimersByTimeAsync(1_000)
      const result = await task
      expect(result).toMatchObject({ status: 'failed', error_code: 'permission_reset_failed' })
      expect(api.session.update).toHaveBeenLastCalledWith({
        sessionID: 'session-1', permissions: [{ action: '*', resource: '*', effect: 'deny' }],
      }, { signal: expect.any(AbortSignal) })
      releaseLateUpdate()
      await expect(delegator.delegate({ ...input, context_id: result.context_id }))
        .rejects.toMatchObject({ errorCode: 'session_quarantined' })
      expect(api.session.prompt).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

it('reconciles a 404 permission reply with a rejecting event as permission_rejected and allows the context to resume', async () => {
  let resolvePrompt!: () => void
  const promptStarted = new Promise<void>((resolve) => { resolvePrompt = resolve })
  const { delegator, input, api, options, pushEvent } = setup({
    promptTimeoutMs: 3000,
    onPromptStart: resolvePrompt,
    permissionRequests: [{
      id: 'r1', sessionID: 'session-1', action: 'read', resources: ['inside.txt'],
      source: { type: 'tool', messageID: 'assistant-1', id: 'tool-1' },
    }],
  })
  api.permission.reply.mockImplementationOnce(async () => {
    await promptStarted
    setTimeout(() => pushEvent({
      type: 'permission.replied',
      data: { sessionID: 'session-1', requestID: 'r1', reply: 'reject' },
    }), 10)
    throw new ClientError('UnexpectedStatus', { cause: { status: 404 }, detail: '404' })
  })

  const result = await delegator.delegate(input)
  expect(result).toMatchObject({ status: 'rejected', error_code: 'permission_rejected' })
  expect(result.status).not.toBe('failed')

  options.permissionRequests = []
  const resumed = await delegator.delegate({ ...input, context_id: result.context_id })
  expect(resumed).toMatchObject({ status: 'completed', result: 'done' })
})

it('treats a PermissionNotFoundError 404 with a rejecting event as permission_rejected and allows the context to resume', async () => {
  let resolvePrompt!: () => void
  const promptStarted = new Promise<void>((resolve) => { resolvePrompt = resolve })
  const { delegator, input, api, options, pushEvent } = setup({
    promptTimeoutMs: 3000,
    onPromptStart: resolvePrompt,
    permissionRequests: [{
      id: 'r1', sessionID: 'session-1', action: 'read', resources: ['inside.txt'],
      source: { type: 'tool', messageID: 'assistant-1', id: 'tool-1' },
    }],
  })
  api.permission.reply.mockImplementationOnce(async () => {
    await promptStarted
    setTimeout(() => pushEvent({
      type: 'permission.replied',
      data: { sessionID: 'session-1', requestID: 'r1', reply: 'reject' },
    }), 10)
    throw { _tag: 'PermissionNotFoundError', requestID: 'r1' }
  })

  const result = await delegator.delegate(input)
  expect(result).toMatchObject({ status: 'rejected', error_code: 'permission_rejected' })
  expect(result.status).not.toBe('failed')

  options.permissionRequests = []
  const resumed = await delegator.delegate({ ...input, context_id: result.context_id })
  expect(resumed).toMatchObject({ status: 'completed', result: 'done' })
})

it('rejects a batch of queued permission asks after the first reply and stops the rest', async () => {
  let resolvePrompt!: () => void
  const promptStarted = new Promise<void>((resolve) => { resolvePrompt = resolve })
  const { delegator, input, api, pushEvent } = setup({
    promptTimeoutMs: 3000,
    onPromptStart: resolvePrompt,
    permissionRequests: [
      { id: 'shell', sessionID: 'session-1', action: 'shell', resources: ['node unapproved'] },
      { id: 'rA', sessionID: 'session-1', action: 'read', resources: ['inside.txt'] },
      { id: 'rB', sessionID: 'session-1', action: 'read', resources: ['inside.txt'] },
    ],
  })
  api.permission.reply.mockImplementationOnce(async () => {
    await promptStarted
    pushEvent({ type: 'permission.replied', data: { sessionID: 'session-1', requestID: 'shell', reply: 'reject' } })
    pushEvent({ type: 'permission.replied', data: { sessionID: 'session-1', requestID: 'rA', reply: 'reject' } })
    pushEvent({ type: 'permission.replied', data: { sessionID: 'session-1', requestID: 'rB', reply: 'reject' } })
    return {}
  })

  const result = await delegator.delegate({
    ...input,
    permission_scope: { fileAccess: 'read_only', shellCommands: ['node --version'] },
  })
  expect(result).toMatchObject({ status: 'rejected', error_code: 'permission_rejected' })
  expect(api.permission.reply).toHaveBeenCalledOnce()
  expect(api.session.prompt).toHaveBeenCalledOnce()
})

it('quarantines when a typed PermissionNotFoundError names a different request', async () => {
  let resolvePrompt!: () => void
  const promptStarted = new Promise<void>((resolve) => { resolvePrompt = resolve })
  const { delegator, input, api, pushEvent } = setup({
    promptTimeoutMs: 3000,
    onPromptStart: resolvePrompt,
    permissionRequests: [
      { id: 'r1', sessionID: 'session-1', action: 'read', resources: ['inside.txt'] },
    ],
  })
  api.permission.reply.mockImplementationOnce(async () => {
    await promptStarted
    pushEvent({ type: 'permission.replied', data: { sessionID: 'session-1', requestID: 'r1', reply: 'reject' } })
    throw { _tag: 'PermissionNotFoundError', requestID: 'different' }
  })

  const result = await delegator.delegate(input)
  expect(result).toMatchObject({ status: 'failed', error_code: 'permission_reply_failed' })
  await expect(delegator.delegate({ ...input, context_id: result.context_id }))
    .rejects.toMatchObject({ errorCode: 'session_quarantined' })
})
