import { createHash, randomUUID } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { ClientError, type OpenCodeClient } from '@opencode/client'
import type { AppConfig } from './config.js'
import { ContextStore, ContextStoreError } from './context-store.js'
import type { PermissionScope } from './permission-policy.js'
import { OpenCodeServerError, OpenCodeServerManager } from './opencode-server.js'
import { guardSdkClient, OpenCodeSdkAdapter } from './opencode-sdk-adapter.js'
import { PermissionLockError, SessionPermissionGuard, hasPermissionRules } from './session-permission-guard.js'
import { PermissionReplyQueue } from './permission-reply-queue.js'
import { findCurrentAssistant, TurnEvidence } from './turn-result-matcher.js'
import { cleanupReceipt, cleanupTask, type TaskCleanupReceipt, type InterruptSource } from './task-cleanup.js'
import { awaitBefore, cleanupCall, raceAbort, trackOperation } from './deadline.js'
import { DelegationError, type DelegateInput, type DelegateOutput } from './delegation-types.js'

export type { DelegateInput, DelegateOutput } from './delegation-types.js'
export { DelegationError } from './delegation-types.js'

type ActiveContext = { controller: AbortController; abortSource: InterruptSource; sessionId?: string; done: Promise<void>; finish: () => void; shutdownRequested: boolean; shutdownCleanupDeadline?: number; shutdownCleanupController?: AbortController; cleanupControllers: Set<AbortController>; shutdownCleanupTimer?: ReturnType<typeof setTimeout> }

export class OpenCodeDelegator {
  private readonly contextStore: ContextStore
  private readonly active = new Map<string, ActiveContext>()
  private readonly sdk: OpenCodeSdkAdapter
  private readonly permissionGuard = new SessionPermissionGuard()
  private closed = false
  private closePromise: Promise<void> | undefined
  private shutdownDeadline: number | undefined
  private shutdownCleanupDeadline: number | undefined
  private shutdownCleanupFailures = 0

  constructor(
    private readonly server: OpenCodeServerManager,
    private readonly config: Pick<AppConfig, 'opencodeCommand' | 'model' | 'promptTimeoutMs' | 'contextStorePath'>,
    createClient?: (baseUrl: string, headers: HeadersInit) => OpenCodeClient,
    private readonly prepareForTask?: (deadline: number, signal: AbortSignal) => Promise<void>,
  ) {
    this.contextStore = new ContextStore(config.contextStorePath)
    this.sdk = new OpenCodeSdkAdapter(
      () => server.baseUrl,
      () => server.headers,
      createClient ?? (() => { throw new Error('Production must use shared client') }),
      (url) => server.invalidate(url),
      createClient ? undefined : async () => {
        const connected = await server.connect()
        return guardSdkClient(connected.client, () => server.assertIdentity(connected.identity))
      },
    )
  }

  async delegate(input: DelegateInput, signal?: AbortSignal): Promise<DelegateOutput> {
    const contextId = input.context_id ?? randomUUID()
    if (this.closed) throw new DelegationError('OpenCode delegator is closed.')
    if (!input.task.trim()) throw new DelegationError('task must not be empty.')
    if (signal?.aborted) return { status: 'canceled', context_id: contextId, error: 'Task was canceled.' }

    const workspaceRoot = resolveWorkspace(input.workspace_root)
    const model = parseModel(input.model ?? this.config.model)
    if (this.active.has(contextId)) {
      throw new DelegationError('Another OpenCode task owns this context_id.', undefined, 'context_busy')
    }

    const deadline = Date.now() + this.config.promptTimeoutMs
    const leaseToken = randomUUID()
    const existing = this.contextStore.acquireLease(contextId, workspaceRoot, leaseToken, deadline)

    const own = new AbortController()
    let finishActive!: () => void
    const activeDone = new Promise<void>((resolve) => { finishActive = resolve })
    const active: ActiveContext = { controller: own, abortSource: 'unknown', done: activeDone, finish: finishActive, shutdownRequested: false, shutdownCleanupController: new AbortController(), cleanupControllers: new Set(), ...(existing && { sessionId: existing.sessionId }) }
    this.active.set(contextId, active)
    const inFlight = new Set<Promise<unknown>>()
    const call = <T>(promise: Promise<T>): Promise<T> => raceAbort(trackOperation(promise, inFlight), own.signal)
    const onCallerAbort = () => { if (!own.signal.aborted) active.abortSource = 'caller_cancel'; own.abort(signal?.reason ?? new DOMException('Task was canceled.', 'AbortError')) }
    signal?.addEventListener('abort', onCallerAbort, { once: true })

    let api: OpenCodeClient | undefined
    let clientBaseUrl: string | undefined
    let sessionId = existing?.sessionId
    let eventController: AbortController | undefined
    const abortEventPump = () => eventController?.abort(own.signal.reason)
    own.signal.addEventListener('abort', abortEventPump, { once: true })
    let eventPump: Promise<void> | undefined
    let eventStreamError: unknown
    let permissionReplyFailure: PermissionReplyFailure | undefined
    const turnEvidence = new TurnEvidence()
    let timedOut = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    let result: DelegateOutput | undefined
    let receipt: TaskCleanupReceipt = cleanupReceipt({ idleVerified: false, denyAllVerified: false, quarantined: false, leaseRetained: true, leaseReleased: false, errors: [] })
    let keepQuarantined = false
    let quarantineCode: string | undefined
    let quarantineMessage: string | undefined
    let sessionCreateStarted = false
    let promptSubmissionStarted = false
    let preparationInFlight: Promise<void> | undefined
    timeout = setTimeout(() => {
      timedOut = true
      if (!own.signal.aborted) active.abortSource = 'task_timeout'
      own.abort(new DOMException('OpenCode task deadline exceeded.', 'TimeoutError'))
    }, Math.max(0, deadline - Date.now()))

    try {
      if (this.prepareForTask) {
        preparationInFlight = this.prepareForTask(deadline, own.signal).finally(() => { preparationInFlight = undefined })
        await call(preparationInFlight)
      }
      await call(this.server.ensureReady())
      clientBaseUrl = this.server.baseUrl
      api = await call(this.sdk.getClient())
      if (!sessionId) {
        sessionCreateStarted = true
        const session = await call(api.session.create({
          title: titleForTask(input.task),
          agent: 'build',
          model,
          location: { directory: workspaceRoot },
          permissions: this.permissionGuard.lockedRules(),
        }, { signal: own.signal }))
        sessionId = session.id
        active.sessionId = sessionId
        this.contextStore.bindLease(contextId, leaseToken, sessionId)
        this.contextStore.create({ contextId, sessionId, workspaceRoot })
        if (!hasPermissionRules(session.permissions, this.permissionGuard.lockedRules())) {
          keepQuarantined = true
          quarantineCode = 'permission_reset_failed'
          quarantineMessage = 'OpenCode did not confirm deny-all permissions when creating the session.'
          throw new DelegationError('OpenCode did not confirm deny-all permissions when creating the session.')
        }
      } else {
        let session: Awaited<ReturnType<OpenCodeClient['session']['get']>>
        try {
          session = await this.permissionGuard.lockSession(api, sessionId, own.signal, call)
        } catch (cause) {
          if (cause instanceof PermissionLockError) {
            keepQuarantined = true
            quarantineCode = 'permission_reset_failed'
            quarantineMessage = 'OpenCode did not confirm deny-all permissions before reusing the session.'
            throw new DelegationError(cause.message, { cause }, 'permission_reset_failed')
          }
          throw new DelegationError(
            'The OpenCode session for this context_id is missing or inaccessible. Verify OpenCode is reachable; if the session was deleted, start a new context_id.',
            { cause },
          )
        }
        if (normalizePath(session.location.directory) !== normalizePath(workspaceRoot)) {
          throw new DelegationError('The stored OpenCode session belongs to a different workspace_root.')
        }
        await call(api.session.switchModel({ sessionID: sessionId, model }, { signal: own.signal }))
      }
      if (own.signal.aborted) throw own.signal.reason

      let drainPermissions: () => Promise<void> = () => Promise.resolve()
      eventController = new AbortController()
      let eventReadyResolve!: () => void
      let eventReadyReject!: (error: unknown) => void
      const eventReady = new Promise<void>((resolve, reject) => {
        eventReadyResolve = resolve
        eventReadyReject = reject
      })
      eventPump = this.watchEvents(api, sessionId, input.permission_scope, workspaceRoot, eventController.signal,
        (error, kind) => {
          if (!own.signal.aborted) active.abortSource = kind === 'permission' ? 'permission_reply_failure' : 'event_stream_failure'
          if (kind === 'permission') permissionReplyFailure = permissionReplyFailure ?? inspectPermissionReplyFailure(error)
          else eventStreamError = error
          eventReadyReject(error)
          own.abort(error)
        }, eventReadyResolve, turnEvidence, inFlight,
        (event, fields) => writeTaskDiagnostic(this.contextStore.databasePath, this.server, contextId, event, {
          scope: { fileAccess: input.permission_scope.fileAccess, allowedShellCount: input.permission_scope.shellCommands.length },
          deadlineRemainingMs: Math.max(0, deadline - Date.now()),
          ...fields,
        }),
        (queue) => { drainPermissions = () => queue.idle() },
        deadline,
      )
      await raceAbort(eventReady, own.signal)

      await this.permissionGuard.openScope(api, sessionId, input.permission_scope, own.signal, call)

      promptSubmissionStarted = true
      const promptMessage = await call(api.session.prompt({ sessionID: sessionId, text: input.task }, { signal: own.signal }))
      if (!promptMessage?.id) throw new DelegationError('OpenCode did not return an ID for the current prompt.', undefined, 'turn_unmatched')
      await call(api.session.wait({ sessionID: sessionId }, { signal: own.signal }))
      await raceAbort(drainPermissions(), own.signal)
      if (eventStreamError) throw eventStreamError
      if (permissionReplyFailure) throw new DelegationError(permissionReplyFailure.message, undefined, 'permission_reply_failed')
      if (turnEvidence.permissionDenied) throw new DelegationError('OpenCode requested a permission outside this task scope.', undefined, 'permission_rejected')
      const response = await findCurrentAssistant(api, sessionId, promptMessage.id, turnEvidence, own.signal, Math.max(1, deadline - Date.now()), call)
      if (response.error || response.finish === 'error') {
        const details = response.error
        const code = details?.type.toLowerCase().includes('quota') ? 'provider_quota' : 'assistant_error'
        const status = details?.status === undefined ? '' : ` (HTTP ${details.status})`
        throw new DelegationError(
          `OpenCode assistant error [${details?.type ?? 'unknown'}]${status}: ${details?.message ?? 'The assistant reported an error.'}`,
          undefined,
          code,
        )
      }
      if (!['stop', 'length', 'content-filter'].includes(response.finish ?? '')) {
        throw new DelegationError(`OpenCode did not provide a terminal assistant response (finish=${response.finish ?? 'missing'}).`, undefined, 'turn_unmatched')
      }
      const text = response.content.filter((part) => part.type === 'text').map((part) => part.text).join('').trim()
      if (!text) throw new DelegationError('OpenCode returned an empty assistant response.')

      result = {
        status: 'completed',
        context_id: contextId,
        session_id: sessionId,
        result: text,
        server_url: clientBaseUrl!,
        attach_command: attachCommand(this.config.opencodeCommand, clientBaseUrl!),
      }
    } catch (error) {
      const connectionLost = Boolean(eventStreamError) || isTransportFailure(error) || error instanceof OpenCodeServerError
      if (connectionLost) this.sdk.invalidate(api, clientBaseUrl)
      if (connectionLost && promptSubmissionStarted) {
        keepQuarantined = true
        quarantineCode = 'session_quarantined'
        quarantineMessage = 'The connection failed after prompt submission; the session outcome is uncertain.'
      }
      if (permissionReplyFailure && promptSubmissionStarted) {
        keepQuarantined = true
        quarantineCode = 'session_quarantined'
        quarantineMessage = 'The permission reply failed after prompt submission. OpenCode may or may not have applied the permission decision; do not reuse this context.'
      }
      const canceled = signal?.aborted === true || active.shutdownRequested
      result = {
        status: canceled ? 'canceled' : permissionReplyFailure ? 'failed' : turnEvidence.permissionDenied && !eventStreamError && !timedOut ? 'rejected' : 'failed',
        context_id: contextId,
        ...(sessionId && { session_id: sessionId }),
        error: canceled ? 'Task was canceled.' : timedOut ? 'OpenCode task deadline exceeded.' : permissionReplyFailure?.message ?? (eventStreamError instanceof Error ? eventStreamError.message : publicError(error)),
        error_code: canceled ? 'canceled' : timedOut ? 'task_timeout' : permissionReplyFailure ? 'permission_reply_failed' : eventStreamError ? 'event_stream_failed' : turnEvidence.permissionDenied ? 'permission_rejected' : error instanceof ContextStoreError ? error.errorCode ?? 'context_store_failed' : error instanceof OpenCodeServerError ? error.errorCode : error instanceof DelegationError ? error.errorCode ?? 'task_failed' : 'task_failed',
        ...(sessionId && clientBaseUrl && { server_url: clientBaseUrl, attach_command: attachCommand(this.config.opencodeCommand, clientBaseUrl) }),
      }
    } finally {
      try {
        if (timeout) clearTimeout(timeout)
        signal?.removeEventListener('abort', onCallerAbort)
        own.signal.removeEventListener('abort', abortEventPump)
        eventController?.abort()
        const normalCleanupDeadline = Date.now() + 10_000
        const cleanupDeadline = () => Math.min(normalCleanupDeadline, active.shutdownCleanupDeadline ?? Number.POSITIVE_INFINITY)
        receipt = await cleanupTask({
          api, sessionId, sessionCreateStarted, taskAborted: own.signal.aborted, interruptSource: active.abortSource, forceQuarantine: keepQuarantined,
          quarantineCode, quarantineMessage,
          contextId, leaseToken, shutdownRequested: () => active.shutdownRequested,
          cleanupControllers: active.cleanupControllers, inFlight, eventPump,
          preparationInFlight,
          shutdownSignal: active.shutdownCleanupController!.signal, deadline: cleanupDeadline,
          releaseLease: (id, token, deadline) => this.releaseLease(id, token, deadline),
          quarantine: (id, token, session, deadline) => {
            this.contextStore.quarantineAndRelease(id, token, session, quarantineCode ?? 'permission_recovery_unverified', deadline)
            return true
          },
          onShutdownFailure: () => { this.shutdownCleanupFailures += 1 },
          onDiagnostic: (event, errorType, fields) => writeTaskDiagnostic(this.contextStore.databasePath, this.server, contextId, event, { stage: event.startsWith('session_interrupt_') ? 'cleanup.interrupt' : 'cleanup', errorType, ...fields }),
          revokeAndVerify: (cleanupApi, cleanupSession) => this.permissionGuard.revokeAndVerify(
            cleanupApi, cleanupSession,
            (operation, deadline) => cleanupCall(operation, deadline, active.cleanupControllers),
            cleanupDeadline,
          ),
        })
        writeTaskDiagnostic(this.contextStore.databasePath, this.server, contextId, 'task_cleanup_complete', {
          stage: 'cleanup', cleanup: receipt, promptSubmitted: promptSubmissionStarted,
          deadlineRemainingMs: Math.max(0, deadline - Date.now()),
        })
      } finally {
        this.active.delete(contextId)
        if (active.shutdownCleanupTimer) clearTimeout(active.shutdownCleanupTimer)
        active.finish()
      }
    }
    return finalizeOutput(result, receipt, contextId, sessionId, clientBaseUrl, this.config.opencodeCommand)
  }

  /** Synchronously rejects new work and aborts active work; safe to call on every shutdown signal. */
  beginShutdown(deadline = Date.now() + 10_000): number {
    if (this.shutdownDeadline !== undefined) return this.shutdownDeadline
    this.shutdownDeadline = deadline
    this.closed = true
    this.shutdownCleanupDeadline = Math.min(deadline, Date.now() + 7_000)
    for (const task of this.active.values()) {
      task.shutdownRequested = true
      task.shutdownCleanupDeadline = this.shutdownCleanupDeadline
      const delay = Math.max(0, this.shutdownCleanupDeadline - Date.now())
      task.shutdownCleanupTimer = setTimeout(() => {
        task.shutdownCleanupController?.abort(new Error('Shutdown cleanup phase deadline exceeded.'))
        for (const controller of task.cleanupControllers) controller.abort(new Error('Shutdown cleanup phase deadline exceeded.'))
      }, delay)
      if (!task.controller.signal.aborted) task.abortSource = 'mcp_shutdown'
      task.controller.abort(new DOMException('MCP server is shutting down.', 'AbortError'))
    }
    return deadline
  }

  async close(deadline?: number): Promise<void> {
    const sharedDeadline = this.beginShutdown(deadline ?? this.shutdownDeadline ?? Date.now() + 10_000)
    this.closePromise ??= this.closeWithinDeadline(sharedDeadline)
    return this.closePromise
  }

  private async closeWithinDeadline(deadline: number): Promise<void> {
    const failures: unknown[] = []
    const tasks = [...this.active.values()]
    try {
      await awaitBefore(Promise.all(tasks.map((task) => task.done)), this.shutdownCleanupDeadline ?? deadline)
    } catch (error) {
      failures.push(error)
      log('task_cleanup_deadline_exceeded', error)
    }
    if (this.active.size === 0) {
      try { this.contextStore.close() } catch (error) { failures.push(error); log('context_store_close_failed', error) }
    } else {
      failures.push(new Error('Active task cleanup is unfinished; context database remains open.'))
      log('context_store_kept_open_for_active_tasks', new Error('Active task cleanup is unfinished.'))
    }
    if (this.shutdownCleanupFailures > 0) failures.push(new Error(`${this.shutdownCleanupFailures} shutdown task(s) could not verify or persist cleanup.`))
    try { await awaitBefore(this.server.close(deadline), deadline) } catch (error) { failures.push(error); log('server_close_failed', error) }
    if (Date.now() > deadline) failures.push(new Error('Shared shutdown deadline exceeded.'))
    if (failures.length) throw new DelegationError('Shutdown did not complete cleanly; unresolved leases, quarantine, database, or private service state were retained.', { cause: failures[0] }, 'shutdown_failed')
  }

  private releaseLease(contextId: string, leaseToken: string, deadline: number): boolean {
    try {
      this.contextStore.releaseLease(contextId, leaseToken, deadline)
      return true
    } catch (error) {
      log('lease_release_failed', error)
      return false
    }
  }

  private async watchEvents(
    api: OpenCodeClient,
    sessionId: string,
    scope: PermissionScope,
    workspaceRoot: string,
    signal: AbortSignal,
    onError: (error: unknown, kind: 'permission' | 'stream') => void,
    onReady: () => void,
    turnEvidence: TurnEvidence,
    inFlight: Set<Promise<unknown>>,
    diagnostic: (event: string, fields: Record<string, unknown>) => void,
    registerQueue: (queue: PermissionReplyQueue) => void,
    taskDeadline: number,
  ): Promise<void> {
    const queue = new PermissionReplyQueue(signal, (error) => onError(error, 'permission'))
    registerQueue(queue)
    const reconcile = async (error: unknown, requestID: string): Promise<boolean> => {
      if (inspectPermissionReplyFailure(error).status !== 404) return false
      if (typeof error === 'object' && error !== null && (error as { _tag?: unknown })._tag === 'PermissionNotFoundError' && (error as { requestID?: unknown }).requestID !== requestID) return false
      return await queue.waitForReject(requestID, Math.min(1000, Math.max(0, taskDeadline - Date.now())))
    }
    try {
      for await (const event of api.event.subscribe({ signal })) {
        if (signal.aborted) break
        if (event.type === 'server.connected') onReady()
        turnEvidence.observe(event, sessionId)
        if (event.type === 'permission.replied' && event.data.sessionID === sessionId) {
          queue.settle(event.data.requestID, event.data.reply)
          if (event.data.reply === 'reject') turnEvidence.recordPermissionDenied()
          diagnostic('permission_replied', {
            session: hashIdentifier(sessionId),
            request: hashIdentifier(event.data.requestID),
            decision: event.data.reply,
          })
          continue
        }
        if (event.type !== 'permission.asked' || event.data.sessionID !== sessionId) continue
        const request = event.data
        try {
          const decision = this.permissionGuard.decideAsked(event, scope, workspaceRoot)
          const allowed = decision === 'once'
          if (!allowed) turnEvidence.recordPermissionDenied()
          const diagnosticFields = {
            stage: 'permission.reply',
            request: hashIdentifier(request.id),
            session: hashIdentifier(sessionId),
            tool: permissionToolCorrelation(request.source),
            decision: allowed ? 'once' : 'reject',
            fileAccess: scope.fileAccess,
            allowedShellCount: scope.shellCommands.length,
          }
          diagnostic('permission_asked', diagnosticFields)
          queue.enqueue(request.id, async () => {
            const startedAt = performance.now()
            diagnostic('permission_reply_started', { ...diagnosticFields, monotonicMs: startedAt })
            let reply: Promise<unknown>
            try {
              reply = trackOperation(api.permission.reply({
                sessionID: sessionId,
                requestID: request.id,
                decision: allowed ? 'once' : 'reject',
                ...(!allowed && { message: 'Blocked by the per-task permission scope.' }),
              }, { signal }), inFlight)
            } catch (error) {
              const failure = inspectPermissionReplyFailure(error)
              diagnostic('permission_reply_completed', {
                ...diagnosticFields, status: failure.status ?? 'failed', errorClass: failure.errorClass,
                durationMs: Math.max(0, performance.now() - startedAt),
              })
              if (await reconcile(error, request.id)) {
                turnEvidence.recordPermissionDenied()
                diagnostic('permission_reply_reconciled', { request: hashIdentifier(request.id), session: hashIdentifier(sessionId), status: 404 })
                return
              }
              onError(error, 'permission')
              return
            }
            let waitAborted = false
            void reply.then(
              () => {
                if (waitAborted) diagnostic('permission_reply_late_completed', {
                  ...diagnosticFields, status: 'success', durationMs: Math.max(0, performance.now() - startedAt),
                })
              },
              (error) => {
                if (waitAborted) {
                  const failure = inspectPermissionReplyFailure(error)
                  diagnostic('permission_reply_late_failed', {
                    ...diagnosticFields, status: failure.status ?? 'failed', errorClass: failure.errorClass,
                    durationMs: Math.max(0, performance.now() - startedAt),
                  })
                }
              },
            )
            try {
              await raceAbort(reply, signal)
              diagnostic('permission_reply_completed', {
                ...diagnosticFields, status: 'accepted', durationMs: Math.max(0, performance.now() - startedAt),
              })
            } catch (error) {
              if (signal.aborted) {
                waitAborted = true
                diagnostic('permission_reply_wait_aborted', {
                  ...diagnosticFields, status: 'unknown', durationMs: Math.max(0, performance.now() - startedAt),
                })
                return
              }
              if (await reconcile(error, request.id)) {
                turnEvidence.recordPermissionDenied()
                diagnostic('permission_reply_reconciled', { request: hashIdentifier(request.id), session: hashIdentifier(sessionId), status: 404 })
                return
              }
              const failure = inspectPermissionReplyFailure(error)
              diagnostic('permission_reply_completed', {
                ...diagnosticFields, status: failure.status ?? 'failed', errorClass: failure.errorClass,
                durationMs: Math.max(0, performance.now() - startedAt),
              })
              onError(error, 'permission')
              return
            }
          })
        } catch (error) {
          if (signal.aborted) return
          onError(error, 'stream')
          return
        }
      }
      if (!signal.aborted) onError(new DelegationError('OpenCode event stream ended unexpectedly.'), 'stream')
    } catch (error) {
      if (!signal.aborted) onError(error, 'stream')
    }
  }
}

function resolveWorkspace(value: string): string {
  if (!path.isAbsolute(value)) throw new DelegationError('workspace_root must be an absolute path.')
  try {
    const canonical = realpathSync(value)
    if (!statSync(canonical).isDirectory()) throw new Error('not a directory')
    return canonical
  } catch (cause) {
    throw new DelegationError('workspace_root must be an existing directory.', { cause })
  }
}

function normalizePath(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function titleForTask(task: string): string {
  const oneLine = task.replace(/\s+/g, ' ').trim()
  return `Codex subagent: ${oneLine.slice(0, 72)}`
}

function parseModel(value: string): { providerID: string; id: string } {
  const separator = value.indexOf('/')
  if (separator <= 0 || separator === value.length - 1) {
    throw new DelegationError('model must use the provider/model-id format.')
  }
  return { providerID: value.slice(0, separator), id: value.slice(separator + 1) }
}

function attachCommand(command: string, baseUrl: string): string {
  return `${quoteCommand(command)} --server ${baseUrl}`
}

function quoteCommand(value: string): string {
  return /[\s"]/u.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value
}

function publicError(error: unknown): string {
  if (error instanceof DelegationError) return error.message
  if (error instanceof ContextStoreError) return error.message
  if (error instanceof Error && error.name === 'OpenCodeServerError') return error.message
  return 'OpenCode task failed. Check that OpenCode is installed, authenticated, and reachable.'
}

function isTransportFailure(error: unknown): boolean {
  if (error instanceof ClientError && error.reason === 'Transport') return true
  const seen = new Set<unknown>()
  let current: unknown = error
  for (let depth = 0; depth < 5 && current && !seen.has(current); depth++) {
    seen.add(current)
    if (current instanceof Error) {
      const value = current as Error & { reason?: unknown; code?: unknown }
      if (current.name === 'ClientError' && value.reason === 'Transport') return true
      if (typeof value.code === 'string' && /^(ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT)$/u.test(value.code)) return true
      if (current.name === 'AbortError' && /fetch|socket|stream|connection/iu.test(current.message)) return true
      current = value.cause
    } else break
  }
  return error instanceof Error && /(?:connection reset|connection refused|socket hang up|event stream (?:ended|disconnected))/iu.test(error.message)
}

function log(event: string, error: unknown): void {
  console.error(JSON.stringify({
    component: 'opencode-delegator',
    event,
    errorType: error instanceof Error ? error.name : 'UnknownError',
  }))
}

function finalizeOutput(
  execution: DelegateOutput | undefined,
  receipt: TaskCleanupReceipt,
  contextId: string,
  sessionId: string | undefined,
  baseUrl: string | undefined,
  command: string,
): DelegateOutput {
  const base: DelegateOutput = execution ?? { status: 'failed', context_id: contextId, error: 'OpenCode task failed.', error_code: 'task_failed' }
  if (base.error_code === 'permission_reply_failed' && receipt.quarantined && receipt.errors.length === 0) {
    const message = receipt.failureMessage ?? 'The session is quarantined because the permission reply outcome is uncertain; do not reuse this context_id.'
    return { ...base, error: [base.error, message].filter(Boolean).join(' ') }
  }
  if (receipt.errors.length || receipt.quarantined || (!receipt.leaseReleased && !receipt.leaseRetained)) {
    const persistenceFailed = receipt.errors.some((error) => error === 'lease_release_failed' || error.startsWith('quarantine_persist:') || error === 'quarantine_persistence_failed')
    const code = persistenceFailed ? 'context_store_failed'
      : receipt.errors.length > 0 ? 'permission_reset_failed'
        : receipt.failureCode ?? (receipt.quarantined && execution?.error_code === 'session_quarantined' ? 'session_quarantined' : 'permission_reset_failed')
    const cleanupMessage = receipt.errors.length > 0 ? 'Cleanup could not be fully verified; do not reuse this context_id.' : undefined
    const message = [receipt.failureMessage, cleanupMessage].filter(Boolean).join(' ')
      || (receipt.quarantined
      ? 'The session is quarantined because permission recovery could not be verified; do not reuse this context_id.'
      : receipt.leaseRetained
        ? 'The context lease remains held because cleanup could not be confirmed; do not reuse this context_id.'
        : 'Task cleanup did not complete safely.')
    return {
      status: 'failed', context_id: contextId, ...(sessionId && { session_id: sessionId }),
      error: [base.error, message].filter(Boolean).join(' '), error_code: code,
      ...(baseUrl && { server_url: baseUrl, attach_command: attachCommand(command, baseUrl) }),
    }
  }
  return base
}

type PermissionReplyFailure = { errorClass: string; status?: number; transportFailure: boolean; message: string }

function inspectPermissionReplyFailure(error: unknown): PermissionReplyFailure {
  if (typeof error === 'object' && error !== null && (error as { _tag?: unknown })._tag === 'PermissionNotFoundError') {
    return {
      errorClass: 'permission_not_found', status: 404, transportFailure: false,
      message: 'OpenCode permission reply failed (HTTP 404) [PermissionNotFoundError]. The permission outcome is unknown.',
    }
  }
  if (error instanceof ClientError) {
    const reason = error.reason
    const status = reason === 'UnexpectedStatus' ? numericStatus(error.cause) : undefined
    const errorClass = reason === 'UnexpectedStatus' ? 'http_status'
      : reason === 'Transport' ? 'transport'
        : reason === 'UnsupportedContentType' ? 'unsupported_content_type'
          : reason === 'MalformedResponse' ? 'malformed_response'
            : reason === 'SseEventTooLarge' ? 'sse_event_too_large' : 'sdk_error'
    const statusText = status === undefined ? '' : ` (HTTP ${status})`
    return {
      errorClass, ...(status !== undefined && { status }), transportFailure: reason === 'Transport',
      message: `OpenCode permission reply failed${statusText} [${errorClass}]. The permission outcome is unknown.`,
    }
  }
  const transportFailure = isTransportFailure(error)
  const status = numericStatus(error)
  const errorClass = transportFailure ? 'transport' : status !== undefined ? 'http_status' : 'unknown'
  const statusText = status === undefined ? '' : ` (HTTP ${status})`
  return {
    errorClass, ...(status !== undefined && { status }), transportFailure,
    message: `OpenCode permission reply failed${statusText} [${errorClass}]. The permission outcome is unknown.`,
  }
}

function numericStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const status = (error as { status?: unknown }).status
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined
}

function hashIdentifier(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function permissionToolCorrelation(source: unknown): string | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const value = source as { type?: unknown; id?: unknown; messageID?: unknown }
  if (value.type !== 'tool' || typeof value.id !== 'string' || typeof value.messageID !== 'string') return undefined
  return hashIdentifier(`${value.messageID}:${value.id}`)
}

function writeTaskDiagnostic(
  databasePath: string,
  server: OpenCodeServerManager,
  contextId: string,
  event: string,
  fields: Record<string, unknown>,
): void {
  let service: { source: string; identity?: { id: string; pid: number; url: string }; version: string }
  try {
    const snapshot = server.diagnosticInfo
    service = {
      source: snapshot?.source ?? 'unknown',
      ...(snapshot?.identity && { identity: { ...snapshot.identity, url: safeServiceUrl(snapshot.identity.url) } }),
      version: snapshot?.version ?? 'unknown',
    }
  } catch { service = { source: 'unknown', version: 'unknown' } }
  console.error(JSON.stringify({
    component: 'opencode-delegator', event,
    timestamp: new Date().toISOString(), monotonicMs: performance.now(),
    process: { pid: process.pid, version: '0.1.0', runtime: process.version },
    databasePath: path.resolve(databasePath),
    service,
    correlationId: hashIdentifier(contextId),
    ...fields,
  }))
}

function safeServiceUrl(value: string): string {
  try {
    const url = new URL(value)
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}`
  } catch { return 'unknown' }
}
