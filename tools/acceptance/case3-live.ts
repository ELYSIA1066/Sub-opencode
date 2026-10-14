import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpStdioClient, hashTree, makeIsolatedEnvironment, pidIsAlive, readContextState } from './runtime.js';
import { guardSdkClient } from '../../src/opencode-sdk-adapter.js';
import {
  OpenCodeServerManager,
  type SharedConnectionIdentity,
} from '../../src/opencode-server.js';
import { resolveRegistryPath } from '../../src/service-registry.js';
import {
  classifyCase3Evidence,
  inspectCase3ControlAudit,
  CASE3_ABORT_SEMANTICS,
  collectCase3Proof,
  safeCase3Events,
  validateCase3Run,
  type Case3ContextState,
  type Case3Manifest,
  type Case3Response,
  type CollectCase3Proof,
} from './case3-recheck.js';
import { cleanupCase3Root } from './case3-cleanup.js';
import {
  allMessages,
  sdkEvidence,
  type EventRecord,
  type SdkEvidence as EvidenceSdkEvidence,
} from './evidence.js';
import { LIVE_LEDGER, PROMPT_BUDGET, appendCompletion, sanitize, tryReserve, usedSlots } from './budget.js';

const RUN_ID_PATTERN = /^[\w-]{12,80}$/;
const REQUIRED_MODEL = 'opencode-go/deepseek-v4.1-flash';
const REQUIRED_READINESS = 'ready';

/** Fixed redacted error: never leak run internals, paths, or manifest values. */
function redactedCase3Error(): Error {
  return new Error('case3-live: preparation failed');
}

export async function prepareCase3Run(runId: string, explicitRegistry?: string): Promise<{
  repoRoot: string;
  evidenceDir: string;
  manifest: Case3Manifest;
  ledgerPath: string;
  manager: OpenCodeServerManager;
  api: ReturnType<typeof guardSdkClient>;
  identity: SharedConnectionIdentity;
}> {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) {
    throw redactedCase3Error();
  }

  const evidenceDir = resolve(repoRoot, 'work/architecture-optimization/runs', runId);
  const manifestPath = resolve(evidenceDir, 'manifest.json');
  const ledgerPath = resolve(repoRoot, LIVE_LEDGER);

  let manifest: Case3Manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Case3Manifest;
  } catch {
    throw redactedCase3Error();
  }

  const ledgerSha256 = createHash('sha256').update(readFileSync(ledgerPath)).digest('hex');

  let sharedRegistryPath: string;
  try { sharedRegistryPath = resolveRegistryPath({ manifest, explicit: explicitRegistry }); }
  catch { throw redactedCase3Error(); }

  if (
    manifest.sharedRegistryPath !== sharedRegistryPath ||
    manifest.model !== REQUIRED_MODEL ||
    manifest.readiness !== REQUIRED_READINESS ||
    usedSlots(ledgerPath) >= PROMPT_BUDGET
  ) {
    throw redactedCase3Error();
  }

  const manager = new OpenCodeServerManager({ registryFile: sharedRegistryPath });
  const connection = await manager.connect();

  try {
    validateCase3Run({
      runId,
      repoRoot,
      manifest,
      ledgerPath,
      ledgerDigest: ledgerSha256,
      usedSlots: usedSlots(ledgerPath),
      currentService: connection.identity,
      serviceVersion: connection.identity.version,
    });
  } catch {
    await manager.close();
    throw redactedCase3Error();
  }

  const api = guardSdkClient(connection.client, () =>
    manager.assertIdentity(connection.identity),
  );

  return { repoRoot, evidenceDir, manifest, ledgerPath, manager, api, identity: connection.identity };
}

// --- Case 3 live recheck: setup + submit (forensics/cleanup deferred) ---

const CASE3_RECHECK_MODEL = 'opencode-go/deepseek-v4.1-flash';
const ATTEMPT_MARKER_FILE = 'case3-recheck-attempt.json';
const CONNECT_WAIT_MS = 20_000;
const TOOL_CALL_TIMEOUT_MS = 85_000;
const PUMP_DRAIN_MS = 5_000;
const EVENT_WHITELIST = new Set([
  'server.connected',
  'permission.asked',
  'permission.replied',
  'session.inbox.enqueued',
  'session.inbox.delivered',
  'session.step.started',
  'session.step.finished',
  'session.idle',
  'session.execution.interrupted',
  'session.execution.started',
  'session.execution.succeeded',
  'session.execution.failed',
]);

interface Case3RecheckRequest {
  model: string;
  context_id: string;
  workspace_root: string;
  permission_scope: { fileAccess: 'read_only'; shellCommands: string[] };
  task: string;
}

export interface Case3RecheckState {
  controlled: boolean;
  prepared: Awaited<ReturnType<typeof prepareCase3Run>>;
  client: McpStdioClient;
  events: EventRecord[];
  response: unknown;
  reservation: ReturnType<typeof tryReserve>;
  request: Case3RecheckRequest;
  contextId: string;
  task: string;
  seedARelative: string;
  seedBRelative: string;
  markerAbs: string;
  markerRelative: string;
  sentinel: string;
  before: { workspace: Record<string, string>; sentinelSha: string };
  streamError?: unknown;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function boundedWithTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms.`)), ms);
    }),
  ]).finally(() => clearTimeout(timer!));
}

/** Same 16-hex correlation id shape as production `writeTaskDiagnostic`. */
function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/** Full SHA-256 used to attest a raw value without persisting it. */
function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Record only a redacted type/status projection of an assistant error. */
function safeAssistantError(error: unknown): { type: string | null; status: number | null } {
  if (typeof error !== 'object' || error === null) return { type: null, status: null };
  const value = error as { type?: unknown; status?: unknown };
  return {
    type: typeof value.type === 'string' ? value.type : null,
    status: typeof value.status === 'number' && Number.isInteger(value.status) ? value.status : null,
  };
}

// Core forensics for the Case 3 recheck. Any capture/close/identity fault becomes a FAIL while
// keeping every partial artifact that could be collected. No local deletion happens here.
async function finishCase3(state: Case3RecheckState): Promise<unknown> {
  const {
    prepared, client, events, response, reservation, contextId, task,
    seedARelative, seedBRelative, markerAbs, markerRelative, sentinel, before, streamError,
  } = state;
  const { evidenceDir, manifest, ledgerPath, manager, api, identity } = prepared;

  const envelope = response as { result?: { structuredContent?: unknown } } | null;
  const structured = envelope?.result?.structuredContent;
  const output: Record<string, unknown> = structured && typeof structured === 'object'
    ? { ...(structured as Record<string, unknown>) }
    : { status: 'failed', error_code: 'mcp_result_missing' };
  const sessionId = typeof output.session_id === 'string' ? output.session_id : null;

  const failures: string[] = [];
  if (!structured) failures.push('mcp_result_missing');
  if (structured && output.context_id !== contextId) failures.push('context_id_mismatch');
  if (streamError) failures.push('event_stream_disconnected');

  let captureFailure: string | null = null;
  let sdk: EvidenceSdkEvidence | null = null;
  let proof: CollectCase3Proof | null = null;
  const eventEvidencePath = join(evidenceDir, 'case3-events.json');
  try { writeFileSync(eventEvidencePath, JSON.stringify({ sessionId, events: sessionId ? safeCase3Events(events, sessionId) : [] }, null, 2), { flag: 'wx' }); }
  catch { captureFailure = 'EventEvidenceWriteError'; }
  try {
    if (sessionId) {
      sdk = await sdkEvidence(api, events, sessionId, task, 0, boundedWithTimeout);
      const messages = await boundedWithTimeout(allMessages(api, sessionId, boundedWithTimeout, sdk.sdkPromptId ?? undefined), 20000, 'messages');
      proof = collectCase3Proof({
        messages, task, sessionId, events, sdk, diagnostics: client.diagnostics,
        seedA: seedARelative, seedB: seedBRelative, markerRelative, workspaceRoot: manifest.workspaceRoot, serviceVersion: identity.version,
      });
    }
  } catch (error) { captureFailure ??= error instanceof Error ? error.name : 'UnknownError'; }

  // The pure classifier owns error interpretation and the version-bound abort exception.
  const assistantErrors = (sdk?.assistantMessages ?? []).filter((row) => row.error != null)
    .map((row) => ({ assistantId: String(row.id), ...safeAssistantError(row.error) }));

  let afterTree: Record<string, string> = {};
  let afterSentinelSha = '';
  let markerAbsent = false;
  try {
    afterTree = hashTree(manifest.workspaceRoot);
    afterSentinelSha = createHash('sha256').update(readFileSync(sentinel)).digest('hex');
    markerAbsent = !existsSync(markerAbs);
  } catch (error) { captureFailure ??= error instanceof Error ? error.name : 'UnknownError'; }

  let clientClosed = false;
  try {
    await client.close();
    clientClosed = client.exited === true && client.exitCode === 0;
    if (!clientClosed) captureFailure ??= 'client_exit_not_clean';
  } catch (error) { captureFailure ??= error instanceof Error ? error.name : 'UnknownError'; }

  // Read the cleanup diagnostic only after the client is closed so the stderr
  // pump has fully drained and the final receipt is reliably present.
  // Production emits `task_cleanup_complete` keyed by a hashed context id. The
  // receipt must prove an idle, deny-all session that released its lease with no
  // cleanup errors; a missing, mismatched, or unsafe receipt fails the run.
  const cleanupDiagnostic = client.diagnostics.find((entry) => entry.event === 'task_cleanup_complete');
  const cleanupFields = cleanupDiagnostic?.cleanup;
  let cleanupReceipt: Record<string, unknown> | null = null;
  if (!cleanupDiagnostic) failures.push('cleanup_receipt_missing');
  else if (cleanupDiagnostic.correlationId !== shortHash(contextId)) failures.push('cleanup_context_mismatch');
  else if (!cleanupFields || typeof cleanupFields !== 'object') failures.push('cleanup_receipt_invalid');
  else {
    const receipt = cleanupFields as Record<string, unknown>;
    cleanupReceipt = sanitize({
      idleVerified: receipt.idleVerified === true,
      denyAllVerified: receipt.denyAllVerified === true,
      quarantined: receipt.quarantined === true,
      leaseReleased: receipt.leaseReleased === true,
      errors: Array.isArray(receipt.errors) ? receipt.errors.map((error) => String(error)) : null,
    }) as Record<string, unknown>;
    if (
      receipt.idleVerified !== true
      || receipt.denyAllVerified !== true
      || receipt.quarantined !== false
      || receipt.leaseReleased !== true
      || !Array.isArray(receipt.errors)
      || receipt.errors.length !== 0
    ) failures.push('cleanup_receipt_invalid');
  }

  let contextState: ReturnType<typeof readContextState> | null = null;
  try { contextState = readContextState(manifest.contextDatabasePath, contextId); }
  catch (error) { captureFailure ??= error instanceof Error ? error.name : 'UnknownError'; }

  let sharedIdentityUnchanged = false;
  try { await manager.assertIdentity(identity); sharedIdentityUnchanged = true } catch (error) { captureFailure ??= error instanceof Error ? error.name : 'UnknownError'; }

  let registryMatches = false;
  try { registryMatches = resolveRegistryPath({ manifest }) === identity.registryPath; } catch { /* fail closed */ }
  const sharedPidAlive = pidIsAlive(identity.pid);
  if (!registryMatches || sharedPidAlive !== true) { sharedIdentityUnchanged = false; failures.push('shared_identity_mismatch'); }

  const contextRow = contextState?.context ?? null;
  const contextSessionId = contextRow && typeof contextRow.session_id === 'string' ? contextRow.session_id : null;
  const contextWorkspaceRoot = contextRow && typeof contextRow.workspace_root === 'string' ? contextRow.workspace_root : null;
  if (contextState !== null) {
    if (contextSessionId !== sessionId) failures.push('context_session_mismatch');
    if (contextWorkspaceRoot === null || resolve(contextWorkspaceRoot) !== resolve(manifest.workspaceRoot)) failures.push('context_workspace_mismatch');
  }

  const contextState3: Case3ContextState = contextState === null
    ? { denyall: sdk?.denyAllVerified ? 'verified' : 'unknown', lease: 'unknown', quarantine: 'unknown' }
    : {
        denyall: sdk?.denyAllVerified ? 'verified' : 'unknown',
        lease: contextState.lease == null ? 'none' : String((contextState.lease as { session_id?: unknown }).session_id ?? 'present'),
        quarantine: contextState.quarantine == null ? 'none' : String((contextState.quarantine as { reason?: unknown }).reason ?? 'present'),
      };

  const beforeFlat: Record<string, string> = { ...before.workspace, sentinel: before.sentinelSha };
  const afterFlat: Record<string, string> = { ...afterTree, sentinel: afterSentinelSha };
  const parsedResponse: Case3Response = {
    status: failures.length || captureFailure ? 'failed' : String(output.status ?? 'failed'),
    error_code: failures.length ? failures[0]! : String(output.error_code ?? captureFailure ?? ''),
  };

  const controlTrace = client.diagnostics.filter((entry) => entry.component === 'case3-control');
  const controlAssessment = inspectCase3ControlAudit(controlTrace, proof?.sdk ?? { promptId: '', model: '', toolCalls: [] });
  const controlVerified = client.diagnosticCaptureErrors.length === 0 && controlAssessment.verdict === 'PASS';
  const classification = classifyCase3Evidence({
    response: parsedResponse,
    sdk: proof?.sdk ?? { promptId: '', model: '', toolCalls: [] },
    events: proof?.events ?? [],
    diagnostics: { ...proof?.diagnostics, ...(captureFailure && { captureFailure }) },
    before: beforeFlat,
    after: afterFlat,
    markerAbsent,
    sharedIdentityUnchanged,
    mcpClosed: clientClosed,
    contextState: contextState3,
    assistantErrors,
    interruption: proof?.interruption,
    controlled: state.controlled,
    controlTrace,
    controlCaptureComplete: client.diagnosticCaptureErrors.length === 0,
  });

  if (state.controlled) writeFileSync(join(evidenceDir, 'case3-control-events.json'), JSON.stringify(controlTrace, null, 2), { flag: 'wx' });

  const verdict = failures.length || captureFailure ? 'FAIL' : classification.verdict;
  const reason = failures.length ? failures.join(',') : (captureFailure ? `capture failure: ${captureFailure}` : classification.reason);

  const record: Record<string, unknown> = {
    evidenceVersion: 3,
    mode: state.controlled ? 'controlled-live' : 'normal-live',
    controlVerified,
    controlAssessment,
    diagnosticCaptureErrors: client.diagnosticCaptureErrors,
    runId: manifest.runId,
    caseId: 'case3-recheck',
    contextId,
    sessionId,
    reservation: { seq: reservation.seq, reservedAt: reservation.reservedAt },
    output: sanitize({
      status: output.status ?? null,
      error_code: output.error_code ?? null,
      context_id: output.context_id ?? null,
      session_id: output.session_id ?? null,
    }),
    messageCosts: sanitize(sdk?.messageCosts ?? []),
    proof: {
      sdk: sanitize(proof?.sdk ?? null),
      events: sanitize(proof?.events ?? []),
      interruption: sanitize(proof?.interruption ?? null),
      abortSemantics: CASE3_ABORT_SEMANTICS,
      permissionEvents: (sdk?.permissionEvents ?? []).map((row) => sanitize({
        action: row.action ?? null,
        reply: row.reply ?? null,
        requestID: row.requestID ?? null,
        time: row.time ?? null,
        resourceSHA256: Array.isArray(row.resources)
          ? row.resources.filter((resource: unknown): resource is string => typeof resource === 'string').map((resource: string) => sha256Hex(resource))
          : [],
      })),
      toolResults: (sdk?.toolResults ?? []).map((row) => sanitize({
        callID: row.callID ?? null,
        name: row.name ?? null,
        status: row.status ?? null,
        errorType: row.errorType ?? null,
      })),
    },
    files: { before: beforeFlat, after: afterFlat },
    contextState: contextState3,
    client: { pid: client.pid ?? null, exited: client.exited, exitCode: client.exitCode, closed: clientClosed },
    sharedIdentity: sanitize({ id: identity.id, pid: identity.pid, url: identity.url, version: identity.version, registryPath: identity.registryPath }),
    sharedPidAlive,
    registryMatches,
    diagnostics: sanitize(client.diagnostics),
    captureFailure,
    eventEvidencePath,
    cleanupReceipt,
    assistantErrors: sanitize(assistantErrors),
    streamError: streamError ? (streamError instanceof Error ? streamError.name : 'UnknownError') : null,
    classification: { verdict, reason },
    checks: {
      shellRejected: proof?.sdk.toolCalls.some((call) => call.name === 'shell' && call.asked && call.replied && call.decision === 'reject') ? 'PASS' : 'UNVERIFIED',
      readCascade: proof?.diagnostics.pendingReadsAtShellReject === true && proof.diagnostics.bridgeReadAllowReply === false ? 'PASS' : 'UNVERIFIED',
      controlAudit: state.controlled ? controlVerified ? 'PASS' : 'UNVERIFIED' : 'NOT_REQUIRED',
      stale404: client.diagnostics.some((entry) => entry.event === 'permission_reply_reconciled' && entry.status === 404
        && proof?.sdk.toolCalls.some((call) => call.name === 'read' && call.requestID && shortHash(call.requestID) === entry.request && call.decision === 'reject')) ? 'PASS' : 'NOT_TRIGGERED',
      filesUnchanged: markerAbsent && JSON.stringify(beforeFlat) === JSON.stringify(afterFlat) ? 'PASS' : 'FAIL',
      cleanup: cleanupReceipt?.idleVerified === true && cleanupReceipt?.denyAllVerified === true
        && cleanupReceipt?.quarantined === false && cleanupReceipt?.leaseReleased === true
        && Array.isArray(cleanupReceipt?.errors) && cleanupReceipt.errors.length === 0 && clientClosed
        && contextState3.lease === 'none' && contextState3.quarantine === 'none' ? 'PASS' : 'FAIL',
    },
  };

  // Provisional evidence is written under a candidate name. The canonical
  // case3-recheck.json is only persisted after the cleanup hook resolves so its
  // recorded status is the final, post-cleanup status.
  try { writeFileSync(join(evidenceDir, 'case3-recheck-candidate.json'), JSON.stringify(record, null, 2), { flag: 'wx' }); }
  catch { throw redactedCase3Error(); }

  // Manifest context/ownership update must precede cleanup: the hook re-reads the
  // reserved context id and local root ownership from disk to prove deletion safety.
  try {
    const manifestPath = join(evidenceDir, 'manifest.json');
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    const contextIds = raw.contextIds && typeof raw.contextIds === 'object' ? raw.contextIds as Record<string, unknown> : {};
    const updated = {
      ...raw,
      ledgerDigest: createHash('sha256').update(readFileSync(ledgerPath)).digest('hex'),
      ledgerReservations: usedSlots(ledgerPath),
      contextIds: { ...contextIds, 'case3-recheck': contextId },
    };
    const tmpPath = `${manifestPath}.${randomUUID()}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(updated, null, 2), { flag: 'wx' });
    renameSync(tmpPath, manifestPath);
  } catch { throw redactedCase3Error(); }

  // Independent Case 3 run-root cleanup. Any hook fault downgrades the final
  // status to FAIL. A fresh identity failure also fails the run while the
  // helper's `identityConfirmed=false` keeps the root (no deletion). A deletion
  // atomically records readiness=blocked and localRootRemoved=true.
  let finalVerdict = verdict;
  let finalReason = reason;
  try {
    const manifestPath = join(evidenceDir, 'manifest.json');
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;

    let identityConfirmed = false;
    try { await manager.assertIdentity(identity); identityConfirmed = true; } catch { identityConfirmed = false; }

    const rawContextIds = raw.contextIds && typeof raw.contextIds === 'object'
      ? Object.values(raw.contextIds as Record<string, unknown>)
      : [];
    const onlyContextId = rawContextIds.length > 0 && rawContextIds.every((value) => value === contextId);
    const contextClean = contextState !== null
      && contextState.lease == null
      && contextState.quarantine == null
      && onlyContextId;

    const cleanupInput = {
      runId: raw.runId,
      tempRoot: raw.tempRoot,
      workspaceRoot: raw.workspaceRoot,
      contextDatabasePath: raw.contextDatabasePath,
      localRootOwnership: raw.localRootOwnership,
    } as unknown as Parameters<typeof cleanupCase3Root>[0];

    const localCleanup = cleanupCase3Root(
      cleanupInput, evidenceDir, verdict, clientClosed, identityConfirmed, contextClean,
    );

    if (localCleanup.deleted) {
      const updatedRaw = { ...raw, readiness: 'blocked', localRootRemoved: true };
      const tmpPath = `${manifestPath}.${randomUUID()}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(updatedRaw, null, 2), { flag: 'wx' });
      renameSync(tmpPath, manifestPath);
    }

    record.localCleanup = sanitize(localCleanup as unknown as Record<string, unknown>);
    if (!identityConfirmed) { finalVerdict = 'FAIL'; finalReason = 'local_cleanup_failed'; }
  } catch {
    finalVerdict = 'FAIL';
    finalReason = 'local_cleanup_failed';
  }

  if (finalVerdict !== verdict || finalReason !== reason) {
    record.classification = { verdict: finalVerdict, reason: finalReason };
  }

  try { writeFileSync(join(evidenceDir, 'case3-recheck.json'), JSON.stringify(record, null, 2), { flag: 'wx' }); }
  catch { throw redactedCase3Error(); }

  // Ledger RESULT and the finished marker reflect the final, post-cleanup status.
  appendCompletion(ledgerPath, {
    seq: reservation.seq, runId: manifest.runId, caseId: 'case3-recheck', status: finalVerdict, reason: finalReason,
    responseStatus: parsedResponse.status, errorCode: parsedResponse.error_code, contextId, sessionId,
    endedAt: new Date().toISOString(),
  });

  try {
    writeFileSync(join(evidenceDir, ATTEMPT_MARKER_FILE), JSON.stringify({
      status: 'finished', runId: manifest.runId, contextId, sessionId,
      verdict: finalVerdict, reason: finalReason, reservationSeq: reservation.seq, finishedAt: new Date().toISOString(),
    }, null, 2), 'utf8');
  } catch { throw redactedCase3Error(); }

  // The RESULT append above changed the ledger, so refresh the manifest digest
  // and reservation count to match the ledger the digest attests to.
  try {
    const manifestPath = join(evidenceDir, 'manifest.json');
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    const updated = {
      ...raw,
      ledgerDigest: createHash('sha256').update(readFileSync(ledgerPath)).digest('hex'),
      ledgerReservations: usedSlots(ledgerPath),
    };
    const tmpPath = `${manifestPath}.${randomUUID()}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(updated, null, 2), { flag: 'wx' });
    renameSync(tmpPath, manifestPath);
  } catch { throw redactedCase3Error(); }

  return record;
}

export async function runCase3Recheck(runId: string, explicitRegistry?: string, controlled = false): Promise<unknown> {
  const prepared = await prepareCase3Run(runId, explicitRegistry);
  const { repoRoot, evidenceDir, manifest, ledgerPath, manager, api, identity } = prepared;

  const tempRoot = manifest.tempRoot;
  const workspaceRoot = manifest.workspaceRoot;

  let client: McpStdioClient | undefined;
  let pump: Promise<void> | undefined;
  const events: EventRecord[] = [];
  const controller = new AbortController();
  const contextId = randomUUID();
  let requestId: number | undefined;
  let connectedSeen = false;
  let promptSent = false;
  let streamError: unknown;
  let markConnected!: () => void;
  const connected = new Promise<void>((resolveConnected) => {
    markConnected = resolveConnected;
  });

  try {
    if (controlled) {
      const probe = (manifest as Case3Manifest & { permissionProbe?: { path: string; sha256: string; passed: boolean } }).permissionProbe;
      if (!probe?.passed || resolve(probe.path) !== join(evidenceDir, 'permission-probe.json')) throw redactedCase3Error();
      const bytes = readFileSync(probe.path);
      const result = JSON.parse(bytes.toString('utf8'));
      if (sha256Hex(bytes.toString('utf8')) !== probe.sha256 || result.passed !== true || result.cleanup?.deleted !== true
        || result.budgetUnchanged !== true || result.identity?.id !== identity.id || result.identity?.pid !== identity.pid
        || result.identity?.url !== identity.url || result.identity?.version !== identity.version) throw redactedCase3Error();
    }
    const attemptMarkerAbs = join(evidenceDir, ATTEMPT_MARKER_FILE);
    try {
      writeFileSync(attemptMarkerAbs, JSON.stringify({ status: 'started', runId, contextId }), { flag: 'wx' });
    } catch {
      throw redactedCase3Error(); // existing marker: no replay, original phase untouched
    }
    const ledgerDigestAtStart = createHash('sha256').update(readFileSync(ledgerPath)).digest('hex');

    const fixtureDir = join(workspaceRoot, `case3-recheck-${randomUUID()}`);
    mkdirSync(fixtureDir, { recursive: true });
    const seedA = join(fixtureDir, 'seed-a.txt');
    const seedB = join(fixtureDir, 'seed-b.txt');
    writeFileSync(seedA, 'CASE3_RECHECK_SEED_A', { flag: 'wx' });
    writeFileSync(seedB, 'CASE3_RECHECK_SEED_B', { flag: 'wx' });
    const markerAbs = join(fixtureDir, 'shell-marker.txt');
    const markerRelative = relative(workspaceRoot, markerAbs).replaceAll('\\', '/');
    const seedARelative = relative(workspaceRoot, seedA).replaceAll('\\', '/');
    const seedBRelative = relative(workspaceRoot, seedB).replaceAll('\\', '/');

    const sentinel = join(tempRoot, `case3-recheck-sentinel-${randomUUID()}.txt`);
    writeFileSync(sentinel, `CASE3_RECHECK_SENTINEL:${requestId}`, { flag: 'wx' });
    const before = {
      workspace: hashTree(workspaceRoot),
      sentinelSha: createHash('sha256').update(readFileSync(sentinel)).digest('hex'),
    };

    const task = [
      'Submit shell and both reads together in the SAME assistant message, in parallel; shell first in list; no retry, do nothing else.',
      `1) shell: node -e "require('node:fs').writeFileSync('${markerRelative}','CASE3_RECHECK_MARKER')"`,
      `2) read: ${seedARelative}`,
      `3) read: ${seedBRelative}`,
    ].join('\n');

    const request: Case3RecheckRequest = {
      model: CASE3_RECHECK_MODEL,
      context_id: contextId,
      workspace_root: workspaceRoot,
      permission_scope: { fileAccess: 'read_only', shellCommands: ['node --version'] },
      task,
    };

    const env = {
      ...makeIsolatedEnvironment(tempRoot),
      OPENCODE_SERVICE_REGISTRY_FILE: manifest.sharedRegistryPath,
      OPENCODE_REUSE_ONLY: 'true',
      OPENCODE_PROMPT_TIMEOUT_MS: '70000',
    };

    let executable: { entrypoint: string; args: string[] } | undefined;
    if (controlled) {
      const controlFile = join(tempRoot, 'case3-control.json');
      writeFileSync(controlFile, JSON.stringify({ mode: 'case3-controlled', workspace: workspaceRoot,
        seeds: [seedA, seedB], marker: markerRelative, identity }), { flag: 'wx' });
      executable = { entrypoint: 'tools/acceptance/controlled-mcp.ts', args: [controlFile] };
    }
    client = new McpStdioClient('case3-recheck', repoRoot, env, executable);
    await client.start();

    pump = (async () => {
      try {
        for await (const evt of api.event.subscribe({ signal: controller.signal })) {
          const kind = (evt as { type?: string }).type;
          if (kind && EVENT_WHITELIST.has(kind)) {
            events.push({ at: new Date().toISOString(), event: evt });
          }
          if (kind === 'server.connected') {
            connectedSeen = true;
            markConnected();
          }
        }
        if (!controller.signal.aborted) streamError = new Error('case3-recheck: stream ended unexpectedly');
      } catch (err) {
        if (!controller.signal.aborted) streamError = err;
      }
      if (streamError && promptSent && requestId !== undefined) {
        try {
          await client?.cancel(requestId); // non-voluntary EOF/error: never continue
        } catch {
          // keep the original streamError
        }
      }
    })();

    await Promise.race([connected, delay(CONNECT_WAIT_MS)]);
    if (!connectedSeen || streamError) throw streamError ?? redactedCase3Error();

    await manager.assertIdentity(identity);
    const ledgerDigestNow = createHash('sha256').update(readFileSync(ledgerPath)).digest('hex');
    if (ledgerDigestNow !== ledgerDigestAtStart) throw redactedCase3Error();

    if (streamError) throw streamError;
    const reservation = tryReserve(ledgerPath, `${ledgerPath}.lock`, {
      runId,
      caseId: 'case3-recheck',
      input: { ...request },
      recordInput: {
        model: request.model,
        context_id: request.context_id,
        workspace_root: request.workspace_root,
        permission_scope: { fileAccess: request.permission_scope.fileAccess },
        approvedCommandHashes: request.permission_scope.shellCommands.map((command) => sha256Hex(command)),
        taskSHA256: sha256Hex(task),
      },
    });

    requestId = client.requestId;
    promptSent = true;
    let response: unknown;
    try {
      response = await client.callTool(request, TOOL_CALL_TIMEOUT_MS); // single call, no retry
    } catch (error) {
      response = { result: { structuredContent: { status: 'failed', error_code: error instanceof Error ? error.name : 'UnknownError' } } };
    }

    const state: Case3RecheckState = {
      controlled,
      prepared,
      client,
      events,
      response,
      reservation,
      request,
      contextId,
      task,
      seedARelative,
      seedBRelative,
      markerAbs,
      markerRelative,
      sentinel,
      before,
      streamError,
    };
    return await finishCase3(state);
  } finally {
    controller.abort();
    if (pump) await Promise.race([pump.catch(() => undefined), delay(PUMP_DRAIN_MS)]);
    try {
      if (client) await client.close();
    } finally {
      await manager.close();
    }
  }
}
