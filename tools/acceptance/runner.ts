import { appendCompletion, recordUnexpectedSubmission, tryReserve, type PromptInput } from './budget.js'
import { classifyCase, currentTurn, sdkEvidence, type EventRecord, type SdkEvidence } from './evidence.js'
import { createPrivateWorkspace, hashTree, readContextState } from './runtime.js'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { casesForPhase } from './phases.js'

export interface AcceptanceCase {
  seq: number
  id: string
  task: string
  context: string
  workspace: string
  action: string
  fileAccess: 'read_only' | 'workspace_write'
  shellCommands: string[]
  kind: string
  expect: string
}

export function assertPromptEvidenceIsCurrent(task: string, sessionId: string, events: EventRecord[], eventStartIndex: number, messages: any[]) {
  const turn = currentTurn(messages, task, events, eventStartIndex, sessionId)
  if (!turn.user || turn.inboxIDs.length !== 1 || turn.deliveredInboxIDs.length !== 1 || turn.stepAssistantMessageIDs.length === 0) {
    throw new Error('SDK prompt lifecycle evidence is not linked to this request inbox and its assistant step IDs.')
  }
  return turn
}

export function assertCancellationMayBeSent(task: string, sessionId: string | null, events: EventRecord[], eventStartIndex: number): { inboxID: string; assistantMessageIDs: string[] } {
  if (!sessionId) throw new Error('Cannot cancel before a current SDK inbox identifies the session.')
  const turnEvents = events.slice(eventStartIndex).filter((row) => row.event?.data?.sessionID === sessionId)
  let activeInbox: string | undefined
  let activeTask: string | undefined
  let activeInboxDelivered = false
  const steps: string[] = []
  for (const row of turnEvents) {
    const event = row.event
    if (event?.type === 'session.inbox.enqueued') {
      activeInbox = typeof event?.data?.inboxID === 'string' ? event.data.inboxID : undefined
      activeTask = event?.data?.item?.payload?.text
      activeInboxDelivered = false
      steps.length = 0
    } else if (event?.type === 'session.inbox.delivered' && event?.data?.inboxID === activeInbox) activeInboxDelivered = true
    else if (activeTask === task && activeInboxDelivered && event?.type === 'session.step.started' && typeof event?.data?.assistantMessageID === 'string') steps.push(event.data.assistantMessageID)
  }
  const enqueued = turnEvents.find((row) => row.event?.type === 'session.inbox.enqueued' && row.event?.data?.item?.payload?.text === task && row.event?.data?.inboxID === activeInbox && activeTask === task)
  if (!enqueued || typeof enqueued.event?.data?.inboxID !== 'string') throw new Error('Cannot cancel before the SDK confirms the current prompt was enqueued.')
  const inboxID = enqueued.event.data.inboxID as string
  if (!activeInboxDelivered || steps.length === 0) throw new Error('Cancellation is allowed only after this inbox is delivered and execution is started.')
  return { inboxID, assistantMessageIDs: steps }
}

export function assertUnexpectedPromptIsCountedBeforeStop(input: { submitted: boolean; ledgerPath: string; lockPath: string; runId: string; caseId: string; task: string }): void {
  if (!input.submitted) return
  tryReserve(input.ledgerPath, input.lockPath, { runId: input.runId, caseId: input.caseId, input: { task: input.task }, maximum: Number.MAX_SAFE_INTEGER,
    reason: 'Unexpected SDK inbox submission during a zero-prompt check; count it and stop.', unexpected: true })
  throw new Error('Unexpected SDK prompt was submitted during a zero-prompt check; it was counted and acceptance must stop.')
}

export function classifyCancellationEvidence(input: { sdkPromptId?: string | null; inboxIDs?: string[]; denyAllVerified: boolean; eventTypes: string[]; response: unknown; transportFailureType?: string | null }): string {
  const confirmedSafe = Boolean(input.sdkPromptId && input.inboxIDs?.length === 1 && input.denyAllVerified &&
    input.eventTypes.includes('session.execution.interrupted') && input.eventTypes.includes('session.idle'))
  if (!confirmedSafe) return 'UNVERIFIED_CANCELLATION'
  if (input.response) return 'CANCELED_WITH_MCP_RESULT'
  if (!input.transportFailureType || input.transportFailureType === 'CanceledWithoutMcpResponse') return 'CANCELED_EXPECTED_NO_MCP_RESPONSE'
  return 'UNVERIFIED_CANCELLATION'
}

export async function runReservedCase(input: {
  ledgerPath: string
  lockPath: string
  runId: string
  row: AcceptanceCase
  request: PromptInput
  submit: () => Promise<unknown>
  evidence: () => Promise<SdkEvidence>
  appendResult?: typeof appendCompletion
}): Promise<{ reservation: { seq: number; reservedAt: string }; response: unknown; evidence: SdkEvidence }> {
  // Persist the reservation before the call that may enqueue an SDK inbox.
  const reservation = tryReserve(input.ledgerPath, input.lockPath, { runId: input.runId, caseId: input.row.id, input: input.request })
  let response: unknown
  try { response = await input.submit() }
  catch (error) {
    (input.appendResult ?? appendCompletion)(input.ledgerPath, { seq: reservation.seq, runId: input.runId, caseId: input.row.id,
      status: 'ERROR_AFTER_RESERVE', submitted: 'unknown', errorType: error instanceof Error ? error.name : 'UnknownError' })
    throw error
  }
  const evidence = await input.evidence()
  return { reservation, response, evidence }
}

export function orderAcceptanceCases<T extends { seq: number }>(cases: T[]): T[] {
  if (cases.length !== 16 || cases.some((row, index) => row.seq !== index + 1)) throw new Error('Acceptance matrix must contain the reviewed 16 prompt cases in sequence.')
  return [...cases]
}

function sha256(data: Buffer | string): string { return createHash('sha256').update(data).digest('hex') }
function sanitizeText(value: string): string { return value.replace(/(authorization|password|token|api[-_]?key)\s*[:=]?\s*[^\s,;]+/giu, '$1=[redacted]').slice(0, 1000) }
const delay = (ms: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message) }
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout
  return Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms.`)), ms) })]).finally(() => clearTimeout(timer!))
}

function trackedTree(workspace: string, outsideRoot: string): Record<string, string> {
  return {
    ...hashTree(workspace),
    ...Object.fromEntries(Object.entries(hashTree(outsideRoot)).map(([path, hash]) => [`../outside/${path}`, hash])),
  }
}

export async function runAcceptance(input: {
  api: any
  env: NodeJS.ProcessEnv
  tempRoot: string
  runId: string
  eventBuffer: EventRecord[]
  clientA: any
  clientB: any
  evidenceDir: string
  cases: AcceptanceCase[]
  budgetPath: string
  budgetLockPath: string
  phase: 'permissions' | 'lifecycle' | 'final'
  contextIds: Record<string, string>
  continuation?: { staleContext: string; staleSessionId: string; staleWorkspace: string }
}): Promise<Record<string, unknown>> {
  const { api, env, tempRoot, runId, eventBuffer, clientA, clientB, evidenceDir, budgetPath, budgetLockPath } = input
  const cases = orderAcceptanceCases(input.cases)
  const phaseCases = casesForPhase(cases, input.phase)
  const workspaceRoot = join(tempRoot, 'workspace')
  const outsideRoot = join(workspaceRoot, 'outside')
  mkdirSync(outsideRoot, { recursive: true })
  if (!existsSync(join(outsideRoot, 'sentinel.txt'))) writeFileSync(join(outsideRoot, 'sentinel.txt'), 'outside baseline\n', 'utf8')
  const workspaceByName = new Map<string, string>()
  for (const row of cases) if (!workspaceByName.has(row.workspace)) workspaceByName.set(row.workspace, createPrivateWorkspace(workspaceRoot, row.workspace))
  const contexts = new Map<string, string>(Object.entries(input.contextIds))
  const contextId = (name: string): string => { if (!contexts.has(name)) contexts.set(name, randomUUID()); return contexts.get(name)! }
  const outcomes: Record<string, any>[] = []
  const subscription = new AbortController()
  let eventFailure: string | null = null
  let readyResolve!: () => void
  const ready = new Promise<void>((resolveReady) => { readyResolve = resolveReady })
  const pump = (async () => {
    try {
      for await (const event of api.event.subscribe({ signal: subscription.signal })) {
        eventBuffer.push({ at: new Date().toISOString(), event })
        if (event.type === 'server.connected') readyResolve()
      }
      if (!subscription.signal.aborted) eventFailure = 'EventStreamEndedUnexpectedly'
    } catch (error) { if (!subscription.signal.aborted) eventFailure = error instanceof Error ? error.name : 'UnknownError' }
  })()
  const runOne = async (row: AcceptanceCase, client: any, options: { cancelAfterMs?: number; context?: string } = {}): Promise<Record<string, any>> => {
    const workspace = workspaceByName.get(row.workspace)
    if (!workspace) throw new Error(`Missing isolated workspace for case ${row.id}.`)
    const selectedContext = options.context ?? row.context
    const context = contextId(selectedContext)
    const request: PromptInput = { task: row.task, workspace_root: workspace, context_id: context, model: 'opencode-go/deepseek-v4.1-flash',
      permission_scope: { fileAccess: row.fileAccess, shellCommands: row.shellCommands } }
    const targetFile = /outside/u.test(row.id) ? join(outsideRoot, 'sentinel.txt') : join(workspace, 'sentinel.txt')
    const trackedBefore = { target: existsSync(targetFile) ? sha256(readFileSync(targetFile)) : null, outside: sha256(readFileSync(join(outsideRoot, 'sentinel.txt'))), tree: trackedTree(workspace, outsideRoot) }
    const reservation = tryReserve(budgetPath, budgetLockPath, { runId, caseId: row.id, input: request })
    const requestId = client.requestId
    const startedAt = new Date().toISOString()
    const eventStartIndex = eventBuffer.length
    let exchange: any = null
    let transportFailureType: string | null = null
    let pendingCancellation: Promise<any> | undefined
    let cancellationSent = false
    let resultWritten = false
    const persistUnexpected = (error: unknown): void => {
      if (resultWritten) return
      appendCompletion(budgetPath, { seq: reservation.seq, runId, caseId: row.id, endedAt: new Date().toISOString(), status: 'ERROR_AFTER_RESERVE',
        errorType: error instanceof Error ? error.name : 'UnknownError', promptSHA256: sha256(request.task ?? ''), submitted: 'unknown' })
      resultWritten = true
    }
    try {
      if (options.cancelAfterMs) {
        pendingCancellation = client.callTool(request, 35_000).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          transportFailureType = /Timed out waiting for tools\/call/u.test(message) ? 'CanceledWithoutMcpResponse' : error instanceof Error ? error.name : 'UnknownError'
          return null
        })
        const deadline = Date.now() + options.cancelAfterMs
        let cancelEvidence: { inboxID: string; assistantMessageIDs: string[] } | undefined
        while (Date.now() < deadline) {
          const queued = eventBuffer.slice(eventStartIndex).find((item) => item.event?.type === 'session.inbox.enqueued' && item.event?.data?.item?.payload?.text === row.task)
          if (queued?.event?.data?.sessionID) {
            try { cancelEvidence = assertCancellationMayBeSent(row.task, queued.event.data.sessionID, eventBuffer, eventStartIndex); break } catch { /* wait for delivery and this inbox's execution step */ }
          }
          if (transportFailureType || eventFailure) break
          await delay(100)
        }
        const queued = eventBuffer.slice(eventStartIndex).find((item) => item.event?.type === 'session.inbox.enqueued' && item.event?.data?.item?.payload?.text === row.task)
        if (!queued?.event?.data?.sessionID) throw new Error(`Cancel case ${row.id} never reached SDK inbox submission; stop without retry.`)
        cancelEvidence = assertCancellationMayBeSent(row.task, queued.event.data.sessionID, eventBuffer, eventStartIndex)
        if (!cancelEvidence.inboxID) throw new Error(`Cancel case ${row.id} did not reach execution; stop without retry.`)
        client.cancel(requestId)
        cancellationSent = true
        exchange = await Promise.race([pendingCancellation, delay(18_000).then(() => null)])
        if (!exchange) transportFailureType ??= 'CanceledWithoutMcpResponse'
      } else {
        try { exchange = await client.callTool(request, 150_000) }
        catch (error) { transportFailureType = error instanceof Error ? error.name : 'UnknownError' }
      }
      const endedAt = new Date().toISOString()
      const result = exchange?.result?.structuredContent ?? null
      let sessionId: string | null = result?.session_id ?? null
      let contextState: any
      try { contextState = readContextState(env.OPENCODE_CONTEXT_DB_PATH!, context) } catch (error) { contextState = { readError: error instanceof Error ? error.name : 'UnknownError' } }
      if (!sessionId) sessionId = contextState?.context?.session_id ?? null
      let sdk: SdkEvidence = { session: null, sessionModel: null, modelVerified: false, assistantModelsVerified: false, sdkPromptAt: null, sdkPromptId: null,
        assistantMessages: [], messageCosts: [], permissionEvents: [], toolResults: [], denyAllVerified: false }
      if (sessionId) { try { sdk = await sdkEvidence(api, eventBuffer, sessionId, row.task, eventStartIndex, withTimeout) } catch (error) { sdk.captureFailure = error instanceof Error ? error.name : 'UnknownError' } }
      const trackedAfter = { target: existsSync(targetFile) ? sha256(readFileSync(targetFile)) : null, outside: sha256(readFileSync(join(outsideRoot, 'sentinel.txt'))), tree: trackedTree(workspace, outsideRoot) }
      const sessionEvents = eventBuffer.slice(eventStartIndex).filter((item) => item.event?.data?.sessionID === sessionId).map((item) => ({ type: item.event.type, at: item.at, data: item.event.data }))
      const cancelEvents = sessionEvents.map((item) => item.type)
      const classification = options.cancelAfterMs ? classifyCancellationEvidence({ sdkPromptId: sdk.sdkPromptId, inboxIDs: sdk.inboxIDs, denyAllVerified: sdk.denyAllVerified,
        eventTypes: cancelEvents, response: exchange, transportFailureType }) : classifyCase(row, sdk, trackedBefore, trackedAfter, workspace, targetFile)
      const record = { id: row.id, sequence: reservation.seq, client: client.name, context: selectedContext, contextId: context, contextState, workspace,
        submitted: true, startedAt, endedAt, mcpRequestId: requestId, mcpTransportFailureType: transportFailureType, mcpError: exchange?.error ?? null, result,
        visibleText: exchange?.result?.content?.filter((part: any) => part.type === 'text').map((part: any) => part.text) ?? [], sessionId,
        sdkPromptAt: sdk.sdkPromptAt, sdkPromptId: sdk.sdkPromptId, inboxIDs: sdk.inboxIDs ?? [], deliveredInboxIDs: sdk.deliveredInboxIDs ?? [], stepAssistantMessageIDs: sdk.stepAssistantMessageIDs ?? [],
        relevantSdkEvents: sessionEvents, permissionEvents: sdk.permissionEvents, toolResults: sdk.toolResults, assistantMessages: sdk.assistantMessages, messageCosts: sdk.messageCosts,
        denyAllVerified: sdk.denyAllVerified, sessionModel: sdk.sessionModel, modelVerified: sdk.modelVerified, assistantModelsVerified: sdk.assistantModelsVerified,
        trackedBefore, trackedAfter, classification, expected: row.expect }
      appendCompletion(budgetPath, { seq: reservation.seq, runId, caseId: row.id, endedAt, status: result?.status ?? transportFailureType ?? 'no-tool-result', sessionId,
        sdkPromptAt: sdk.sdkPromptAt, sdkPromptId: sdk.sdkPromptId, promptSHA256: sha256(request.task ?? ''), permissionEvents: sdk.permissionEvents, toolResults: sdk.toolResults,
        messageCosts: sdk.messageCosts, trackedBefore, trackedAfter, denyAllVerified: sdk.denyAllVerified, classification })
      resultWritten = true
      writeFileSync(join(evidenceDir, `${row.id}.json`), JSON.stringify(record, null, 2), 'utf8')
      outcomes.push(record)
      if (eventFailure) throw new Error(`SDK event stream failed: ${eventFailure}`)
      const expectedMissingCancelResponse = Boolean(options.cancelAfterMs && cancellationSent && classification === 'CANCELED_EXPECTED_NO_MCP_RESPONSE')
      if (result?.error_code === 'provider_quota' || result?.error_code === 'event_stream_failed' || result?.status === 'failed' || (transportFailureType && !expectedMissingCancelResponse)) throw new Error(`Provider, event stream, directory, or transport fault on ${row.id}; stop immediately.`)
      if (!sdk.modelVerified || (sdk.assistantMessages.length > 0 && !sdk.assistantModelsVerified)) throw new Error(`SDK model mismatch on ${row.id}.`)
      if (classification === 'UNSAFE_MUTATION' || classification === 'DENY_ALL_NOT_VERIFIED' || classification.startsWith('UNVERIFIED')) throw new Error(`Safety check failed for ${row.id}: ${classification}`)
      if (!options.cancelAfterMs && (!sdk.sdkPromptId || sdk.inboxIDs?.length !== 1 || sdk.deliveredInboxIDs?.length !== 1 || sdk.stepAssistantMessageIDs?.length === 0)) throw new Error(`SDK prompt lifecycle evidence missing or duplicated after ${row.id}; stop.`)
      if (options.cancelAfterMs && sdk.inboxIDs?.length !== 1) throw new Error(`Canceled prompt inbox evidence missing or duplicated for ${row.id}; stop.`)
      return record
    } catch (error) {
      if (pendingCancellation) {
        if (!cancellationSent) {
          const queued = eventBuffer.slice(eventStartIndex).find((item) => item.event?.type === 'session.inbox.enqueued' && item.event?.data?.item?.payload?.text === row.task)
          const sessionId = queued?.event?.data?.sessionID
          if (sessionId) {
            try { assertCancellationMayBeSent(row.task, sessionId, eventBuffer, eventStartIndex); client.cancel(requestId); cancellationSent = true } catch { /* no verified current execution; wait for its bounded response */ }
          }
        }
        await Promise.race([pendingCancellation, delay(5_000)])
      }
      persistUnexpected(error)
      throw error
    }
  }

  try {
    await Promise.all([clientA.start(), clientB.start()])
    await Promise.race([ready, delay(12_000).then(() => { throw new Error('OpenCode event stream did not become ready.') })])
    if (input.phase === 'permissions') {
      for (const row of phaseCases) await runOne(row, clientA)
      const result = { runId, phase: input.phase, status: 'completed', reservedSubmissions: outcomes.length, contextIds: Object.fromEntries(contexts), outcomes: outcomes.map(({ id, classification }) => ({ id, classification })) }
      writeFileSync(join(evidenceDir, 'phase-permissions.json'), JSON.stringify(result, null, 2), 'utf8')
      return result
    }

    if (input.phase === 'lifecycle') {
      const canceled = phaseCases[0]!
      const followup = phaseCases[1]!
      const canceledContext = contextId(canceled.context)
      const canceledSession = (await runOne(canceled, clientA, { cancelAfterMs: 15_000, context: canceled.context })).sessionId
      const state = readContextState(env.OPENCODE_CONTEXT_DB_PATH!, canceledContext)
      const cancelEvents = eventBuffer.filter((item) => item.event?.data?.sessionID === canceledSession).map((item) => item.event.type)
      const oldContextSafe = Boolean(state?.context && state.context.session_id === canceledSession && !state.quarantine && cancelEvents.includes('session.execution.interrupted') && cancelEvents.includes('session.idle'))
      await runOne(followup, clientA, { context: oldContextSafe ? followup.context : `${followup.context}-recovery-new` })
      const concurrentRows = phaseCases.slice(2, 4)
      const [raceA, raceB] = await Promise.all([runOne(concurrentRows[0]!, clientA), runOne(concurrentRows[1]!, clientB)])
      const overlaps = Date.parse(raceA.startedAt) < Date.parse(raceB.endedAt) && Date.parse(raceB.startedAt) < Date.parse(raceA.endedAt)
      const distinctSessions = Boolean(raceA.sessionId && raceB.sessionId && raceA.sessionId !== raceB.sessionId)
      const uniqueTokens = raceA.visibleText.join('\n').includes('marker:client-a') && raceB.visibleText.join('\n').includes('marker:client-b')
      const independentContexts = raceA.contextId !== raceB.contextId && raceA.workspace !== raceB.workspace
      const concurrencyEvidence = { overlap: overlaps, distinctSessions, uniqueTokens, independentContexts, sessionIDs: [raceA.sessionId, raceB.sessionId], contextIDs: [raceA.contextId, raceB.contextId] }
      writeFileSync(join(evidenceDir, 'I-concurrency.json'), JSON.stringify(concurrencyEvidence, null, 2), 'utf8')
      check(overlaps && distinctSessions && uniqueTokens && independentContexts, 'Concurrency did not prove overlap and distinct context/session/workspace isolation.')
      const continuation = { staleContext: contextId(concurrentRows[1]!.context), staleSessionId: raceB.sessionId, staleWorkspace: workspaceByName.get(concurrentRows[1]!.workspace)! }
      const result = { runId, phase: input.phase, status: 'completed', reservedSubmissions: outcomes.length, contextIds: Object.fromEntries(contexts), continuation,
        outcomes: outcomes.map(({ id, classification }) => ({ id, classification })), concurrencyEvidence }
      writeFileSync(join(evidenceDir, 'phase-lifecycle.json'), JSON.stringify(result, null, 2), 'utf8')
      return result
    }

    const continuation = input.continuation
    check(continuation?.staleContext && continuation.staleSessionId && continuation.staleWorkspace, 'Final phase needs verified lifecycle-phase continuation evidence.')
    const beforeStaleEvents = eventBuffer.length
    const oldMappingBefore = readContextState(env.OPENCODE_CONTEXT_DB_PATH!, continuation.staleContext)
    await api.session.remove({ sessionID: continuation.staleSessionId })
    let missingConfirmed = false
    try { await api.session.get({ sessionID: continuation.staleSessionId }) } catch { missingConfirmed = true }
    check(missingConfirmed, 'Deleted session remained readable; stop before stale-context check.')
    const staleInput: PromptInput = { task: 'Read marker.txt and reply with its exact contents. Do not modify files or use shell.', workspace_root: continuation.staleWorkspace, context_id: continuation.staleContext,
      model: 'opencode-go/deepseek-v4.1-flash', permission_scope: { fileAccess: 'read_only', shellCommands: [] } }
    const staleReply = await clientB.callTool(staleInput, 30_000).catch((error: unknown) => ({ transportError: error instanceof Error ? error.name : 'UnknownError' }))
    await delay(500)
    const lifecycleTypes = ['session.created', 'session.inbox.enqueued', 'session.execution.started', 'session.step.started']
    const promptLifecycleEvents = eventBuffer.slice(beforeStaleEvents).filter((item) => lifecycleTypes.includes(item.event?.type))
    const staleResult = (staleReply as any)?.result?.structuredContent
    const oldMappingAfter = readContextState(env.OPENCODE_CONTEXT_DB_PATH!, continuation.staleContext)
    const mappingUnchanged = JSON.stringify(oldMappingBefore?.context ?? null) === JSON.stringify(oldMappingAfter?.context ?? null)
    const failed = staleResult?.status === 'failed'
    const noNewSessionID = !staleResult?.session_id || staleResult.session_id === continuation.staleSessionId
    const unexpectedSubmitted = promptLifecycleEvents.some((item) => item.event?.type === 'session.inbox.enqueued')
    if (unexpectedSubmitted) recordUnexpectedSubmission(budgetPath, budgetLockPath, runId, 'D00-UNEXPECTED_SUBMISSION', staleInput)
    const staleCheck = { deletionRequested: true, deletedSessionUnreadable: missingConfirmed, oldContext: continuation.staleContext, response: staleResult ?? null,
      transportError: (staleReply as any)?.transportError ?? null, oldSessionId: continuation.staleSessionId, responseSessionId: staleResult?.session_id ?? null, failed, noNewSessionID,
      promptLifecycleEvents, oldMappingBefore, oldMappingAfter, mappingUnchanged,
      zeroPrompt: failed && noNewSessionID && promptLifecycleEvents.length === 0 && mappingUnchanged, unexpectedSubmitted }
    appendCompletion(budgetPath, { runId, caseId: 'D00-stale-context', ...staleCheck, capturedAt: new Date().toISOString() })
    writeFileSync(join(evidenceDir, 'D00-stale-context.json'), JSON.stringify(staleCheck, null, 2), 'utf8')
    check(staleCheck.zeroPrompt, 'Stale context created a replacement session or prompt event; stop.')
    await runOne(phaseCases[0]!, clientB)
    await runOne(phaseCases[1]!, clientB)
    const result = { runId, phase: input.phase, status: 'completed', reservedSubmissions: outcomes.length, contextIds: Object.fromEntries(contexts), outcomes: outcomes.map(({ id, classification }) => ({ id, classification })), zeroPromptStaleContextCheck: staleCheck }
    writeFileSync(join(evidenceDir, 'phase-final.json'), JSON.stringify(result, null, 2), 'utf8')
    return result
  } finally {
    subscription.abort()
    const closeResults = await Promise.allSettled([clientA.close(), clientB.close()])
    const closeFailure = closeResults.find((item) => item.status === 'rejected')
    const streamStopped = await Promise.race([pump.then(() => true), delay(2_000).then(() => false)])
    if (!streamStopped) throw new Error('SDK event stream did not stop within the close deadline.')
    if (closeFailure?.status === 'rejected') throw new Error(`MCP stdio client failed to close: ${sanitizeText(String(closeFailure.reason))}`)
  }
}
