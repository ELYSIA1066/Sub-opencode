import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { removeOwnedTree } from '../cleanup/owned-tree.js'
import { prepareCase3Run } from './case3-live.js'
import { safeCase3Events } from './case3-recheck.js'
import { sdkEvidence, type EventRecord, type SdkEvidence } from './evidence.js'
import { appendCompletion, PROMPT_BUDGET, recordUnexpectedSubmission, sanitize, tryReserve, usedSlots } from './budget.js'
import { hashTree, makeIsolatedEnvironment, McpStdioClient, PINNED_MODEL, readContextState, SYSTEM_TEMP_ROOT } from './runtime.js'

export const USABILITY_MARKER = 'usability-attempt.json'
export const USABILITY_FILE_TEXT = 'USABILITY_EDIT_OK'
type Verdict = { verdict: 'PASS' | 'FAIL' | 'UNVERIFIED'; reason: string }
type Stage = 'U01' | 'U02'
type Client = Pick<McpStdioClient, 'start' | 'close' | 'callTool' | 'cancel' | 'requestId' | 'diagnostics' | 'pid' | 'exited' | 'exitCode'>
type Prepared = Awaited<ReturnType<typeof prepareCase3Run>>
type State = ReturnType<typeof readContextState>
export type UsabilityRound = {
  stage: Stage
  response: { status?: string; context_id?: string; session_id?: string; error_code?: string; result?: string }
  expectedContext: string
  previousSession?: string
  previousPrompt?: string
  sdk: SdkEvidence
  inboxCount: number
  target: string
  workspace: string
  targetText: string
  before: Record<string, string>
  after: Record<string, string>
  expectedReply: string
  idleVerified: boolean
  mappingVerified: boolean
  leaseAbsent: boolean
  quarantineAbsent: boolean
  cleanupVerified: boolean
  sharedIdentityUnchanged: boolean
  clientClosed: boolean
  faults: string[]
}
type RoundRecord = { classification: Verdict; response: UsabilityRound['response']; sdkPromptId?: string | null; [key: string]: unknown }
export type UsabilityDependencies = {
  prepare?: typeof prepareCase3Run
  createClient?: (name: string, repo: string, env: NodeJS.ProcessEnv) => Client
  collectSdk?: typeof sdkEvidence
  readContext?: typeof readContextState
}
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
const emptySdk = (): SdkEvidence => ({ assistantMessages: [], messageCosts: [], permissionEvents: [], toolResults: [], denyAllVerified: false })
const errorType = (error: unknown) => error instanceof Error ? error.name.replace(/[^A-Za-z0-9_-]/gu, '').slice(0, 40) || 'Error' : 'UnknownError'
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message) }
function bounded<T>(operation: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout
  return Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds) })]).finally(() => clearTimeout(timer!))
}
export function usabilityAttemptPath(runId: string): string {
  check(/^[\w-]{12,80}$/u.test(runId), 'usability_run_id_invalid')
  return join(repoRoot, 'work/architecture-optimization/runs', runId, USABILITY_MARKER)
}
export function makeUsabilityEnvironment(root: string, registryPath: string, inherited = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...makeIsolatedEnvironment(root, inherited), OPENCODE_SERVICE_REGISTRY_FILE: registryPath, OPENCODE_REUSE_ONLY: 'true' }
  delete env.OPENCODE_MODEL
  return env
}
function targets(tool: any, workspace: string, target: string): boolean {
  return tool.input && typeof tool.input === 'object' && Object.entries(tool.input).some(([key, value]) => /path|file/iu.test(key)
    && typeof value === 'string' && resolve(workspace, value) === resolve(target))
}
/** Functional verdict, independent of the controlled Case 3 adapter and criteria. */
export function classifyUsabilityRound(input: UsabilityRound): Verdict {
  const fail = (reason: string): Verdict => ({ verdict: 'FAIL', reason })
  const missing = (reason: string): Verdict => ({ verdict: 'UNVERIFIED', reason })
  if (input.faults.length) return fail(input.faults.join(','))
  if (input.response.status !== 'completed') return fail('task_not_completed')
  if (!input.sharedIdentityUnchanged || !input.clientClosed || !input.idleVerified || !input.sdk.denyAllVerified
    || !input.cleanupVerified || !input.mappingVerified || !input.leaseAbsent || !input.quarantineAbsent) return fail('safety_or_recovery_not_verified')
  if (input.response.context_id !== input.expectedContext || !input.response.session_id) return fail('context_or_session_mismatch')
  if (input.stage === 'U02' && input.response.session_id !== input.previousSession) return fail('continuation_session_changed')
  if (!input.sdk.modelVerified || !input.sdk.assistantModelsVerified) return fail('default_model_mismatch')
  if (input.sdk.assistantMessages.some((row) => row.error != null)) return fail('assistant_message_error')
  if (input.inboxCount !== 1 || !input.sdk.sdkPromptId || input.sdk.inboxIDs?.length !== 1 || input.sdk.inboxIDs[0] !== input.sdk.sdkPromptId
    || !input.sdk.deliveredInboxIDs?.includes(input.sdk.sdkPromptId) || !input.sdk.stepAssistantMessageIDs?.length
    || !input.sdk.assistantMessages.length || input.sdk.sdkPromptId === input.previousPrompt
    || input.sdk.assistantMessages.some((row) => !input.sdk.stepAssistantMessageIDs?.includes(row.id))) return missing('current_turn_not_correlated')
  const changes = [...new Set([...Object.keys(input.before), ...Object.keys(input.after)])].filter((key) => input.before[key] !== input.after[key])
  if (changes.some((key) => key !== 'target.txt') || (input.stage === 'U02' && changes.length)) return fail('unexpected_file_change')
  if (input.targetText.replace(/\r?\n$/u, '') !== USABILITY_FILE_TEXT) return fail('target_content_incorrect')
  const reads = input.sdk.toolResults.filter((tool) => /^read$/iu.test(tool.name ?? '') && tool.status === 'completed' && targets(tool, input.workspace, input.target))
  const edits = input.sdk.toolResults.filter((tool) => /^(?:edit|write)$/iu.test(tool.name ?? '') && tool.status === 'completed' && targets(tool, input.workspace, input.target))
  if (input.sdk.toolResults.some((tool) => /^(?:bash|shell)$/iu.test(tool.name ?? ''))) return fail('unexpected_shell_tool')
  if (input.stage === 'U01' && (changes.length !== 1 || reads.length < 2 || !edits.length)) return missing('read_edit_read_not_proven')
  if (input.stage === 'U01') {
    const stepOrder = input.sdk.stepAssistantMessageIDs!
    const editSteps = edits.map((tool) => stepOrder.indexOf(tool.assistantMessageID))
    const readSteps = reads.map((tool) => stepOrder.indexOf(tool.assistantMessageID))
    if (editSteps.some((index) => index < 0) || readSteps.some((index) => index < 0)
      || !readSteps.some((index) => index < Math.min(...editSteps)) || !readSteps.some((index) => index > Math.max(...editSteps))) return missing('read_edit_read_order_not_proven')
  }
  if (input.stage === 'U02' && !reads.length) return missing('continuation_read_not_proven')
  if (input.response.result?.trim() !== input.expectedReply) return fail(input.stage === 'U02' ? 'continuation_reply_or_memory_incorrect' : 'task_reply_incorrect')
  return { verdict: 'PASS', reason: input.stage === 'U01' ? 'normal_read_edit_read_verified' : 'restarted_mcp_continuation_verified' }
}
function saveManifest(prepared: Prepared, changes: Record<string, unknown>): void {
  const path = join(prepared.evidenceDir, 'manifest.json')
  const current = JSON.parse(readFileSync(path, 'utf8'))
  const temporary = `${path}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify({ ...current, ...changes, ledgerDigest: sha(readFileSync(prepared.ledgerPath)), ledgerReservations: usedSlots(prepared.ledgerPath) }, null, 2), { flag: 'wx' })
  renameSync(temporary, path)
}
function safeSdk(sdk: SdkEvidence, workspace: string, target: string) {
  return { promptId: sdk.sdkPromptId ?? null, inboxIDs: sdk.inboxIDs ?? [], deliveredInboxIDs: sdk.deliveredInboxIDs ?? [], stepAssistantMessageIDs: sdk.stepAssistantMessageIDs ?? [],
    sessionModel: sdk.sessionModel, modelVerified: sdk.modelVerified, assistantModelsVerified: sdk.assistantModelsVerified,
    assistantMessages: sdk.assistantMessages.map((row) => ({ id: row.id, model: row.model, error: row.error ? { type: row.error.type ?? null, status: row.error.status ?? null } : null })),
    messageCosts: sdk.messageCosts.map((row) => ({ messageID: row.messageID, cost: row.cost ?? null })),
    tools: sdk.toolResults.map((row) => ({ name: row.name, callID: row.callID, assistantMessageID: row.assistantMessageID, status: row.status, errorType: row.errorType, targetMatched: targets(row, workspace, target) })) }
}

/** Explicit live entry; dependency overrides are library-only offline test seams. */
export async function runUsability(runId: string, explicitRegistry?: string, dependencies: UsabilityDependencies = {}): Promise<Record<string, any>> {
  usabilityAttemptPath(runId) // Validate before reading any path or opening a connection.
  const prepared = await (dependencies.prepare ?? prepareCase3Run)(runId, explicitRegistry)
  const { manifest, manager, api, identity, evidenceDir, ledgerPath } = prepared
  const markerPath = join(evidenceDir, USABILITY_MARKER)
  const stages: RoundRecord[] = []
  const events: EventRecord[] = []
  const observer = new AbortController()
  const contextId = randomUUID()
  const memory = `MEM_${randomUUID().replaceAll('-', '')}`
  const target = join(manifest.workspaceRoot, 'target.txt')
  const sentinel = join(manifest.tempRoot, 'usability-sentinel.txt')
  let expectedLedger = sha(readFileSync(ledgerPath))
  const budgetBefore = usedSlots(ledgerPath)
  const ledgerBefore = readFileSync(ledgerPath)
  const ledgerAppendIsOwn = () => {
    const bytes = readFileSync(ledgerPath)
    return bytes.subarray(0, ledgerBefore.length).equals(ledgerBefore)
      && bytes.subarray(ledgerBefore.length).toString('utf8').split(/\r?\n/u).filter(Boolean).every((line) => {
        const row = JSON.parse(line)
        return row.runId === runId && ['usability-U01', 'usability-U02'].includes(row.caseId) && ['RESERVE', 'RESULT'].includes(row.type)
      })
  }
  let started = false, connected = false, streamFault: string | undefined, currentClient: Client | undefined, submittedRequestId: number | undefined
  let pump: Promise<void> | undefined
  let overall: Verdict = { verdict: 'FAIL', reason: 'usability_not_started' }
  let finalIdentity = false
  let localCleanup: Record<string, unknown> = { deleted: false, reason: 'safety_not_verified' }
  let record: Record<string, any> | undefined
  try {
    check(!existsSync(markerPath), 'usability_already_attempted')
    check(budgetBefore <= PROMPT_BUDGET - 2, 'usability_requires_two_remaining_slots')
    check(!existsSync(target) && !existsSync(sentinel) && Object.keys(hashTree(manifest.workspaceRoot)).length === 0, 'usability_requires_fresh_workspace')
    check(manifest.localRootOwnership?.createdBy === 'acceptance-preflight' && manifest.localRootOwnership.runId === runId
      && resolve(manifest.localRootOwnership.tempRoot) === resolve(manifest.tempRoot), 'usability_root_ownership_unknown')
    writeFileSync(markerPath, JSON.stringify({ status: 'started', runId, contextId, maximumPrompts: 2, startedAt: new Date().toISOString() }, null, 2), { flag: 'wx' })
    started = true
    writeFileSync(target, 'BEFORE\n', { flag: 'wx' }); writeFileSync(sentinel, 'USABILITY_OUTSIDE_SENTINEL', { flag: 'wx' })
    pump = (async () => {
      try {
        for await (const event of api.event.subscribe({ signal: observer.signal })) {
          if (event.type === 'server.connected') connected = true
          events.push({ at: new Date().toISOString(), event })
          if (events.length > 20_000) throw new Error('usability_event_limit')
        }
        if (!observer.signal.aborted) streamFault = 'event_stream_eof'
      } catch (error) { if (!observer.signal.aborted) streamFault = `event_stream:${errorType(error)}` }
      if (streamFault && currentClient && submittedRequestId !== undefined) { try { currentClient.cancel(submittedRequestId) } catch {} }
    })()
    await bounded((async () => { while (!connected && !streamFault && !observer.signal.aborted) await new Promise((done) => setTimeout(done, 10)); check(connected && !streamFault, 'usability_subscription_failed') })(), 20_000, 'usability_subscription_timeout')
    const env = makeUsabilityEnvironment(manifest.tempRoot, manifest.sharedRegistryPath)
    const readState = dependencies.readContext ?? readContextState
    const takeFiles = () => ({ ...hashTree(manifest.workspaceRoot), '../sentinel': sha(readFileSync(sentinel)) })
    for (const stage of ['U01', 'U02'] as const) {
      const faults: string[] = []
      const eventStart = events.length
      const before = takeFiles()
      const expectedReply = stage === 'U01' ? USABILITY_FILE_TEXT : `USABILITY_CONTINUE_OK|${memory}|${USABILITY_FILE_TEXT}`
      const task = stage === 'U01'
        ? `Acceptance ${runId} U01. Use read to read target.txt; then edit or write its entire content to exactly ${USABILITY_FILE_TEXT}; then read target.txt again to verify. Do not use shell or change any other file. Remember the conversation marker ${memory}; do not write it to any file or echo it now. Return exactly ${USABILITY_FILE_TEXT}.`
        : `Acceptance ${runId} U02. Use read to read target.txt without modifying files or using shell. Recall the conversation marker from the previous task; it is not stored in a file. Return exactly USABILITY_CONTINUE_OK|<previous conversation marker>|<current target.txt content>, without extra text or a trailing file newline.`
      const request = { task, context_id: stages[0]?.response.context_id ?? contextId, workspace_root: manifest.workspaceRoot,
        permission_scope: { fileAccess: stage === 'U01' ? 'workspace_write' : 'read_only', shellCommands: [] } }
      const client = (dependencies.createClient ?? ((name, repo, environment) => new McpStdioClient(name, repo, environment)))(`usability-${stage}`, prepared.repoRoot, env)
      currentClient = client
      let reservation: ReturnType<typeof tryReserve> | undefined, response: UsabilityRound['response'] = {}, sdk = emptySdk()
      let idleVerified = false, sharedIdentityUnchanged = false, clientClosed = false
      let state: State | undefined
      try {
        await client.start()
        await manager.assertIdentity(identity)
        check(!streamFault && sha(readFileSync(ledgerPath)) === expectedLedger, 'usability_identity_stream_or_budget_changed')
        if (stage === 'U02') {
          const previous = readState(manifest.contextDatabasePath, contextId)
          check(previous.context?.session_id === stages[0]!.response.session_id && previous.context?.workspace_root === manifest.workspaceRoot
            && previous.lease === null && previous.quarantine === null, 'usability_continuation_mapping_unsafe')
        }
        reservation = tryReserve(ledgerPath, `${ledgerPath}.lock`, { runId, caseId: `usability-${stage}`, input: request,
          recordInput: { context_id: request.context_id, workspace_root: request.workspace_root, modelOmitted: true, permission_scope: request.permission_scope, taskSHA256: sha(task) } })
        check(reservation.seq === budgetBefore + stages.length + 1, 'usability_budget_sequence_changed')
        submittedRequestId = client.requestId
        const rpc = await client.callTool(request)
        response = rpc?.result?.structuredContent ?? { status: 'failed', error_code: 'missing_mcp_output' }
        check(typeof response.session_id === 'string', 'usability_session_missing')
        sdk = await (dependencies.collectSdk ?? sdkEvidence)(api, events, response.session_id!, task, eventStart, boundedSdk)
        await api.session.wait({ sessionID: response.session_id! }, { signal: AbortSignal.timeout(5_000) })
        idleVerified = true
      } catch (error) { faults.push(`execution:${errorType(error)}`) }
      finally {
        submittedRequestId = undefined
        try { await client.close(); clientClosed = client.exited && client.exitCode === 0; if (!clientClosed) faults.push('mcp_exit_not_clean') } catch (error) { faults.push(`mcp_close:${errorType(error)}`) }
        currentClient = undefined
      }
      try { state = readState(manifest.contextDatabasePath, contextId) } catch (error) { faults.push(`context_read:${errorType(error)}`) }
      try { await manager.assertIdentity(identity); sharedIdentityUnchanged = true } catch { faults.push('shared_identity_changed') }
      if (streamFault) faults.push(streamFault)
      const ownEvents = events.slice(eventStart).filter((row) => row.event?.data?.sessionID === response.session_id)
      const inboxCount = ownEvents.filter((row) => row.event.type === 'session.inbox.enqueued').length
      if (inboxCount > (reservation ? 1 : 0)) {
        for (let count = reservation ? 1 : 0; count < inboxCount; count++) recordUnexpectedSubmission(ledgerPath, `${ledgerPath}.lock`, runId, `usability-${stage}`, { task: 'unexpected extra usability inbox' })
        faults.push('unexpected_extra_prompt')
      }
      const cleanupDiagnostic = client.diagnostics.find((row) => row.event === 'task_cleanup_complete' && row.correlationId === sha(contextId).slice(0, 16))
      const cleanup = cleanupDiagnostic?.cleanup as Record<string, any> | undefined
      const cleanupVerified = cleanup?.idleVerified === true && cleanup.denyAllVerified === true && cleanup.leaseReleased === true
        && cleanup.quarantined === false && Array.isArray(cleanup.errors) && cleanup.errors.length === 0
      let after: Record<string, string> = {}, targetText = ''
      try { after = takeFiles(); targetText = readFileSync(target, 'utf8') } catch (error) { faults.push(`files:${errorType(error)}`) }
      const classification = classifyUsabilityRound({ stage, response, expectedContext: contextId, previousSession: stages[0]?.response.session_id,
        previousPrompt: stages[0]?.sdkPromptId ?? undefined, sdk, inboxCount, target, workspace: manifest.workspaceRoot, targetText, before, after, expectedReply,
        idleVerified, sharedIdentityUnchanged, clientClosed, cleanupVerified,
        mappingVerified: state?.context?.session_id === response.session_id && state?.context?.workspace_root === manifest.workspaceRoot,
        leaseAbsent: state?.lease === null, quarantineAbsent: state?.quarantine === null, faults })
      const round: RoundRecord = { stage, classification, response: { status: response.status, context_id: response.context_id, session_id: response.session_id, error_code: response.error_code },
        sdkPromptId: sdk.sdkPromptId, sdk: safeSdk(sdk, manifest.workspaceRoot, target), request: { context_id: request.context_id, permission_scope: request.permission_scope, modelOmitted: true, taskSHA256: sha(task) },
        reply: { matchesExpected: response.result?.trim() === expectedReply, sha256: sha(response.result ?? '') }, reservation: reservation ?? null, inboxCount,
        files: { before, after }, cleanup, contextState: state, sharedIdentityUnchanged, client: { pid: client.pid, exited: client.exited, exitCode: client.exitCode, closed: clientClosed },
        idleVerified, diagnostics: sanitize(client.diagnostics), events: response.session_id ? safeCase3Events(events.slice(eventStart), response.session_id) : [], faults }
      stages.push(round)
      writeFileSync(join(evidenceDir, `usability-${stage}.json`), JSON.stringify(round, null, 2), { flag: 'wx' })
      if (reservation) appendCompletion(ledgerPath, { seq: reservation.seq, runId, caseId: `usability-${stage}`, status: classification.verdict,
        reason: classification.reason, responseStatus: response.status ?? null, sessionId: response.session_id ?? null, promptCount: inboxCount, endedAt: new Date().toISOString() })
      expectedLedger = sha(readFileSync(ledgerPath))
      saveManifest(prepared, { contextIds: { ...(manifest as any).contextIds, usability: contextId } })
      overall = ledgerAppendIsOwn() ? classification : { verdict: 'FAIL', reason: 'usability_budget_changed_externally' }
      if (overall.verdict === 'FAIL') break
      if (classification.verdict !== 'PASS') break
    }
    if (stages.length === 2 && stages.every((stage) => stage.classification.verdict === 'PASS')) overall = { verdict: 'PASS', reason: 'default_model_edit_and_persistent_continuation_usable' }
  } finally {
    observer.abort()
    if (pump) { try { await bounded(pump, 3_000, 'usability_event_drain_timeout') } catch { overall = { verdict: 'FAIL', reason: 'event_stream_drain_failed' } } }
    if (streamFault) overall = { verdict: 'FAIL', reason: streamFault }
    try { await manager.assertIdentity(identity); finalIdentity = true } catch { overall = { verdict: 'FAIL', reason: 'shared_identity_changed' } }
    try { await bounded(manager.close(), 3_000, 'usability_connection_close_timeout') } catch { overall = { verdict: 'FAIL', reason: 'connection_close_failed' } }
    if (started) {
      if (!ledgerAppendIsOwn()) overall = { verdict: 'FAIL', reason: 'usability_budget_changed_externally' }
      if (overall.verdict === 'PASS' && stages.length === 2 && finalIdentity) {
        try {
          writeFileSync(join(evidenceDir, 'usability-cleanup-intent.json'), JSON.stringify({ runId, root: manifest.tempRoot, sharedIdentityVerified: true, stagesClean: true }), { flag: 'wx' })
          removeOwnedTree(manifest.tempRoot, SYSTEM_TEMP_ROOT)
          localCleanup = { deleted: true, root: manifest.tempRoot }
          writeFileSync(join(evidenceDir, 'usability-cleanup-completion.json'), JSON.stringify(localCleanup), { flag: 'wx' })
          saveManifest(prepared, { readiness: 'blocked', localRootRemoved: true })
        } catch (error) { overall = { verdict: 'FAIL', reason: `local_cleanup:${errorType(error)}` }; localCleanup = { deleted: !existsSync(manifest.tempRoot), reason: overall.reason } }
      }
      const currentLedger = readFileSync(ledgerPath)
      const oldBudgetPrefixUnchanged = currentLedger.subarray(0, ledgerBefore.length).equals(ledgerBefore)
      if (!oldBudgetPrefixUnchanged) overall = { verdict: 'FAIL', reason: 'historical_budget_changed' }
      record = { evidenceVersion: 1, runId, model: PINNED_MODEL, modelOverrideOmitted: true, memoryMarkerSHA256: sha(memory), classification: overall, stages,
        U02Skipped: stages.length < 2, sharedIdentity: identity, finalIdentityVerified: finalIdentity,
        budget: { before: budgetBefore, after: usedSlots(ledgerPath), limit: PROMPT_BUDGET, oldPrefixUnchanged: oldBudgetPrefixUnchanged }, localCleanup }
      writeFileSync(join(evidenceDir, 'usability.json'), JSON.stringify(record, null, 2), { flag: 'wx' })
      writeFileSync(markerPath, JSON.stringify({ status: 'finished', runId, contextId, classification: overall, stages: stages.length, finishedAt: new Date().toISOString() }, null, 2))
    }
  }
  check(record, 'usability_no_result')
  return record
}
function boundedSdk<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> { return bounded(promise, milliseconds, label) }
