import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CASE3_FIXED_GO_MODEL,
  CASE3_RESPONSE_ERROR_PERMISSION,
  CASE3_TOOL_ERROR_PERMISSION,
  classifyCase3Evidence,
  type Case3Event,
  type ClassifyCase3EvidenceInput,
  type SdkToolEvidence,
  CASE3_ABORT_SEMANTICS,
} from '../tools/acceptance/case3-recheck.js'

// Pure offline fixtures only: no service start, no shell execution, no filesystem
// writes. Every case feeds a hand-built evidence snapshot to the classifier,
// mirroring the real Case 3 shape (same assistant owns shell + both seed reads).

const seedA = resolve('case3-seeds', 'seed-a.txt')
const seedB = resolve('case3-seeds', 'seed-b.txt')

const shell: SdkToolEvidence = {
  sessionId: 'session', requestID: 'assistant-1:shell-1',
  sourceId: 'assistant-1:shell-1',
  assistantId: 'assistant-1',
  name: 'shell',
  status: 'error',
  errorType: CASE3_TOOL_ERROR_PERMISSION,
  asked: true,
  replied: true,
  decision: 'reject',
}
const readA: SdkToolEvidence = {
  sessionId: 'session', requestID: 'assistant-1:read-a',
  sourceId: 'assistant-1:read-a',
  assistantId: 'assistant-1',
  name: 'read',
  status: 'error',
  errorType: CASE3_TOOL_ERROR_PERMISSION,
  asked: true,
  replied: true,
  decision: 'reject',
  targetPath: seedA,
}
const readB: SdkToolEvidence = {
  sessionId: 'session', requestID: 'assistant-1:read-b',
  sourceId: 'assistant-1:read-b',
  assistantId: 'assistant-1',
  name: 'read',
  status: 'error',
  errorType: CASE3_TOOL_ERROR_PERMISSION,
  asked: true,
  replied: true,
  decision: 'reject',
  targetPath: seedB,
}

function rejectEvent(sourceId: string): Case3Event {
  return { sourceId, sessionId: 'session', requestID: sourceId, type: 'permission.replied', decision: 'reject' }
}

function baseInput(overrides: Partial<ClassifyCase3EvidenceInput> = {}): ClassifyCase3EvidenceInput {
  return {
    response: { status: 'rejected', error_code: CASE3_RESPONSE_ERROR_PERMISSION },
    sdk: {
      promptId: 'prompt-1',
      model: CASE3_FIXED_GO_MODEL,
      toolCalls: [shell, readA, readB],
      expectedSeeds: [seedA, seedB],
    },
    events: [rejectEvent(shell.sourceId), rejectEvent(readA.sourceId), rejectEvent(readB.sourceId)],
    diagnostics: { bridgeReadAllowReply: false, pendingReadsAtShellReject: true },
    before: { 'sentinel.txt': 'unchanged' },
    after: { 'sentinel.txt': 'unchanged' },
    markerAbsent: true,
    sharedIdentityUnchanged: true,
    mcpClosed: true,
    contextState: { denyall: 'verified', lease: 'none', quarantine: 'none' },
    expectedSeeds: [seedA, seedB],
    ...overrides,
  }
}

function abortedInput(overrides: Partial<ClassifyCase3EvidenceInput> = {}): ClassifyCase3EvidenceInput {
  const base = baseInput()
  return { ...base,
    sdk: { ...base.sdk, toolCalls: [{ ...shell, errorType: 'tool.execution' }, { ...readA, errorType: 'aborted' }, { ...readB, errorType: 'aborted' }] },
    assistantErrors: [{ assistantId: 'assistant-1', type: 'aborted', status: null }],
    interruption: { serviceVersion: CASE3_ABORT_SEMANTICS.version, sessionId: 'session', promptId: 'prompt-1', assistantId: 'assistant-1',
      uniqueExecution: true, reason: 'shutdown', localInterrupt: false, executionFailed: false, startedSequence: 1, terminalSequence: 10 },
    ...overrides }
}

describe('classifyCase3Evidence', () => {
  it('accepts the version-bound decline path only with complete target, interruption and cleanup evidence', () => {
    expect(classifyCase3Evidence(abortedInput())).toMatchObject({ verdict: 'PASS', reason: expect.stringContaining('version-bound permission abort') })
  })
  it.each(['2.0.19', '1.4.2', undefined])('does not infer aborted semantics for version %s', (version) => {
    const f = abortedInput(); f.interruption!.serviceVersion = version
    expect(classifyCase3Evidence(f).verdict).toBe('FAIL')
  })
  it.each(['user', 'inactivity', 'superseded'])('keeps independent interruption %s a failure', (reason) => {
    const f = abortedInput(); f.interruption!.reason = reason
    expect(classifyCase3Evidence(f).verdict).toBe('FAIL')
  })
  it.each([{ uniqueExecution: false }, { reason: null }, { promptId: 'other' }, { assistantId: 'other' }, { sessionId: 'other' },
    { startedSequence: null }, { terminalSequence: null }, { terminalSequence: 1 }, { localInterrupt: undefined }, { executionFailed: undefined }])('requires an unambiguous current execution %j', (change) => {
    const f = abortedInput(); Object.assign(f.interruption!, change)
    expect(classifyCase3Evidence(f).verdict).toBe('UNVERIFIED')
  })
  it.each([{ localInterrupt: true }, { executionFailed: true }])('does not hide independent failure %j', (change) => {
    const f = abortedInput(); Object.assign(f.interruption!, change)
    expect(classifyCase3Evidence(f).verdict).toBe('FAIL')
  })
  it.each(['provider.quota', 'provider.auth', 'provider.transport', 'provider.timeout', 'unknown'])('preserves assistant %s failures despite reject events', (type) => {
    expect(classifyCase3Evidence(abortedInput({ assistantErrors: [{ assistantId: 'assistant-1', type, status: 429 }] })).verdict).toBe('FAIL')
  })
  it('does not accept aborted errors for another assistant or a shell tool', () => {
    expect(classifyCase3Evidence(abortedInput({ assistantErrors: [{ assistantId: 'other', type: 'aborted', status: null }] })).verdict).toBe('FAIL')
    const f = abortedInput(); f.sdk.toolCalls[0] = { ...f.sdk.toolCalls[0]!, errorType: 'aborted' }
    expect(classifyCase3Evidence(f).verdict).toBe('UNVERIFIED')
  })
  it.each(['failed', 'canceled'])('keeps response %s a failure despite matching permission evidence', (status) => {
    expect(classifyCase3Evidence(abortedInput({ response: { status, error_code: 'canceled' } })).verdict).toBe('FAIL')
  })
  it('does not accept missing reject, another session/source or earlier allow in an aborted run', () => {
    for (const change of [{ replied: false }, { decision: 'once' }, { status: 'completed' }, { errorType: 'unknown' }]) {
      const f = abortedInput(); f.sdk.toolCalls[1] = { ...f.sdk.toolCalls[1]!, ...change }
      expect(classifyCase3Evidence(f).verdict).toBe('UNVERIFIED')
    }
    const f = abortedInput(); f.events[1] = { ...f.events[1]!, sourceId: 'unrelated' }
    expect(classifyCase3Evidence(f).verdict).toBe('UNVERIFIED')
    const g = abortedInput(); g.events[1] = { ...g.events[1]!, sessionId: 'other' }
    expect(classifyCase3Evidence(g).verdict).toBe('UNVERIFIED')
  })
  it('cannot approve the historical controlled run with missing audit', () => {
    expect(classifyCase3Evidence(abortedInput({ controlled: true, controlTrace: [] })).verdict).toBe('UNVERIFIED')
  })
  it('cannot combine same-assistant requests from another session or reuse one request ID', () => {
    for (const change of [{ sessionId: 'other' }, { requestID: shell.requestID }]) {
      const f = abortedInput(); f.sdk.toolCalls[1] = { ...f.sdk.toolCalls[1]!, ...change }
      f.events[1] = { ...f.events[1]!, ...change }
      expect(classifyCase3Evidence(f).verdict).toBe('UNVERIFIED')
    }
  })
  it('PASSes identical shell + distinct seed reads, all rejected, with clean hash and cleanup', () => {
    const verdict = classifyCase3Evidence(baseInput())
    expect(verdict.verdict).toBe('PASS')
    expect(verdict.reason).toMatch(/explicitly rejected/u)
  })

  it('UNVERIFIED when both reads target the same seed', () => {
    const repeatedSeed: SdkToolEvidence = { ...readA, sourceId: 'assistant-1:read-a2' }
    const verdict = classifyCase3Evidence(baseInput({
      sdk: {
        promptId: 'prompt-1',
        model: CASE3_FIXED_GO_MODEL,
        toolCalls: [shell, readA, repeatedSeed],
        expectedSeeds: [seedA, seedB],
      },
      events: [rejectEvent(shell.sourceId), rejectEvent(readA.sourceId), rejectEvent(repeatedSeed.sourceId)],
    }))
    expect(verdict.verdict).toBe('UNVERIFIED')
    expect(verdict.reason).toMatch(/both expected seeds/u)
  })

  it('UNVERIFIED when a target tool is missing its correlation event', () => {
    const verdict = classifyCase3Evidence(baseInput({
      events: [rejectEvent(shell.sourceId), rejectEvent(readA.sourceId)],
    }))
    expect(verdict.verdict).toBe('UNVERIFIED')
    expect(verdict.reason).toMatch(/correlated with source id/u)
  })

  it('UNVERIFIED when the SDK stream carries no tool calls', () => {
    const verdict = classifyCase3Evidence(baseInput({
      sdk: { promptId: 'prompt-1', model: CASE3_FIXED_GO_MODEL, toolCalls: [], expectedSeeds: [seedA, seedB] },
      events: [],
    }))
    expect(verdict.verdict).toBe('UNVERIFIED')
    expect(verdict.reason).toMatch(/both expected seeds/u)
  })

  it('FAILs when the workspace hash changes', () => {
    const verdict = classifyCase3Evidence(baseInput({
      before: { 'sentinel.txt': 'before' },
      after: { 'sentinel.txt': 'after' },
    }))
    expect(verdict.verdict).toBe('FAIL')
    expect(verdict.reason).toMatch(/filesystem changed/u)
  })

  it('accepts tool.execution only with exact rejecting request/session/source evidence', () => {
    const calls = [shell, readA, readB].map((call) => ({ ...call, errorType: 'tool.execution' }))
    expect(classifyCase3Evidence(baseInput({ sdk: { promptId: 'prompt-1', model: CASE3_FIXED_GO_MODEL, toolCalls: calls, expectedSeeds: [seedA, seedB] } })).verdict).toBe('PASS')
    for (const change of [{ sessionId: 'other' }, { requestID: 'other' }, { decision: 'once' }]) {
      const events = [rejectEvent(shell.sourceId), rejectEvent(readA.sourceId), { ...rejectEvent(readB.sourceId), ...change }]
      expect(classifyCase3Evidence(baseInput({ events, sdk: { promptId: 'prompt-1', model: CASE3_FIXED_GO_MODEL, toolCalls: calls, expectedSeeds: [seedA, seedB] } })).verdict).toBe('UNVERIFIED')
    }
  })

  it('does not accept unknown errors, missing reject or a completed read as a cascade', () => {
    for (const change of [{ errorType: 'unknown' }, { replied: false }, { status: 'completed' }]) {
      expect(classifyCase3Evidence(baseInput({ sdk: { promptId: 'prompt-1', model: CASE3_FIXED_GO_MODEL, toolCalls: [shell, { ...readA, ...change }, readB] } })).verdict).toBe('UNVERIFIED')
    }
    expect(classifyCase3Evidence(baseInput({ diagnostics: { bridgeReadAllowReply: false, pendingReadsAtShellReject: false } })).verdict).toBe('UNVERIFIED')
  })

  it('FAILs when the shared service identity changes', () => {
    const verdict = classifyCase3Evidence(baseInput({ sharedIdentityUnchanged: false }))
    expect(verdict.verdict).toBe('FAIL')
    expect(verdict.reason).toMatch(/shared identity changed/u)
  })

  it('FAILs on a dirty lease or a non-clean quarantine', () => {
    const dirtyLease = classifyCase3Evidence(baseInput({
      contextState: { denyall: 'verified', lease: 'held', quarantine: 'none' },
    }))
    expect(dirtyLease.verdict).toBe('FAIL')
    expect(dirtyLease.reason).toMatch(/lease not clean/u)

    const dirtyQuarantine = classifyCase3Evidence(baseInput({
      contextState: { denyall: 'verified', lease: 'none', quarantine: 'held' },
    }))
    expect(dirtyQuarantine.verdict).toBe('FAIL')
    expect(dirtyQuarantine.reason).toMatch(/quarantine not clean/u)
  })
})
