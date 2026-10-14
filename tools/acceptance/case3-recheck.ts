import { existsSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { LIVE_LEDGER } from './budget.js'
import { resolveRegistryPath } from '../../src/service-registry.js'
import { currentTurn, strictInside, type EventRecord, type SdkEvidence as EvidenceSdkEvidence } from './evidence.js'
import { SYSTEM_TEMP_ROOT, type ServiceIdentity } from './runtime.js'

// Pure validation + evidence classification for the Case 3 recheck.
//
// Scope: this module performs NO live / preflight / shell execution and holds
// NO run entry point (added separately). It never mutates the manifest or any
// tracked input; every check is a read-only decision over collected data.

export const CASE3_FIXED_GO_MODEL = 'opencode-go/deepseek-v4.1-flash'
export const CASE3_RUN_INVALID = 'CASE3_RUN_INVALID'
export const CASE3_RESPONSE_ERROR_PERMISSION = 'permission_rejected'
export const CASE3_TOOL_ERROR_PERMISSION = 'permission.rejected'
// Reviewed v2.0.18 release: permission.ts -> model-request.ts -> runner/step.ts
// -> execution.terminal. An unlabelled Effect.interrupt defaults to shutdown.
export const CASE3_ABORT_SEMANTICS = Object.freeze({
  version: '2.0.18', commit: 'cd9a14a6b688d4021bee381dfd39d2cef9c0f862', reason: 'shutdown',
})

// Mirrors the existing RunManifest fields written by tools/acceptance/cli.ts.
// No new manifest schema is introduced here.
export interface Case3Manifest {
  sharedRegistryPath: string;
  sharedRegistryPathHash?: string;
  runId: string
  readiness: string
  model: string
  ledgerPath: string
  ledgerPathHash: string
  ledgerDigest: string | null
  ledgerReservations: number
  tempRoot: string
  workspaceRoot: string
  contextDatabasePath: string
  sharedService?: ServiceIdentity
  sharedServiceVersion?: string
  localRootOwnership?: { createdBy: string; runId: string; tempRoot: string }
  localRootRemoved?: boolean
}

export interface ValidateCase3RunInput {
  runId: string
  repoRoot: string
  manifest: Case3Manifest
  ledgerPath: string
  ledgerDigest: string | null
  usedSlots: number
  currentService: ServiceIdentity
  serviceVersion: string
}

export interface SdkToolEvidence {
  sessionId?: string
  requestID?: string
  sourceId: string
  assistantId: string
  name: 'shell' | 'read' | string
  status: string
  errorType?: string
  asked: boolean
  replied: boolean
  decision: string
  // Resolved read target captured from the SDK tool input. Present for read
  // calls; classification only accepts reads whose targetPath is an expected seed.
  targetPath?: string
}

export interface SdkEvidence {
  promptId: string
  model: string
  toolCalls: SdkToolEvidence[]
  // Expected seed paths captured alongside the tool stream so classification can
  // prove the reads hit both seeds without an extra caller argument.
  expectedSeeds?: string[]
}

// status carries the outcome; error_code carries the reason. A permission
// rejection is status === 'rejected' && error_code === 'permission_rejected'
// ('permission_rejected' is NOT a status value).
export interface Case3Response { status: string; error_code: string }

export interface Case3Event { sourceId: string; type: string; decision?: string; sessionId?: string; requestID?: string }
export interface Case3Diagnostics { bridgeReadAllowReply?: boolean; pendingReadsAtShellReject?: boolean; [key: string]: unknown }
export interface Case3ContextState { denyall: string; lease: string; quarantine: string }
export interface Case3AssistantError { assistantId?: string; type: string | null; status: number | null }
export interface Case3Interruption {
  serviceVersion?: string
  sessionId: string
  promptId: string
  assistantId?: string
  uniqueExecution: boolean
  reason: string | null
  localInterrupt: boolean
  executionFailed: boolean
  startedSequence: number | null
  terminalSequence: number | null
}

export interface ClassifyCase3EvidenceInput {
  response: Case3Response
  sdk: SdkEvidence
  events: Case3Event[]
  diagnostics: Case3Diagnostics
  before: Record<string, string>
  after: Record<string, string>
  markerAbsent: boolean
  sharedIdentityUnchanged: boolean
  mcpClosed: boolean
  contextState: Case3ContextState
  // The two seed files the recheck task must read. PASS requires the two
  // permission-rejected read calls to resolve to these two distinct paths.
  expectedSeeds?: string[]
  assistantErrors?: Case3AssistantError[]
  interruption?: Case3Interruption
  controlled?: boolean
  controlTrace?: Record<string, unknown>[]
  controlCaptureComplete?: boolean
}

export interface Case3Verdict { verdict: 'PASS' | 'FAIL' | 'UNVERIFIED'; reason: string }

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u

function sha256(value: string): string { return createHash('sha256').update(value).digest('hex') }
function existingRealpathEquals(target: string): boolean {
  try { return realpathSync(target) === resolve(target) } catch { return false }
}
function realInside(parent: string, child: string): boolean {
  try { return strictInside(realpathSync(parent), realpathSync(child)) } catch { return false }
}

export function validateCase3Run(input: ValidateCase3RunInput): void {
  const invalid = (): never => { throw new Error(CASE3_RUN_INVALID) }
  const { runId, repoRoot, manifest, ledgerPath, ledgerDigest, usedSlots, currentService, serviceVersion } = input

  if (!SAFE_SEGMENT.test(runId) || !manifest || manifest.runId !== runId) invalid()
  if (manifest.readiness !== 'ready') invalid()
  if (manifest.model !== CASE3_FIXED_GO_MODEL) invalid()
  try { resolveRegistryPath({ manifest }) } catch { invalid() }

  // Fixed LIVE_LEDGER: original absolute path + path hash + digest + count.
  const expectedLedger = resolve(repoRoot, LIVE_LEDGER)
  if (!isAbsolute(ledgerPath) || ledgerPath !== expectedLedger) invalid()
  if (manifest.ledgerPath !== ledgerPath) invalid()
  if (manifest.ledgerPathHash !== sha256(ledgerPath)) invalid()
  if (manifest.ledgerDigest !== ledgerDigest) invalid()
  if (manifest.ledgerReservations !== usedSlots) invalid()

  // Shared service identity id/pid/url/version must all agree.
  const shared = manifest.sharedService
  if (!shared) return invalid()
  if (shared.id !== currentService?.id || shared.pid !== currentService?.pid) invalid()
  if (shared.url !== currentService?.url || manifest.sharedServiceVersion !== serviceVersion) invalid()

  // tempRoot: must exist; realpath must equal the declared path (reject junction).
  const { tempRoot, workspaceRoot, contextDatabasePath } = manifest
  if (!isAbsolute(tempRoot) || !existsSync(tempRoot) || !existingRealpathEquals(tempRoot)) invalid()
  if (!strictInside(SYSTEM_TEMP_ROOT, tempRoot) || !realInside(SYSTEM_TEMP_ROOT, tempRoot)) invalid()

  // workspaceRoot: must exist and be the real, non-junction tempRoot/workspace.
  if (resolve(workspaceRoot) !== resolve(tempRoot, 'workspace')) invalid()
  if (!existsSync(workspaceRoot) || !existingRealpathEquals(workspaceRoot)) invalid()
  if (!strictInside(tempRoot, workspaceRoot) || !realInside(tempRoot, workspaceRoot)) invalid()

  // contextDatabasePath: if present, its real file must be the declared path;
  // if not yet created, only the real (non-junction) parent dir and the kept
  // original file name are accepted.
  if (resolve(contextDatabasePath) !== resolve(tempRoot, 'contexts.sqlite')) invalid()
  if (existsSync(contextDatabasePath)) {
    if (!existingRealpathEquals(contextDatabasePath)) invalid()
    if (!strictInside(tempRoot, contextDatabasePath) || !realInside(tempRoot, contextDatabasePath)) invalid()
  } else {
    const parent = dirname(contextDatabasePath)
    if (resolve(parent) !== resolve(tempRoot) || !existingRealpathEquals(parent)) invalid()
    if (basename(contextDatabasePath) !== 'contexts.sqlite') invalid()
  }
}

function sameFiles(a: Record<string, string>, b: Record<string, string>): boolean {
  const left = a ?? {}, right = b ?? {}
  const keys = Object.keys(left).sort(), others = Object.keys(right).sort()
  if (keys.length !== others.length) return false
  for (let i = 0; i < keys.length; i += 1) {
    if (keys[i] !== others[i] || left[keys[i]] !== right[others[i]]) return false
  }
  return true
}

function clean(value: unknown): boolean { return value === 'none' || value === 'absent' || value === 'clear' }
function isRejectEvent(event: Case3Event): boolean {
  return event.type === 'permission.replied' && event.decision === 'reject'
}

function knownRejectedTool(call: SdkToolEvidence, allowReadAbort = false): boolean {
  return call.status === 'error' && ([CASE3_TOOL_ERROR_PERMISSION, 'tool.execution'].includes(call.errorType ?? '')
    || (allowReadAbort && call.name === 'read' && call.errorType === 'aborted'))
}

function targetTools(calls: SdkToolEvidence[], expectedSeeds: string[], requireKnownError = true, allowReadAbort = false): SdkToolEvidence[] | null {
  const seeds = new Set(expectedSeeds.map((seed) => resolve(seed)))
  if (seeds.size !== 2) return null
  const byAssistant = new Map<string, SdkToolEvidence[]>()
  for (const call of calls) {
    if (!call?.assistantId || !call.sourceId) continue
    if (call.asked !== true || call.replied !== true || call.decision !== 'reject') continue
    if (requireKnownError && !knownRejectedTool(call, allowReadAbort)) continue
    const list = byAssistant.get(call.assistantId) ?? []
    list.push(call)
    byAssistant.set(call.assistantId, list)
  }
  for (const list of byAssistant.values()) {
    const shell = list.filter((call) => call.name === 'shell')
    if (shell.length < 1) continue
    // One distinct read call must cover each expected seed. A repeated read of
    // the same seed cannot pad the target set (size stays 1, so no PASS).
    const perSeed = new Map<string, SdkToolEvidence>()
    for (const call of list) {
      if (call.name !== 'read' || typeof call.targetPath !== 'string') continue
      const key = resolve(call.targetPath)
      if (!seeds.has(key) || perSeed.has(key)) continue
      perSeed.set(key, call)
    }
    if (perSeed.size !== 2) continue
    const target = [shell[0]!, ...Array.from(seeds, (seed) => perSeed.get(seed)!)]
    // Three distinct source IDs: a repeated call cannot pad the target set.
    if (new Set(target.map((call) => call.sourceId)).size === 3) return target
  }
  return null
}

export function classifyCase3Evidence(input: ClassifyCase3EvidenceInput): Case3Verdict {
  const fail = (reason: string): Case3Verdict => ({ verdict: 'FAIL', reason })
  const unverified = (reason: string): Case3Verdict => ({ verdict: 'UNVERIFIED', reason })
  const { response, sdk, events, diagnostics, before, after } = input

  // Side effects, identity drift and bad outcomes are definitive failures.
  if (response?.status === 'failed' || response?.status === 'canceled') return fail('response failed or canceled')
  if (input.sharedIdentityUnchanged === false) return fail('shared identity changed')
  if (input.markerAbsent === false) return fail('marker present after run')
  if (!sameFiles(before, after)) return fail('filesystem changed')
  if (input.contextState?.denyall !== 'verified') return fail('denyall not verified')
  if (!clean(input.contextState?.lease)) return fail('lease not clean')
  if (!clean(input.contextState?.quarantine)) return fail('quarantine not clean')
  if (input.mcpClosed === false) return fail('mcp not closed')
  if (input.interruption?.localInterrupt) return fail('independent local interruption')
  if (input.interruption?.executionFailed) return fail('execution failed')
  if (input.interruption?.reason && input.interruption.reason !== CASE3_ABORT_SEMANTICS.reason) return fail('unexpected interruption reason')
  const assistantErrors = input.assistantErrors ?? []
  if (assistantErrors.some((error) => error.type !== 'aborted' || error.status !== null)) return fail('assistant_message_error')

  // Evidence must come from the real SDK tool stream, keyed by source id.
  const calls = Array.isArray(sdk?.toolCalls) ? sdk.toolCalls : []
  if (!sdk?.promptId) return unverified('missing current-round sdk prompt id')
  if (sdk?.model !== CASE3_FIXED_GO_MODEL) return unverified('missing fixed Go model evidence')
  const needsAbortProof = assistantErrors.length > 0 || calls.some((call) => call.errorType === 'aborted')
  if (needsAbortProof && input.interruption?.serviceVersion !== CASE3_ABORT_SEMANTICS.version) {
    return assistantErrors.length ? fail('assistant_message_error: unconfirmed service version') : unverified('unconfirmed aborted tool semantics')
  }
  const target = targetTools(calls, input.expectedSeeds ?? sdk?.expectedSeeds ?? [], true, needsAbortProof)
  if (!target) return unverified('missing shell/read/read permission.rejected evidence for both expected seeds')
  if (target.some((call) => call.sessionId !== target[0]!.sessionId)
    || new Set(target.map((call) => call.requestID)).size !== 3) return unverified('target permissions are not three distinct same-session requests')

  const bySource = new Map((events ?? []).map((event) => [event.sourceId, event]))
  for (const call of target) {
    const event = bySource.get(call.sourceId)
    if (!event || !isRejectEvent(event) || !call.sessionId || !call.requestID
      || event.sessionId !== call.sessionId || event.requestID !== call.requestID) return unverified('tool evidence not correlated with source id, session and request id')
  }
  if (needsAbortProof) {
    const frame = input.interruption!
    if (calls.some((call) => call.errorType === 'aborted' && !target.includes(call))
      || assistantErrors.some((error) => error.assistantId !== target[0]!.assistantId)) return fail('aborted evidence belongs to another tool or assistant')
    if (!frame.uniqueExecution || frame.localInterrupt !== false || frame.executionFailed !== false
      || !Number.isSafeInteger(frame.startedSequence) || !Number.isSafeInteger(frame.terminalSequence)
      || frame.startedSequence === null || frame.startedSequence < 0 || frame.terminalSequence === null || frame.terminalSequence <= frame.startedSequence
      || frame.reason !== CASE3_ABORT_SEMANTICS.reason || frame.promptId !== sdk.promptId
      || frame.sessionId !== target[0]!.sessionId || frame.assistantId !== target[0]!.assistantId) return unverified('permission interruption is not uniquely correlated')
  }

  if (response?.status !== 'rejected' || response?.error_code !== CASE3_RESPONSE_ERROR_PERMISSION) return unverified('response is not a permission rejection')
  if (diagnostics?.bridgeReadAllowReply !== false) return unverified('bridge read allow reply not ruled out')
  if (diagnostics?.pendingReadsAtShellReject !== true) return unverified('both reads were not proven pending when shell rejection started')
  if (input.sharedIdentityUnchanged !== true) return unverified('shared identity state unknown')
  if (input.markerAbsent !== true) return unverified('marker state unknown')
  if (input.mcpClosed !== true) return unverified('mcp close state unknown')
  if (input.controlled && (input.controlCaptureComplete !== true || inspectCase3ControlAudit(input.controlTrace ?? [], sdk).verdict !== 'PASS')) return unverified('controlled audit incomplete')

  return { verdict: 'PASS', reason: `shell + read/read explicitly rejected, pending cascade and cleanup verified${needsAbortProof ? '; version-bound permission abort verified' : ''}` }
}

/** A barrier alone cannot prove raw/delivered completeness or target ordering. */
export function inspectCase3ControlAudit(trace: Record<string, unknown>[], sdk: SdkEvidence): Case3Verdict {
  const target = targetTools(sdk.toolCalls, sdk.expectedSeeds ?? [], false) ?? []
  const bad = (): Case3Verdict => ({ verdict: 'UNVERIFIED', reason: 'controlled audit incomplete' })
  if (target.length !== 3 || trace.length === 0 || trace.some((row, index) => row.auditSequence !== index + 1)) return bad()
  const ends = trace.filter((row) => row.kind === 'end')
  if (ends.length !== 1 || trace.at(-1) !== ends[0]) return bad()
  const raw = trace.filter((row) => row.kind === 'raw'), delivered = trace.filter((row) => row.kind === 'delivered')
  if (raw.some((row, index) => row.receiveIndex !== index + 1) || delivered.some((row, index) => row.deliveryIndex !== index + 1)
    || !['canceled', 'closed'].includes(String(ends[0]!.reason))) return bad()
  if (ends[0]!.receivedCount !== raw.length || ends[0]!.deliveredCount !== delivered.length || ends[0]!.heldCount !== 0 || raw.length !== delivered.length) return bad()
  const rawByIndex = new Map(raw.map((row) => [row.receiveIndex, row]))
  if (rawByIndex.size !== raw.length) return bad()
  const deliveredIndices = new Set<unknown>()
  for (const row of delivered) {
    const received = rawByIndex.get(row.receiveIndex)
    if (!received || deliveredIndices.has(row.receiveIndex)) return bad()
    deliveredIndices.add(row.receiveIndex)
    for (const key of ['type', 'sessionID', 'requestID', 'sequence', 'reason', 'source', 'resourceSHA256']) {
      if (JSON.stringify(row[key]) !== JSON.stringify(received[key])) return bad()
    }
  }
  const asks = delivered.filter((row) => row.type === 'permission.asked' && target.some((call) => call.requestID === row.requestID))
  if (asks.length !== 3 || asks.some((row, index) => row.requestID !== target[index]!.requestID
    || row.sessionID !== target[index]!.sessionId || (row.source as { messageID?: string; id?: string } | null)?.messageID !== target[index]!.assistantId
    || `${(row.source as { messageID?: string; id?: string } | null)?.messageID}:${(row.source as { id?: string } | null)?.id}` !== target[index]!.sourceId)) return bad()
  const barriers = trace.filter((row) => row.kind === 'barrier' && row.complete === true)
  if (barriers.length !== 1 || barriers[0]!.heldCount !== 3
    || barriers[0]!.assistantMessageID !== target[0]!.assistantId
    || JSON.stringify(barriers[0]!.requestIDs) !== JSON.stringify(target.map((call) => call.requestID))) return bad()
  if (asks.some((row) => Number(row.auditSequence) <= Number(barriers[0]!.auditSequence))
    || raw.some((row) => target.some((call) => call.requestID === row.requestID) && Number(row.auditSequence) >= Number(barriers[0]!.auditSequence))) return bad()
  return { verdict: 'PASS', reason: 'raw and delivered control audit complete' }
}

// ---- Case 3 proof collection (pure) -------------------------------------

/** Preserve request/reply and turn IDs even if later SDK message capture fails. */
export function safeCase3Events(events: EventRecord[], sessionId: string): Record<string, unknown>[] {
  return events.flatMap((row, receiveIndex) => {
    if (row.event?.data?.sessionID !== sessionId) return []
    const data = row.event.data
    const source = data.source
    return [{
      at: row.at ?? null, type: row.event.type, sessionID: sessionId,
      receiveIndex: receiveIndex + 1,
      sequence: row.event.durable?.aggregateID === sessionId && Number.isSafeInteger(row.event.durable?.seq) && row.event.durable.seq >= 0 ? row.event.durable.seq : null,
      reason: row.event.type === 'session.execution.interrupted' && ['user', 'shutdown', 'superseded', 'inactivity'].includes(data.reason) ? data.reason : null,
      requestID: typeof (data.requestID ?? data.id) === 'string' ? data.requestID ?? data.id : null,
      action: typeof data.action === 'string' ? data.action : null,
      reply: typeof data.reply === 'string' ? data.reply : null,
      source: source && typeof source.messageID === 'string' && typeof source.id === 'string' ? { messageID: source.messageID, id: source.id } : null,
      inboxID: typeof data.inboxID === 'string' ? data.inboxID : null,
      assistantMessageID: typeof data.assistantMessageID === 'string' ? data.assistantMessageID : null,
      promptSHA256: typeof data.item?.payload?.text === 'string' ? sha256(data.item.payload.text) : null,
      resourceSHA256: Array.isArray(data.resources) ? data.resources.filter((resource: unknown): resource is string => typeof resource === 'string').map(sha256) : [],
    }]
  })
}

/** Synced is a watermark, not proof that the server returned historical execution records. */
export function inspectCase3SessionLog(items: any[], sessionId: string) {
  const synced = items.filter((item) => item?.type === 'log.synced' && item.aggregateID === sessionId).at(-1)
  const executionRows = items.filter((item) => /^session\.execution\.(?:started|succeeded|failed|interrupted)$/u.test(item?.type ?? '')
    && item.data?.sessionID === sessionId)
  return { status: synced && executionRows.length ? 'EXECUTION_EVENTS_AVAILABLE' as const : 'UNVERIFIED' as const,
    watermark: Number.isSafeInteger(synced?.seq) && synced.seq >= 0 ? synced.seq as number : null,
    executionEvents: safeCase3Events(executionRows.map((event) => ({ at: '', event })), sessionId) }
}

export interface CollectCase3ProofInput {
  messages: any[]
  task: string
  sessionId: string
  events: EventRecord[]
  sdk: EvidenceSdkEvidence
  diagnostics: Record<string, unknown>[]
  seedA: string
  seedB: string
  markerRelative: string
  workspaceRoot: string
  serviceVersion?: string
}

export interface CollectCase3Proof {
  sdk: SdkEvidence
  events: Case3Event[]
  diagnostics: { bridgeReadAllowReply: boolean | undefined; pendingReadsAtShellReject: boolean }
  interruption: Case3Interruption
}

// Diagnostic hashes use the same shape as production: first 16 hex chars.
function shortHash(value: string): string { return sha256(value).slice(0, 16) }

function stringField(entry: Record<string, unknown>, key: string): string | undefined {
  const value = entry[key]
  return typeof value === 'string' ? value : undefined
}

function shellTargetsMarker(name: string, rawInput: unknown, markerRelative: string): boolean {
  if (!/^(?:bash|shell)$/iu.test(name) || !rawInput || typeof rawInput !== 'object') return false
  const command = (rawInput as Record<string, unknown>).command
  return typeof command === 'string' && command.includes(markerRelative)
}

// Resolve every path-like read target from the SDK tool input. Classification
// later proves these paths are exactly the two expected seeds.
function readTargetPaths(name: string, rawInput: unknown, workspaceRoot: string): string[] {
  if (!/^read$/iu.test(name) || !rawInput || typeof rawInput !== 'object') return []
  const input = rawInput as Record<string, unknown>
  return Object.entries(input)
    .filter(([key, value]) => /path|file/iu.test(key) && typeof value === 'string')
    .map(([, value]) => resolve(workspaceRoot, value as string))
}

function bridgeReadAllowReplyOf(diagnostics: Record<string, unknown>[], readHashes: Set<string>, shellHashes: Set<string>, tools: SdkToolEvidence[]): boolean | undefined {
  let shellRejectStarted = false
  let completedAccepted = false
  let readOnceSent = false
  for (const entry of diagnostics) {
    const event = stringField(entry, 'event') ?? ''
    const request = stringField(entry, 'request')
    const decision = stringField(entry, 'decision')
    if (!request) continue
    if (event === 'permission_reply_started' && shellHashes.has(request) && decision === 'reject') shellRejectStarted = true
    if (event === 'permission_reply_completed' && shellHashes.has(request) && stringField(entry, 'status') === 'accepted') completedAccepted = true
    if (event === 'permission_reply_started' && readHashes.has(request) && decision === 'once') readOnceSent = true
  }
  const rejected = tools.filter((call) => call.asked && call.replied && call.decision === 'reject')
  if (readOnceSent) return true
  if (shellRejectStarted && completedAccepted && rejected.length >= 3) return false
  return undefined
}

export function collectCase3Proof(input: CollectCase3ProofInput): CollectCase3Proof {
  const { messages, task, sessionId, events, sdk, diagnostics, seedA, seedB, markerRelative, workspaceRoot } = input
  const turn = currentTurn(messages, task, events, 0, sessionId)
  const seeds = new Set([resolve(workspaceRoot, seedA), resolve(workspaceRoot, seedB)])

  const askedBySource = new Map<string, string>()
  const rejectedRequests = new Set<string>()
  for (const row of events) {
    const event = row.event
    const data = event?.data
    if (data?.sessionID !== sessionId) continue
    if (event?.type === 'permission.asked') {
      const messageID = data?.source?.messageID
      const partId = data?.source?.id
      if (typeof messageID === 'string' && typeof partId === 'string' && typeof data?.id === 'string') askedBySource.set(`${messageID}:${partId}`, data.id)
    } else if (event?.type === 'permission.replied' && data?.reply === 'reject' && typeof data?.requestID === 'string') {
      rejectedRequests.add(data.requestID)
    }
  }

  const toolCalls: SdkToolEvidence[] = []
  const proofEvents: Case3Event[] = []
  for (const assistant of turn.assistant) {
    for (const part of (assistant.content ?? []).filter((item: any) => item?.type === 'tool')) {
      const state = part.state ?? {}
      const name = String(part.name ?? '')
      const sourceId = `${assistant.id}:${part.id}`
      const readTargets = readTargetPaths(name, state.input, workspaceRoot)
      const entry: SdkToolEvidence = {
        sourceId, sessionId, assistantId: String(assistant.id), name: /^(?:bash|shell)$/iu.test(name) ? 'shell' : name,
        status: String(state.status ?? ''), asked: false, replied: false, decision: '',
        ...(readTargets[0] ? { targetPath: readTargets[0] } : {}),
        ...(typeof state.error?.type === 'string' ? { errorType: state.error.type } : {}),
      }
      const isTarget = shellTargetsMarker(name, state.input, markerRelative) || readTargets.some((target) => seeds.has(target))
      if (isTarget) {
        const requestId = askedBySource.get(sourceId)
        if (requestId) { entry.asked = true; entry.requestID = requestId }
        if (requestId && rejectedRequests.has(requestId)) {
          entry.replied = true
          entry.decision = 'reject'
          proofEvents.push({ sourceId, sessionId, requestID: requestId, type: 'permission.replied', decision: 'reject' })
        }
      }
      toolCalls.push(entry)
    }
  }

  const readHashes = new Set<string>()
  const shellHashes = new Set<string>()
  for (const call of toolCalls) {
    if (!call.asked || !call.replied) continue
    const requestId = askedBySource.get(call.sourceId)
    if (!requestId) continue
    if (call.name === 'read') readHashes.add(shortHash(requestId))
    else if (call.name === 'shell') shellHashes.add(shortHash(requestId))
  }

  // Permission lifecycle is independent of tool-error interpretation. Unknown
  // errors remain ineligible for the final tool proof in targetTools's default mode.
  const target = targetTools(toolCalls, [...seeds], false)
  const shell = target?.find((call) => call.name === 'shell')
  const shellStart = shell?.requestID ? diagnostics.find((entry) => entry.event === 'permission_reply_started'
    && entry.request === shortHash(shell.requestID!) && entry.decision === 'reject') : undefined
  const started = typeof shellStart?.timestamp === 'string' ? Date.parse(shellStart.timestamp) : NaN
  const pendingReadsAtShellReject = Number.isFinite(started) && (target?.filter((call) => call.name === 'read') ?? []).length === 2
    && target!.filter((call) => call.name === 'read').every((call) => {
      const asked = events.find((row) => row.event?.type === 'permission.asked' && row.event?.data?.sessionID === sessionId && row.event?.data?.id === call.requestID)
      const earlierReply = events.some((row) => row.event?.type === 'permission.replied' && row.event?.data?.sessionID === sessionId
        && row.event?.data?.requestID === call.requestID && typeof row.at === 'string' && Date.parse(row.at) < started)
      return typeof asked?.at === 'string' && Date.parse(asked.at) <= started && !earlierReply
    })
  return {
    sdk: {
      promptId: String(sdk.sdkPromptId ?? ''),
      model: sdk.modelVerified === true && sdk.assistantModelsVerified === true ? CASE3_FIXED_GO_MODEL : '',
      toolCalls,
      expectedSeeds: [...seeds],
    },
    events: proofEvents,
    diagnostics: { bridgeReadAllowReply: bridgeReadAllowReplyOf(diagnostics, readHashes, shellHashes, toolCalls), pendingReadsAtShellReject },
    interruption: collectCase3Interruption(input, String(sdk.sdkPromptId ?? ''), target?.[0]?.assistantId),
  }
}

function collectCase3Interruption(input: CollectCase3ProofInput, promptId: string, assistantId?: string): Case3Interruption {
  const rows = input.events.filter((row) => row.event?.data?.sessionID === input.sessionId)
  const starts = rows.filter((row) => row.event.type === 'session.execution.started')
  const terminals = rows.filter((row) => /^session\.execution\.(?:succeeded|failed|interrupted)$/u.test(row.event.type))
  const start = starts[0], terminal = terminals[0]
  const step = rows.find((row) => row.event.type === 'session.step.started' && row.event.data.assistantMessageID === assistantId)
  const inbox = rows.find((row) => row.event.type === 'session.inbox.delivered' && row.event.data.inboxID === promptId)
  const seq = (row?: EventRecord): number | null => row?.event.durable?.aggregateID === input.sessionId
    && Number.isSafeInteger(row?.event.durable?.seq) && row!.event.durable.seq >= 0 ? row!.event.durable.seq : null
  const startedSequence = seq(start), terminalSequence = seq(terminal)
  const inFrame = (row?: EventRecord) => !!row && !!start && !!terminal && rows.indexOf(start) < rows.indexOf(row) && rows.indexOf(row) < rows.indexOf(terminal)
  const requestRows = rows.filter((row) => row.event.type === 'permission.asked' && row.event.data.source?.messageID === assistantId)
  const replies = rows.filter((row) => row.event.type === 'permission.replied'
    && requestRows.some((ask) => ask.event.data.id === row.event.data.requestID))
  return { serviceVersion: input.serviceVersion, sessionId: input.sessionId, promptId, assistantId,
    uniqueExecution: starts.length === 1 && terminals.length === 1 && terminal?.event.type === 'session.execution.interrupted'
      && startedSequence !== null && terminalSequence !== null && terminalSequence > startedSequence
      && inFrame(step) && inFrame(inbox) && requestRows.length === 3 && requestRows.every(inFrame) && replies.length === 3 && replies.every(inFrame),
    reason: terminal?.event.type === 'session.execution.interrupted' && typeof terminal.event.data.reason === 'string'
      ? ['user', 'shutdown', 'superseded', 'inactivity'].includes(terminal.event.data.reason) ? terminal.event.data.reason : 'unknown' : null,
    localInterrupt: input.diagnostics.some((row) => row.event === 'session_interrupt_started' && row.session === shortHash(input.sessionId)),
    executionFailed: terminals.some((row) => row.event.type === 'session.execution.failed'), startedSequence, terminalSequence }
}
