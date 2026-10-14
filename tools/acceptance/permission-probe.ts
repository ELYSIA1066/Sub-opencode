import { randomUUID, createHash } from 'node:crypto'
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { OpenCodeClient } from '@opencode/client'
import { lockedPermissionRules } from '../../src/permission-policy.js'
import { hasPermissionRules } from '../../src/session-permission-guard.js'
import { prepareCase3Run } from './case3-live.js'
import { safeCase3Events } from './case3-recheck.js'
import type { EventRecord } from './evidence.js'
import { recordUnexpectedSubmission } from './budget.js'

export function safeProbeError(error: unknown): { type: string; status: number | null } {
  const value = error as { _tag?: string; name?: string; status?: number; cause?: { status?: number } } | null
  return { type: value?._tag ?? value?.name ?? 'UnknownError',
    status: value?._tag === 'PermissionNotFoundError' ? 404 : value?.status ?? value?.cause?.status ?? null }
}

function limited<T>(operation: Promise<T>, deadline: number, signal: AbortSignal): Promise<T> {
  let timer: NodeJS.Timeout
  let onAbort: () => void
  return Promise.race([operation, new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error('probe_aborted'))
    if (signal.aborted) { onAbort(); return }
    signal.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => reject(new Error('probe_deadline')), Math.max(0, deadline - Date.now()))
  })]).finally(() => { clearTimeout(timer!); signal.removeEventListener('abort', onAbort!) })
}

/** Real permission API only; no tool source, prompt, execution, or file API. */
export async function probePermissions(api: OpenCodeClient, workspace: string, options: { timeoutMs?: number; cleanupMs?: number } = {}) {
  const deadline = Date.now() + Math.min(options.timeoutMs ?? 30_000, 30_000)
  const task = new AbortController()
  const reader = new AbortController()
  const events: EventRecord[] = []
  const pendingOperations = new Set<Promise<unknown>>()
  const definitions = [
    { id: `per_${randomUUID()}`, action: 'shell', resources: ['PROBE_ONLY_DO_NOT_EXECUTE'] },
    { id: `per_${randomUUID()}`, action: 'read', resources: [join(workspace, 'probe-a.txt')] },
    { id: `per_${randomUUID()}`, action: 'read', resources: [join(workspace, 'probe-b.txt')] },
  ]
  let sessionId: string | undefined
  let connected = false
  let streamError: unknown
  let failure: ReturnType<typeof safeProbeError> | null = null
  let threePending = false
  let cascadeVerified = false
  let staleReply: ReturnType<typeof safeProbeError> | null = null
  const createResults: Array<{ id: string; effect?: string; error?: ReturnType<typeof safeProbeError> }> = []
  const cleanup = { pendingEmpty: false, idle: false, denyAll: false, deleted: false, operationsDrained: false, streamExited: false, errors: [] as string[] }
  const track = <T>(promise: Promise<T>): Promise<T> => {
    pendingOperations.add(promise)
    void promise.then(() => pendingOperations.delete(promise), () => pendingOperations.delete(promise))
    return promise
  }
  const call = <T>(promise: Promise<T>) => limited(track(promise), deadline, task.signal)
  const until = async (condition: () => boolean, limit = deadline): Promise<void> => {
    while (!condition()) {
      if (streamError) throw streamError
      await limited(new Promise((done) => setTimeout(done, 10)), limit, task.signal)
    }
  }
  const pump = (async () => {
    try {
      for await (const event of api.event.subscribe({ signal: reader.signal })) {
        if (event.type === 'server.connected') connected = true
        if ('data' in event && (event.data as { sessionID?: string }).sessionID === sessionId) events.push({ at: new Date().toISOString(), event })
      }
      if (!reader.signal.aborted) { streamError = new Error('probe_event_eof'); task.abort(streamError) }
    } catch (error) { if (!reader.signal.aborted) { streamError = error; task.abort(error) } }
  })()
  try {
    await until(() => connected)
    const session = await call(api.session.create({ title: 'zero-prompt-permission-probe', agent: 'build',
      model: { providerID: 'opencode-go', id: 'deepseek-v4.1-flash' }, location: { directory: workspace }, permissions: lockedPermissionRules() }, { signal: task.signal }))
    sessionId = session.id
    if (!hasPermissionRules(session.permissions, lockedPermissionRules())) throw new Error('probe_initial_lock_missing')
    const messages = await call(api.message.list({ sessionID: sessionId, limit: 1 }, { signal: task.signal }))
    if (messages.data.length) throw new Error('probe_session_not_empty')
    const askRules = [...lockedPermissionRules(), { action: 'read', resource: '*', effect: 'ask' as const }, { action: 'shell', resource: '*', effect: 'ask' as const }]
    await call(api.session.update({ sessionID: sessionId, permissions: askRules }, { signal: task.signal }))
    const opened = await call(api.session.get({ sessionID: sessionId }, { signal: task.signal }))
    if (!hasPermissionRules(opened.permissions, askRules)) throw new Error('probe_ask_not_verified')
    for (const definition of definitions) {
      void track(api.permission.create({ sessionID: sessionId, ...definition }, { signal: task.signal })).then(
        (result) => createResults.push({ id: definition.id, effect: result.effect }),
        (error) => createResults.push({ id: definition.id, error: safeProbeError(error) }))
    }
    await until(() => definitions.every((definition) => events.some((row) => row.event?.type === 'permission.asked' && row.event?.data?.id === definition.id)))
    const pending = await call(api.permission.list({ sessionID: sessionId }, { signal: task.signal }))
    threePending = pending.length === 3 && definitions.every((definition) => pending.some((request) => request.id === definition.id))
    if (!threePending) throw new Error('probe_three_pending_missing')
    await call(api.permission.reply({ sessionID: sessionId, requestID: definitions[0]!.id, decision: 'reject' }, { signal: task.signal }))
    await until(() => definitions.every((definition) => events.some((row) => row.event?.type === 'permission.replied'
      && row.event?.data?.requestID === definition.id && row.event?.data?.reply === 'reject')), Math.min(deadline, Date.now() + 5_000))
    cascadeVerified = true
    try {
      await call(api.permission.reply({ sessionID: sessionId, requestID: definitions[1]!.id, decision: 'once' }, { signal: task.signal }))
      throw new Error('ended_permission_reply_was_accepted')
    } catch (error) {
      staleReply = safeProbeError(error)
      if (staleReply.status !== 404) throw error
    }
  } catch (error) { failure = safeProbeError(error) }
  finally {
    task.abort()
    const end = Date.now() + Math.min(options.cleanupMs ?? 10_000, 10_000)
    const clean = new AbortController()
    const cleanTimer = setTimeout(() => clean.abort(new Error('probe_cleanup_deadline')), Math.max(0, end - Date.now()))
    const cleanCall = <T>(operation: () => Promise<T>) => {
      if (Date.now() >= end) throw new Error('probe_cleanup_deadline')
      clean.signal.throwIfAborted()
      return limited(operation(), end, clean.signal)
    }
    if (sessionId) {
      try {
        const pending = await cleanCall(() => api.permission.list({ sessionID: sessionId! }, { signal: clean.signal }))
        for (const request of pending) {
          if (!definitions.some((definition) => definition.id === request.id)) throw new Error('probe_foreign_request')
          await cleanCall(() => api.permission.reply({ sessionID: sessionId!, requestID: request.id, decision: 'reject' }, { signal: clean.signal }))
        }
        cleanup.pendingEmpty = (await cleanCall(() => api.permission.list({ sessionID: sessionId! }, { signal: clean.signal }))).length === 0
      } catch { cleanup.errors.push('pending_cleanup_failed') }
      try { await cleanCall(() => api.session.wait({ sessionID: sessionId! }, { signal: clean.signal })); cleanup.idle = true } catch { cleanup.errors.push('idle_failed') }
      try {
        await cleanCall(() => api.session.update({ sessionID: sessionId!, permissions: lockedPermissionRules() }, { signal: clean.signal }))
        cleanup.denyAll = hasPermissionRules((await cleanCall(() => api.session.get({ sessionID: sessionId! }, { signal: clean.signal }))).permissions, lockedPermissionRules())
      } catch { cleanup.errors.push('deny_all_failed') }
      try {
        await cleanCall(() => Promise.allSettled([...pendingOperations]))
        cleanup.operationsDrained = pendingOperations.size === 0
        const messages = await cleanCall(() => api.message.list({ sessionID: sessionId!, limit: 1 }, { signal: clean.signal }))
        if (messages.data.length) throw new Error('probe_unexpected_messages')
        if (cleanup.pendingEmpty && cleanup.idle && cleanup.denyAll && cleanup.operationsDrained && cleanup.errors.length === 0) {
          await cleanCall(() => api.session.remove({ sessionID: sessionId! }, { signal: clean.signal }))
          try { await cleanCall(() => api.session.get({ sessionID: sessionId! }, { signal: clean.signal })) }
          catch (error) { if (safeProbeError(error).type === 'SessionNotFoundError' || safeProbeError(error).status === 404) cleanup.deleted = true; else throw error }
          if (!cleanup.deleted) throw new Error('probe_delete_not_verified')
        }
      } catch { cleanup.errors.push('probe_delete_or_drain_failed') }
    }
    reader.abort()
    try { await cleanCall(() => pump); cleanup.streamExited = true } catch { cleanup.errors.push('stream_exit_failed') }
    clearTimeout(cleanTimer)
    clean.abort()
  }
  const unexpectedPromptCount = events.filter((row) => row.event?.type === 'session.inbox.enqueued').length
  const passed = !failure && !streamError && threePending && cascadeVerified && staleReply?.status === 404
    && cleanup.deleted && cleanup.streamExited && cleanup.operationsDrained && cleanup.errors.length === 0 && unexpectedPromptCount === 0
  return { capturedAt: new Date().toISOString(), promptSubmissions: unexpectedPromptCount, sessionId, threePending, cascadeVerified, staleReply,
    createResults, failure, streamError: streamError ? safeProbeError(streamError) : null, cleanup,
    events: sessionId ? safeCase3Events(events, sessionId) : [], passed }
}

export async function runPermissionProbe(runId: string): Promise<{ passed: boolean; path: string }> {
  const executionEnd = Date.now() + 30_000
  const totalEnd = executionEnd + 10_000
  const preparationController = new AbortController()
  const preparationTimer = setTimeout(() => preparationController.abort(new Error('probe_initialization_timeout')), 30_000)
  const preparation = prepareCase3Run(runId)
  void preparation.then((late) => { if (preparationController.signal.aborted) void late.manager.close() }, () => {})
  let prepared: Awaited<ReturnType<typeof prepareCase3Run>>
  try { prepared = await limited(preparation, executionEnd, preparationController.signal) }
  catch (error) { preparationController.abort(); throw error }
  finally { clearTimeout(preparationTimer) }
  const { evidenceDir, manifest, manager, api, identity, ledgerPath } = prepared
  const ledgerBefore = readFileSync(ledgerPath)
  try {
    writeFileSync(join(evidenceDir, 'permission-probe-attempt.json'), JSON.stringify({ startedAt: new Date().toISOString(), runId }), { flag: 'wx' })
    const result = await probePermissions(api, manifest.workspaceRoot, { timeoutMs: Math.max(0, executionEnd - Date.now()), cleanupMs: 10_000 })
    for (let index = 0; index < result.promptSubmissions; index++) recordUnexpectedSubmission(ledgerPath, `${ledgerPath}.lock`, runId, 'permission-probe', { task: 'unexpected probe inbox submission' })
    let identityUnchanged = true
    try { await limited(manager.assertIdentity(identity), totalEnd, preparationController.signal) } catch { identityUnchanged = false }
    const budgetUnchanged = readFileSync(ledgerPath).equals(ledgerBefore)
    const passed = result.passed && identityUnchanged && budgetUnchanged
    const path = join(evidenceDir, 'permission-probe.json')
    const serialized = JSON.stringify({ ...result, origin: 'permission-api-no-tools', identity, identityUnchanged, budgetUnchanged, passed }, null, 2)
    writeFileSync(path, serialized, { flag: 'wx' })
    const manifestPath = join(evidenceDir, 'manifest.json')
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const tmp = `${manifestPath}.${randomUUID()}.tmp`
    writeFileSync(tmp, JSON.stringify({ ...raw, ...(!passed && { readiness: 'blocked' }),
      permissionProbe: { path, sha256: createHash('sha256').update(serialized).digest('hex'), passed } }, null, 2), { flag: 'wx' })
    renameSync(tmp, manifestPath)
    return { passed, path }
  } finally { preparationController.abort(); await manager.close() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) { console.error('Use permission-probe <ready runId>'); process.exit(1) }
  runPermissionProbe(process.argv[2]!).then((result) => { console.log(JSON.stringify(result)); process.exit(result.passed ? 0 : 1) }, () => { console.error('permission_probe_failed'); process.exit(1) })
}
