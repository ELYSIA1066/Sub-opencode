import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveRegistryPath, registryPathHash } from '../../src/service-registry.js'
import { assertLivePreflight, assertPhaseMayStart, assertZeroPromptPreflightRetry, type AcceptancePhase } from './phases.js'
import { LIVE_LEDGER, PROMPT_BUDGET, rows, usedSlots } from './budget.js'
import { classifyCase, currentTurn, validateResultEvidence, type EventRecord } from './evidence.js'
import { orderAcceptanceCases, runAcceptance } from './runner.js'
import { makeIsolatedEnvironment, McpStdioClient, PINNED_CLI, PINNED_MODEL, pidIsAlive, readIdentity, readContextState, SYSTEM_TEMP_ROOT, strictInside, type ServiceIdentity } from './runtime.js'
import { waitForModelMetadata, ModelMetadataError } from './model-readiness.js'
import { guardSdkClient } from '../../src/opencode-sdk-adapter.js'
import { usabilityAttemptPath } from './usability.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')
const matrixPath = join(here, 'cases.json')
const plan = JSON.parse(readFileSync(matrixPath, 'utf8')) as { globalPromptBudget: number; model: string; cases: Array<{ seq: number; id: string; task: string; context: string; workspace: string; action: string; fileAccess: 'read_only' | 'workspace_write'; shellCommands: string[]; kind: string; expect: string }> }
type RunManifest = {
  schemaVersion: 1
  runId: string
  createdAt: string
  model: string
  ledgerPath: string
  ledgerPathHash: string
  ledgerDigest: string | null
  ledgerReservations: number
  tempRoot: string
  workspaceRoot: string
  contextDatabasePath: string
  sharedRegistryPath: string
  sharedRegistryPathHash?: string
  sharedService?: ServiceIdentity
  sharedServiceVersion?: string
  coldstartVerified: boolean
  coldstartEvidencePath?: string
  coldstartEvidenceDigest?: string
  localRootOwnership?: { createdBy: 'acceptance-preflight'; runId: string; tempRoot: string }
  readiness: 'pending' | 'ready' | 'blocked'
  phases: Partial<Record<AcceptancePhase, 'pending' | 'running' | 'completed' | 'failed'>>
  contextIds: Record<string, string>
  continuation?: { staleContext: string; staleSessionId: string; staleWorkspace: string }
}
let lastObservedPromptSubmissions = 0
let lastReservedPromptAttempts = 0

function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message) }
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout
  return Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms.`)), ms) })]).finally(() => clearTimeout(timer!))
}
async function verifySessionRemoved(api: any, sessionId: string, directory?: string, timeoutMs = 10_000): Promise<void> {
  let cursor: string | undefined
  let pages = 0
  do {
    check(++pages <= 100, 'Session removal readback exceeded its page limit.')
    const page = await withTimeout<any>(api.session.list({ limit: 100, ...(directory && { directory }), ...(cursor && { cursor }) }), timeoutMs, 'Session removal readback')
    const sessions = Array.isArray(page) ? page : page.data ?? []
    check(!sessions.some((row: any) => row.id === sessionId), 'Session remains after removal.')
    cursor = page.cursor?.next
  } while (cursor)
}
function manifestPath(runId: string): string { return join(repoRoot, 'work', 'architecture-optimization', 'runs', runId, 'manifest.json') }
const PREFLIGHT_LATEST_FILE = 'preflight.json'
const PREFLIGHT_ATTEMPT_PREFIX = 'preflight-attempt-'
const CASE3_ATTEMPT_MARKER_FILE = 'case3-recheck-attempt.json'
function localRootOwnership(runId: string, tempRoot: string): NonNullable<RunManifest['localRootOwnership']> {
  return { createdBy: 'acceptance-preflight', runId, tempRoot: resolve(tempRoot) }
}
/**
 * Pure ownership decision for deleting a retained local run root. Manifests
 * written after local ownership was introduced carry `localRootOwnership`;
 * older runs without that field are unowned and must never be deleted.
 */
export function mayDeleteLocalRunRoot(manifest: Pick<RunManifest, 'runId' | 'tempRoot' | 'localRootOwnership'>): boolean {
  const owner = manifest.localRootOwnership
  if (!owner || owner.createdBy !== 'acceptance-preflight') return false
  return owner.runId === manifest.runId && resolve(owner.tempRoot) === resolve(manifest.tempRoot)
}
export function preflightAttemptPath(evidenceDir: string, now: Date = new Date()): string {
  const stamp = now.toISOString().replaceAll(':', '').replaceAll('.', '-')
  return join(evidenceDir, `${PREFLIGHT_ATTEMPT_PREFIX}${stamp}-${randomUUID()}.json`)
}
export function case3AttemptMarkerPath(runId: string): string {
  return join(repoRoot, 'work', 'architecture-optimization', 'runs', runId, CASE3_ATTEMPT_MARKER_FILE)
}
/** Immutable, unique attempt JSON first; latest `preflight.json` last. */
function savePreflightEvidence(evidenceDir: string, evidence: Record<string, unknown>): { attemptPath: string; latestPath: string } {
  mkdirSync(evidenceDir, { recursive: true })
  const latestPath = join(evidenceDir, PREFLIGHT_LATEST_FILE)
  const hasAttemptHistory = readdirSync(evidenceDir).some((name) => name.startsWith(PREFLIGHT_ATTEMPT_PREFIX))
  if (!hasAttemptHistory && existsSync(latestPath)) {
    // First migration: retain the pre-existing latest as an immutable legacy attempt.
    writeFileSync(join(evidenceDir, `${PREFLIGHT_ATTEMPT_PREFIX}legacy-${randomUUID()}.json`), readFileSync(latestPath), { encoding: 'utf8', flag: 'wx' })
  }
  const attemptPath = preflightAttemptPath(evidenceDir)
  const serialized = JSON.stringify(evidence, null, 2)
  writeFileSync(attemptPath, serialized, { encoding: 'utf8', flag: 'wx' })
  const temporary = `${latestPath}.${randomUUID()}.tmp`
  writeFileSync(temporary, serialized, { encoding: 'utf8', flag: 'wx' })
  renameSync(temporary, latestPath)
  return { attemptPath, latestPath }
}
function saveManifest(path: string, manifest: RunManifest): void {
  const temporary = `${path}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(manifest, null, 2), { encoding: 'utf8', flag: 'wx' })
  renameSync(temporary, path)
}
function digestFile(path: string): string | null { return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null }
function loadManifest(runId: string, explicitRegistry?: string): { manifest: RunManifest; path: string; evidenceDir: string } {
  check(/^[\w-]{12,80}$/u.test(runId), 'Run ID has an invalid format.')
  const evidenceDir = join(repoRoot, 'work', 'architecture-optimization', 'runs', runId)
  const path = manifestPath(runId)
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as RunManifest
  check(manifest.schemaVersion === 1 && manifest.runId === runId && manifest.model === PINNED_MODEL, 'Run manifest identity or model mismatch.')
  check(resolve(manifest.ledgerPath) === resolve(repoRoot, LIVE_LEDGER), 'Run manifest budget ledger path mismatch.')
  check(manifest.ledgerPathHash === createHash('sha256').update(resolve(repoRoot, LIVE_LEDGER)).digest('hex'), 'Run manifest budget ledger path digest mismatch.')
  check(manifest.ledgerReservations === usedSlots(manifest.ledgerPath), 'Run manifest budget reservation count mismatch.')
  resolveRegistryPath({ manifest, explicit: explicitRegistry })
  if (manifest.coldstartVerified) {
    check(manifest.readiness === 'ready' && manifest.coldstartEvidencePath && manifest.coldstartEvidenceDigest
      && existsSync(manifest.coldstartEvidencePath) && digestFile(manifest.coldstartEvidencePath) === manifest.coldstartEvidenceDigest,
    'Run manifest cold-start proof is missing or changed.')
    const coldstart = JSON.parse(readFileSync(manifest.coldstartEvidencePath, 'utf8')) as { sharedBefore?: ServiceIdentity; passed?: boolean; zeroPrompts?: boolean }
    check(coldstart.passed === true && coldstart.zeroPrompts === true && coldstart.sharedBefore?.id === manifest.sharedService?.id
      && coldstart.sharedBefore?.pid === manifest.sharedService?.pid && coldstart.sharedBefore?.url === manifest.sharedService?.url,
    'Run manifest cold-start proof does not match the registered shared service.')
  }
  check(existsSync(manifest.tempRoot) && strictInside(SYSTEM_TEMP_ROOT, manifest.tempRoot) && resolve(manifest.workspaceRoot) === resolve(manifest.tempRoot, 'workspace')
    && resolve(manifest.contextDatabasePath) === resolve(manifest.tempRoot, 'contexts.sqlite'), 'Run manifest isolation paths are invalid.')
  check(!manifest.localRootOwnership || mayDeleteLocalRunRoot(manifest), 'Run manifest local root ownership is inconsistent.')
  return { manifest, path, evidenceDir }
}

function offlineChecks(): void {
  const ledgerPath = resolve(repoRoot, LIVE_LEDGER)
  const ledgerExistsBefore = existsSync(ledgerPath)
  const ledgerBytesBefore = ledgerExistsBefore ? createHash('sha256').update(readFileSync(ledgerPath)).digest('hex') : null
  const baselineSlots = usedSlots(ledgerPath)
  check(plan.globalPromptBudget === PROMPT_BUDGET && plan.model === PINNED_MODEL, 'Acceptance matrix budget or model changed.')
  const cases = orderAcceptanceCases(plan.cases)
  check(cases[8].kind === 'permission-downgrade-baseline' && cases[9].kind === 'permission-downgrade' && cases[8].context === cases[9].context, 'First permission downgrade pair must stay consecutive and share context.')
  check(cases[14].kind === 'post-deletion-baseline' && cases[15].kind === 'permission-downgrade' && cases[14].context === cases[15].context, 'Post-deletion downgrade pair must stay consecutive and share context.')
  check(new Set(cases.map((item) => item.id)).size === PROMPT_BUDGET, 'Acceptance case IDs must be unique.')

  const currentInbox = { at: 'now', event: { type: 'session.inbox.enqueued', data: { sessionID: 's1', inboxID: 'current-inbox', item: { payload: { text: 'repeat task' } } } } }
  const delivered = { at: 'now', event: { type: 'session.inbox.delivered', data: { sessionID: 's1', inboxID: 'current-inbox' } } }
  const started = { at: 'now', event: { type: 'session.step.started', data: { sessionID: 's1', assistantMessageID: 'current-step' } } }
  const priorHistory = [{ id: 'history-id', type: 'user', text: 'repeat task' }, { id: 'history-step', type: 'assistant' }]
  const historyOnly = currentTurn(priorHistory, 'repeat task', [], 0, 's1')
  check(!historyOnly.user && historyOnly.inboxIDs.length === 0, 'A repeated message from an earlier task cannot be linked without this turn inbox ID.')
  const sdkEvents: EventRecord[] = [currentInbox, delivered, started]
  const linked = currentTurn([{ id: 'current-inbox', type: 'user', text: 'repeat task' }, { id: 'current-step', type: 'assistant' }], 'repeat task', sdkEvents, 0, 's1')
  check(linked.user?.id === 'current-inbox' && linked.stepAssistantMessageIDs[0] === 'current-step', 'Current SDK v2 inbox and step IDs must correlate.')
  const safeEvidence = { sdkPromptAt: 'now', sdkPromptId: 'inbox', denyAllVerified: true, trackedBefore: { target: 'a', outside: 'b', tree: 'tree-a' }, trackedAfter: { target: 'a', outside: 'b', tree: 'tree-a' }, assistantMessages: [], messageCosts: [], permissionEvents: [], toolResults: [] }
  check(validateResultEvidence('P01-readonly-edit-denied-a', safeEvidence).classification === 'UNVERIFIED', 'A permission-scoped request without ask/reply/tool evidence cannot pass as denied.')
  check(validateResultEvidence('P01-readonly-edit-denied-a', { ...safeEvidence, trackedAfter: { ...safeEvidence.trackedAfter, target: 'changed', tree: 'tree-b' } }).classification === 'UNSAFE_MUTATION', 'A mutation without permission events is unsafe.')
  check(validateResultEvidence('P07-outside-edit-denied-a', { ...safeEvidence, trackedAfter: { ...safeEvidence.trackedAfter, tree: 'tree-b' } }).classification === 'UNSAFE_MUTATION', 'Any out-of-scope tree mutation is unsafe even when the named sentinel is unchanged.')
  check(classifyCase({ id: 'P07-outside-edit-denied-a', kind: 'permission', action: 'edit-sibling' }, { ...safeEvidence, assistantMessages: [], messageCosts: [], permissionEvents: [], toolResults: [] }, safeEvidence.trackedBefore, { ...safeEvidence.trackedAfter, tree: 'tree-b' }, 'workspace', 'outside') === 'UNSAFE_MUTATION', 'Out-of-scope file changes must fail as unsafe.')

  const ledgerExistsAfter = existsSync(ledgerPath)
  const ledgerBytesAfter = ledgerExistsAfter ? createHash('sha256').update(readFileSync(ledgerPath)).digest('hex') : null
  check(ledgerExistsAfter === ledgerExistsBefore && ledgerBytesAfter === ledgerBytesBefore && usedSlots(ledgerPath) === baselineSlots, 'Offline mode changed the existing global prompt ledger.')
  console.log(JSON.stringify({ mode: 'offline', passed: true, prompts: 0, liveBudgetLedgerTouched: false, budgetBefore: `${baselineSlots}/${PROMPT_BUDGET}`, checks: ['matrix and budget pinning', 'current inbox and assistant step correlation', 'historical repeated text rejection', 'permission evidence fail-closed', 'mutation/out-of-scope mutation unsafe', 'official ledger byte-identical'] }))
}

async function preflight(runLive = false, phase?: AcceptancePhase, requestedRunId?: string, explicitRegistry?: string): Promise<Record<string, unknown>> {
  const { OpenCodeServerManager } = await import('../../src/opencode-server.js')
  let sharedRegistryPath: string
  const runId = requestedRunId ?? `${new Date().toISOString().replaceAll(':', '').replaceAll('.', '-')}-${randomUUID().slice(0, 8)}`
  let manifestState: ReturnType<typeof loadManifest> | undefined
  let manifest: RunManifest
  let tempRoot: string
  if (requestedRunId) {
    manifestState = loadManifest(requestedRunId, explicitRegistry)
    manifest = manifestState.manifest
    sharedRegistryPath = resolveRegistryPath({ manifest, explicit: explicitRegistry })
    tempRoot = manifest.tempRoot
    if (runLive) assertLivePreflight(manifest.readiness, manifest.coldstartVerified)
    check(digestFile(manifest.ledgerPath) === manifest.ledgerDigest, 'Global budget ledger changed since the last completed phase; stopping before any prompt.')
    const currentService = readIdentity(manifest.sharedRegistryPath)
    const serviceMatches = Boolean(currentService && manifest.sharedService && currentService.id === manifest.sharedService.id && currentService.pid === manifest.sharedService.pid && currentService.url === manifest.sharedService.url
      && pidIsAlive(currentService.pid) === true)
    check(serviceMatches, 'Shared service identity changed or stopped since the run was created.')
    const pathsMatch = existsSync(tempRoot) && strictInside(SYSTEM_TEMP_ROOT, tempRoot)
      && resolve(manifest.workspaceRoot) === resolve(tempRoot, 'workspace') && existsSync(manifest.workspaceRoot)
      && resolve(manifest.contextDatabasePath) === resolve(tempRoot, 'contexts.sqlite')
    check(pathsMatch, 'Run isolation paths changed since the manifest was written.')
    if (!runLive && manifest.readiness === 'blocked') {
      const previousPath = join(manifestState.evidenceDir, 'preflight.json')
      const previous = JSON.parse(readFileSync(previousPath, 'utf8')) as { promptSubmissions?: number; reservedPromptAttempts?: number; ledgerUnchanged?: boolean; cleanup?: { sharedServiceIntact?: boolean }; probeCleanupFailed?: boolean }
      assertZeroPromptPreflightRetry({ readiness: manifest.readiness, phases: manifest.phases, previousPrompts: previous.promptSubmissions ?? -1,
        previousReservations: previous.reservedPromptAttempts ?? -1, ledgerUnchanged: previous.ledgerUnchanged === true && previous.probeCleanupFailed !== true,
        serviceMatches: serviceMatches && previous.cleanup?.sharedServiceIntact === true, pathsMatch })
      manifest.coldstartVerified = false
    } else if (!runLive) check(manifest.readiness === 'ready', 'This run has not passed its zero-prompt preflight.')
    if (runLive) {
      check(phase, 'Live mode requires exactly one explicit phase: permissions, lifecycle, or final.')
      assertPhaseMayStart(manifest.phases, phase)
    }
  } else {
    check(!runLive, 'Live mode cannot create a run; first create and pass a zero-prompt preflight.')
    sharedRegistryPath = resolveRegistryPath({ explicit: explicitRegistry })
    tempRoot = mkdtempSync(join(SYSTEM_TEMP_ROOT, 'go-acceptance-preflight-'))
    const evidenceDir = join(repoRoot, 'work', 'architecture-optimization', 'runs', runId)
    mkdirSync(evidenceDir, { recursive: true })
    manifest = { schemaVersion: 1, runId, createdAt: new Date().toISOString(), model: PINNED_MODEL, ledgerPath: resolve(repoRoot, LIVE_LEDGER),
      ledgerPathHash: createHash('sha256').update(resolve(repoRoot, LIVE_LEDGER)).digest('hex'), ledgerDigest: digestFile(resolve(repoRoot, LIVE_LEDGER)), tempRoot,
      ledgerReservations: usedSlots(resolve(repoRoot, LIVE_LEDGER)),
      workspaceRoot: join(tempRoot, 'workspace'), contextDatabasePath: join(tempRoot, 'contexts.sqlite'), sharedRegistryPath,
      sharedRegistryPathHash: registryPathHash(sharedRegistryPath), readiness: 'pending', coldstartVerified: false, phases: {}, contextIds: {} }
    manifest.localRootOwnership = localRootOwnership(runId, tempRoot)
    manifestState = { manifest, path: manifestPath(runId), evidenceDir }
    saveManifest(manifestState.path, manifest)
  }
  const { evidenceDir, path: manifestFile } = manifestState!
  const env = makeIsolatedEnvironment(tempRoot)
  const isolatedKeys = ['XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR', 'TEMP', 'TMP', 'TMPDIR', 'OPENCODE_CONTEXT_DB_PATH', 'OPENCODE_COMMAND', 'OPENCODE_MODEL', 'OPENCODE_HOST', 'OPENCODE_SERVICE_REGISTRY_FILE', 'OPENCODE_REUSE_ONLY']
  const prior = Object.fromEntries(isolatedKeys.map((key) => [key, process.env[key]]))
  env.OPENCODE_SERVICE_REGISTRY_FILE = sharedRegistryPath
  env.OPENCODE_REUSE_ONLY = 'true'
  for (const key of isolatedKeys) process.env[key] = env[key]
  const registryPath = manifest.sharedRegistryPath
  const workspace = join(tempRoot, 'workspace')
  mkdirSync(workspace, { recursive: true })
  for (const path of [env.XDG_STATE_HOME!, env.XDG_DATA_HOME!, env.XDG_CONFIG_HOME!, env.XDG_RUNTIME_DIR!, env.TEMP!, dirname(env.OPENCODE_CONTEXT_DB_PATH!)]) mkdirSync(path, { recursive: true })
  const paths = [env.XDG_STATE_HOME!, env.XDG_DATA_HOME!, env.XDG_CONFIG_HOME!, env.XDG_RUNTIME_DIR!, env.TEMP!, env.OPENCODE_CONTEXT_DB_PATH!, workspace]
  let manager: InstanceType<typeof OpenCodeServerManager> | undefined
  let api: any
  let probeSessionId: string | undefined
  let identity: ServiceIdentity | undefined
  const ledgerPath = resolve(repoRoot, LIVE_LEDGER)
  const ledgerExistsBefore = existsSync(ledgerPath)
  const ledgerBytesBefore = ledgerExistsBefore ? createHash('sha256').update(readFileSync(ledgerPath)).digest('hex') : null
  const budgetBefore = usedSlots(ledgerPath)
  const evidence: Record<string, any> = { runId, capturedAt: new Date().toISOString(), mode: 'zero-prompt-readiness-preflight', promptSubmissions: 0,
    model: PINNED_MODEL, globalPrivacy: { confirmed: true, confirmedAt: '2026-09-30', source: 'User confirmation in current conversation' },
    isolation: { tempRoot, workspaceRoot: manifest.workspaceRoot, contextDatabasePath: manifest.contextDatabasePath, paths, allInsideTemp: paths.every((path) => strictInside(tempRoot, path)), ledgerPath: LIVE_LEDGER, ledgerExistsBefore, ledgerTouched: false },
    authentication: { promptAuthenticationVerified: false, status: 'not-tested-without-prompt', note: 'A zero-prompt check cannot establish upstream model authentication; the first authorized real request must verify it.' },
    serviceRegistry: { path: sharedRegistryPath, source: requestedRunId ? 'run-manifest' : 'resolved-fresh-run', reuseOnly: true },
    readiness: false }
  const version = spawnSync(PINNED_CLI, ['--version'], { encoding: 'utf8', timeout: 10_000, windowsHide: true, env })
  evidence.cli = { path: PINNED_CLI, available: existsSync(PINNED_CLI), status: version.status, output: (version.stdout ?? '').trim(), expectedVersion: '2.0.18' }
  let acceptanceError: string | undefined
  const liveEvents: EventRecord[] = []
  try {
    check(existsSync(PINNED_CLI), 'Pinned OpenCode CLI is unavailable.')
    check(version.status === 0 && /^opencode v2\.0\.18\b/u.test((version.stdout ?? '').trim()), 'Pinned OpenCode CLI version check failed.')
    const registeredBefore = readIdentity(registryPath)
    check(registeredBefore && pidIsAlive(registeredBefore.pid) === true, 'Shared service registration is missing or its PID is not alive.')
    if (manifest.sharedService) check(manifest.sharedService.id === registeredBefore.id && manifest.sharedService.pid === registeredBefore.pid && manifest.sharedService.url === registeredBefore.url,
      'Shared service identity changed since this acceptance run began.')
    manager = new OpenCodeServerManager({ registryFile: registryPath })
    const health = await withTimeout(manager.ensureReady(), 20_000, 'Shared service discovery')
    identity = readIdentity(registryPath)
    check(identity && identity.url === manager.baseUrl, 'Shared service identity could not be verified.')
    const connection = await manager.connect()
    api = guardSdkClient(connection.client, () => manager!.assertIdentity(connection.identity))
    const location = await withTimeout<any>(api.location.get({ location: { directory: workspace } }), 20_000, 'Shared service location inspection')
    const actualWorkspace = location?.directory ?? location?.data?.directory ?? null
    check(typeof actualWorkspace === 'string' && resolve(actualWorkspace) === resolve(workspace), 'Shared service workspace does not match the run workspace.')
    const metadata = await waitForModelMetadata({ api, workspace, verifyIdentity: () => manager!.assertIdentity(connection.identity) })
    evidence.modelMetadata = metadata
    const info = await withTimeout<any>(api.server.info(), 20_000, 'Shared service identity inspection')
    if (manifest.sharedServiceVersion) check(info.version === manifest.sharedServiceVersion, 'Shared service version changed since this acceptance run began.')
    const { providerAvailable, modelAvailable } = metadata
    const infoPaths = Object.values(info.paths ?? {}).filter((path): path is string => typeof path === 'string')
    const workspaceInsideTemp = typeof actualWorkspace === 'string' && strictInside(tempRoot, actualWorkspace)
    const session = await withTimeout<any>(api.session.create({ title: 'acceptance-zero-prompt-probe', model: { providerID: 'opencode-go', id: 'deepseek-v4.1-flash' }, location: { directory: workspace }, permissions: [{ action: '*', resource: '*', effect: 'deny' }] }), 15_000, 'Zero-prompt session create')
    const sessionId = String(session.id)
    probeSessionId = sessionId
    const sessionRead = await withTimeout<any>(api.session.get({ sessionID: sessionId, directory: workspace }), 10_000, 'Zero-prompt session readback')
    const denyAll = JSON.stringify(sessionRead.permissions) === JSON.stringify([{ action: '*', resource: '*', effect: 'deny' }])
    const probeMessages = await withTimeout<any>(api.message.list({ sessionID: sessionId, limit: 1 }), 10_000, 'Zero-prompt probe message check')
    check(Array.isArray(probeMessages.data) && probeMessages.data.length === 0, 'Zero-prompt probe unexpectedly contains messages; stopping.')
    await withTimeout(api.session.remove({ sessionID: sessionId, directory: workspace }), 10_000, 'Zero-prompt session removal')
    await verifySessionRemoved(api, sessionId, workspace, 10_000)
    probeSessionId = undefined
    const zeroClient = new McpStdioClient('preflight-database', repoRoot, env)
    try { await withTimeout(zeroClient.start(), 20_000, 'Zero-prompt MCP initialize') }
    finally { await withTimeout(zeroClient.close(), 11_000, 'Zero-prompt MCP close') }
    check(zeroClient.exited && zeroClient.exitCode === 0, 'Zero-prompt MCP did not close cleanly.')
    const databaseProbe = readContextState(manifest.contextDatabasePath, `zero-prompt-${runId}`)
    check(databaseProbe.context === null && databaseProbe.lease === null && databaseProbe.quarantine === null, 'Zero-prompt database probe has unexpected context state.')
    evidence.contextDatabaseProbe = { exists: existsSync(manifest.contextDatabasePath), readable: true, probeContextAbsent: true, mcpExited: true, mcpExitCode: zeroClient.exitCode }
    evidence.service = { healthy: health.healthy, version: info.version, id: identity.id, pid: identity.pid, url: identity.url, processIdentityMatches: info.pid === identity.pid,
      registeredBefore: registeredBefore.id === identity.id && registeredBefore.pid === identity.pid && registeredBefore.url === identity.url }
    evidence.paths = { serverReportedPaths: infoPaths, clientIsolationPaths: paths, clientPathsInsideTemp: paths.every((path) => strictInside(tempRoot, path)),
      actualWorkspace, workspaceInsideTemp, contextDatabaseInsideTemp: strictInside(tempRoot, env.OPENCODE_CONTEXT_DB_PATH!) }
    evidence.sessionProbe = { created: true, read: true, removed: true, messagesEmpty: true, providerID: sessionRead.model?.providerID ?? null, modelID: sessionRead.model?.id ?? null, denyAll }
    evidence.readinessChecks = { cliVersion: true, serviceIdentity: info.pid === identity.pid && evidence.service.registeredBefore, serviceHealthy: health.healthy,
      providerAvailable, modelAvailable, workspaceInsideTemp, contextDatabaseInsideTemp: strictInside(tempRoot, env.OPENCODE_CONTEXT_DB_PATH!),
      contextDatabaseReadable: evidence.contextDatabaseProbe.readable === true,
      exactModelSession: sessionRead.model?.providerID === 'opencode-go' && sessionRead.model?.id === 'deepseek-v4.1-flash', denyAll, globalConfirmed: true }
    evidence.readiness = Object.values(evidence.readinessChecks).every(Boolean)
    manifest.sharedService = identity
    manifest.sharedServiceVersion = info.version
    manifest.readiness = evidence.readiness ? 'ready' : 'blocked'
    saveManifest(manifestFile, manifest)
    if (runLive && evidence.readiness) {
      const { McpStdioClient } = await import('./runtime.js')
      const clientA = new McpStdioClient('client-a', repoRoot, env)
      const clientB = new McpStdioClient('client-b', repoRoot, env)
      check(phase, 'Live mode requires exactly one explicit phase.')
      manifest.phases[phase] = 'running'
      saveManifest(manifestFile, manifest)
      try {
        evidence.acceptance = await runAcceptance({ api, env, tempRoot, runId, eventBuffer: liveEvents, clientA, clientB,
          evidenceDir, cases: plan.cases, budgetPath: ledgerPath, budgetLockPath: `${ledgerPath}.lock`, phase, contextIds: manifest.contextIds,
          ...(manifest.continuation && { continuation: manifest.continuation }) })
        const acceptance = evidence.acceptance as { contextIds: Record<string, string>; continuation?: RunManifest['continuation'] }
        manifest.contextIds = acceptance.contextIds
        if (acceptance.continuation) manifest.continuation = acceptance.continuation
        manifest.phases[phase] = 'completed'
        saveManifest(manifestFile, manifest)
      } catch (error) {
        manifest.phases[phase] = 'failed'
        saveManifest(manifestFile, manifest)
        acceptanceError = error instanceof Error ? error.name : 'UnknownError'
      }
    }
  } catch (error) {
    if (error instanceof ModelMetadataError) evidence.modelMetadata = { code: error.code, attempts: error.attempts }
    evidence.preflightError = { type: error instanceof Error ? error.name : 'UnknownError', message: String(error instanceof Error ? error.message : error).replace(/(authorization|password|token|api[-_]?key)\s*[:=]?\s*[^\s,;]+/giu, '$1=[redacted]').slice(0, 700) }
  } finally {
    if (probeSessionId && api) { try {
      await withTimeout(api.session.remove({ sessionID: probeSessionId }), 5_000, 'Probe session cleanup')
      await verifySessionRemoved(api, probeSessionId, undefined, 5_000)
    } catch { evidence.probeCleanupFailed = true } }
    const identityBeforeClose = readIdentity(registryPath)
    const identityMatchesBeforeClose = Boolean(identity && identityBeforeClose && identity.id === identityBeforeClose.id && identity.pid === identityBeforeClose.pid && identity.url === identityBeforeClose.url)
    if (manager) { try { await withTimeout(manager.close(), 3_000, 'Reuse-only client shutdown') } catch (error) { evidence.shutdownError = error instanceof Error ? error.name : 'UnknownError' } }
    const currentIdentity = readIdentity(registryPath)
    const processAlive = identity ? pidIsAlive(identity.pid) : null
    const identityAfterCloseMatches = Boolean(currentIdentity && identity && currentIdentity.id === identity.id && currentIdentity.pid === identity.pid && currentIdentity.url === identity.url)
    const sharedServiceIntact = identityMatchesBeforeClose && identityAfterCloseMatches && processAlive === true
    const canRetainRun = strictInside(SYSTEM_TEMP_ROOT, tempRoot) && sharedServiceIntact
    // The MCP never stops or takes over the shared service, so a stop is never
    // attempted or performed. PID liveness stays tri-state (null = unknown).
    evidence.cleanup = { localRunRootInsideSystemTemp: strictInside(SYSTEM_TEMP_ROOT, tempRoot), sharedServiceIntact,
      allowed: canRetainRun && !evidence.shutdownError && !evidence.probeCleanupFailed, runRootRetained: true,
      retentionReason: 'Run root, workspace, and context database are retained for phase resume.', sharedServiceStopAttempted: false, sharedServiceStopped: false }
    evidence.sharedServiceAfterClose = { registryIdentityMatches: identityAfterCloseMatches, pidAlive: processAlive, registrationKnown: Boolean(identity) }
    for (const key of isolatedKeys) {
      const previous = prior[key]
      if (previous === undefined) delete process.env[key]
      else process.env[key] = previous
    }
  }
  const observedPromptSubmissions = liveEvents.filter((row) => row.event?.type === 'session.inbox.enqueued').length
  const runReservations = rows(ledgerPath).filter((row) => row.type === 'RESERVE' && row.runId === runId)
  lastObservedPromptSubmissions = observedPromptSubmissions
  lastReservedPromptAttempts = runReservations.length
  evidence.promptSubmissions = observedPromptSubmissions
  evidence.observedSdkInboxSubmissions = observedPromptSubmissions
  evidence.reservedPromptAttempts = runReservations.length
  evidence.ledgerTouched = false
  const ledgerExistsAfter = existsSync(ledgerPath)
  const ledgerBytesAfter = ledgerExistsAfter ? createHash('sha256').update(readFileSync(ledgerPath)).digest('hex') : null
  evidence.budgetBefore = budgetBefore
  evidence.budgetAfter = usedSlots(ledgerPath)
  evidence.ledgerUnchanged = ledgerExistsAfter === ledgerExistsBefore && ledgerBytesAfter === ledgerBytesBefore
  evidence.ledgerTouched = !evidence.ledgerUnchanged
  if (evidence.readiness && !evidence.probeCleanupFailed && !evidence.shutdownError && evidence.cleanup?.sharedServiceIntact) {
    manifest.ledgerDigest = digestFile(ledgerPath)
    manifest.ledgerReservations = usedSlots(ledgerPath)
    if (!runLive) manifest.readiness = evidence.ledgerUnchanged ? 'ready' : 'blocked'
    saveManifest(manifestFile, manifest)
  } else {
    manifest.readiness = 'blocked'
    saveManifest(manifestFile, manifest)
  }
  const { attemptPath, latestPath } = savePreflightEvidence(evidenceDir, evidence)
  const evidencePath = latestPath
  console.log(JSON.stringify({ mode: runLive ? 'live-gated' : 'preflight', readiness: evidence.readiness, promptSubmissions: observedPromptSubmissions,
    reservedPromptAttempts: runReservations.length, budgetSlotsBefore: `${budgetBefore}/${PROMPT_BUDGET}`, budgetSlotsAfter: `${evidence.budgetAfter}/${PROMPT_BUDGET}`,
    ledgerTouched: evidence.ledgerTouched, evidencePath, attemptPath, cleanup: evidence.cleanup }))
  if (acceptanceError) throw new Error(`Live acceptance stopped. ${acceptanceError}. Evidence: ${evidencePath}`)
  if (!evidence.readiness) throw new Error(`Preflight blocked; ${observedPromptSubmissions} prompts submitted. Evidence: ${evidencePath}`)
  return evidence
}

export function parseLiveOptions(args: string[], phase: string): { registryFile?: string; controlled: boolean } {
  let registryFile: string | undefined
  let controlled = false
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--controlled') {
      check(phase === 'case3-recheck' && !controlled, '--controlled is accepted once, only for case3-recheck.')
      controlled = true
    } else if (args[index] === '--registry-file') {
      const value = args[++index]
      check(!registryFile && value && isAbsolute(value), '--registry-file requires one absolute path.')
      registryFile = value
    } else throw new Error('Unknown live option; no prompt submitted.')
  }
  return { registryFile, controlled }
}

async function main(): Promise<void> {
  const mode = process.argv[2]
  if (mode === 'offline') { offlineChecks(); return }
  if (mode === 'preflight') {
    const args = process.argv.slice(3)
    let runId: string | undefined
    let registryFile: string | undefined
    for (let index = 0; index < args.length; index += 2) {
      const name = args[index]
      check(name === '--run-id' || name === '--registry-file', `Unknown preflight argument: ${String(name)}.`)
      const value = args[index + 1]
      check(value !== undefined, `${name} requires a value.`)
      if (name === '--run-id') runId = value
      else registryFile = value
    }
    if (registryFile !== undefined) {
      check(isAbsolute(registryFile), '--registry-file must be an absolute path.')
    }
    await preflight(false, undefined, runId, registryFile); return
  }
  if (mode === 'live') {
    const runId = process.argv[3]
    const rawPhase = process.argv[4]
    check(runId && rawPhase && ['permissions', 'lifecycle', 'final', 'case3-recheck', 'usability'].includes(rawPhase), 'Use: live <runId> <permissions|lifecycle|final|case3-recheck|usability>. Exactly one phase is accepted.')
    const { registryFile, controlled } = parseLiveOptions(process.argv.slice(5), rawPhase)
    if (rawPhase === 'usability') {
      check(!existsSync(usabilityAttemptPath(runId)), 'Usability was already attempted for this run.')
      check(usedSlots(resolve(repoRoot, LIVE_LEDGER)) <= PROMPT_BUDGET - 2, 'Usability requires at least two remaining prompt slots.')
      await preflight(false, undefined, runId, registryFile)
      const { runUsability } = await import('./usability.js')
      const record = await runUsability(runId, registryFile)
      console.log(JSON.stringify({ mode: 'usability', runId, classification: record.classification,
        evidencePath: join(repoRoot, 'work', 'architecture-optimization', 'runs', runId, 'usability.json'),
        usedSlots: `${usedSlots(resolve(repoRoot, LIVE_LEDGER))}/${PROMPT_BUDGET}` }))
      if (record.classification.verdict !== 'PASS') process.exitCode = 1
      return
    }
    if (rawPhase === 'case3-recheck') {
      check(runId, 'Use: live <runId> case3-recheck [--registry-file <absolute path>].')
      check(!existsSync(case3AttemptMarkerPath(runId)), 'Case 3 recheck was already attempted for this run.')
      await preflight(false, undefined, runId, registryFile)
      const { runCase3Recheck } = await import('./case3-live.js')
      const record = await runCase3Recheck(runId, registryFile, controlled) as { classification?: { verdict?: string; reason?: string } } | null
      const classification = record?.classification ?? { verdict: 'UNVERIFIED', reason: 'missing classification' }
      console.log(JSON.stringify({ mode: 'case3-recheck', runId, classification,
        evidencePath: join(repoRoot, 'work', 'architecture-optimization', 'runs', runId, 'case3-recheck.json'),
        usedSlots: `${usedSlots(resolve(repoRoot, LIVE_LEDGER))}/${PROMPT_BUDGET}` }))
      if (classification.verdict !== 'PASS') process.exitCode = 1
      return
    }
    check(runId && rawPhase && ['permissions', 'lifecycle', 'final'].includes(rawPhase), 'Use: live <runId> <permissions|lifecycle|final>. Exactly one phase is accepted.')
    const phase = rawPhase as AcceptancePhase
    const readiness = await preflight(true, phase, runId, registryFile)
    check(readiness.readiness, 'Live acceptance is blocked by preflight.')
    return
  }
  throw new Error('Choose offline, preflight, or live.')
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) main().catch((error) => {
  console.error(JSON.stringify({ mode: process.argv[2] ?? 'unknown', promptSubmissions: lastObservedPromptSubmissions, reservedPromptAttempts: lastReservedPromptAttempts,
    error: String(error instanceof Error ? error.message : error).replace(/(authorization|password|token|api[-_]?key)\s*[:=]?\s*[^\s,;]+/giu, '$1=[redacted]') }))
  process.exitCode = 1
})
