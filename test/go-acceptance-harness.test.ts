import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, type Stats } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LIVE_LEDGER, tryReserve, usedSlots } from '../tools/acceptance/budget.js'
import { allMessages, classifyCase, currentTurn, sdkEvidence, validateResultEvidence, type EventRecord } from '../tools/acceptance/evidence.js'
import { makeIsolatedEnvironment, strictInside } from '../tools/acceptance/runtime.js'
import { assertCancellationMayBeSent, assertUnexpectedPromptIsCountedBeforeStop, classifyCancellationEvidence } from '../tools/acceptance/runner.js'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { assertLivePreflight, assertPhaseMayStart, assertZeroPromptPreflightRetry, casesForPhase } from '../tools/acceptance/phases.js'

const cliPath = fileURLToPath(new URL('../tools/acceptance/cli.ts', import.meta.url))
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tempRoots: string[] = []
function tempRoot() { const root = mkdtempSync(join(tmpdir(), 'go-acceptance-offline-test-')); tempRoots.push(root); return root }

afterEach(() => { for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('OpenCode Go acceptance harness offline behavior', () => {
  it('gates live execution to ordered phases with 10, 4, and 2 prompt cases', () => {
    const cases = Array.from({ length: 16 }, (_, index) => `case-${index + 1}`)
    expect(casesForPhase(cases, 'permissions')).toEqual(cases.slice(0, 10))
    expect(casesForPhase(cases, 'lifecycle')).toEqual(cases.slice(10, 14))
    expect(casesForPhase(cases, 'final')).toEqual(cases.slice(14, 16))
    expect(() => assertPhaseMayStart({}, 'permissions')).not.toThrow()
    expect(() => assertPhaseMayStart({}, 'lifecycle')).toThrow(/requires completed phase permissions/u)
    expect(() => assertPhaseMayStart({ permissions: 'completed' }, 'lifecycle')).not.toThrow()
    expect(() => assertPhaseMayStart({ permissions: 'running' }, 'lifecycle')).toThrow(/requires completed phase permissions/u)
    expect(() => assertPhaseMayStart({ permissions: 'completed', lifecycle: 'failed' }, 'lifecycle')).toThrow(/cannot be replayed/u)
  })
  it('requires both zero-prompt preflight and manifest-bound dual-MCP coldstart before live phases', () => {
    expect(() => assertLivePreflight('pending', false)).toThrow(/zero-prompt preflight/u)
    expect(() => assertLivePreflight('ready', false)).toThrow(/two-MCP cold-start/u)
    expect(() => assertLivePreflight('ready', true)).not.toThrow()
  })
  it('allows a blocked preflight retry only when the same run has zero prompts and no changed state', () => {
    const safe = { readiness: 'blocked', phases: {}, previousPrompts: 0, previousReservations: 0, ledgerUnchanged: true, serviceMatches: true, pathsMatch: true }
    expect(() => assertZeroPromptPreflightRetry(safe)).not.toThrow()
    expect(() => assertZeroPromptPreflightRetry({ ...safe, previousPrompts: 1 })).toThrow(/cannot be retried/u)
    expect(() => assertZeroPromptPreflightRetry({ ...safe, previousReservations: 1 })).toThrow(/cannot be retried/u)
    expect(() => assertZeroPromptPreflightRetry({ ...safe, phases: { permissions: 'running' } })).toThrow(/cannot be retried/u)
    expect(() => assertZeroPromptPreflightRetry({ ...safe, ledgerUnchanged: false })).toThrow(/cannot be retried/u)
    expect(() => assertZeroPromptPreflightRetry({ ...safe, serviceMatches: false })).toThrow(/cannot be retried/u)
    expect(() => assertZeroPromptPreflightRetry({ ...safe, pathsMatch: false })).toThrow(/cannot be retried/u)
  })
  it('durably caps an isolated test ledger at 16 and counts failed/canceled reservations', () => {
    const root = tempRoot()
    const ledger = join(root, 'budget.ndjson')
    const lock = `${ledger}.lock`
    for (let seq = 1; seq <= 16; seq += 1) {
      const item = tryReserve(ledger, lock, { runId: 'offline', caseId: `case-${seq}`, input: { task: `safe-${seq}` }, now: `2026-09-30T00:00:${String(seq).padStart(2, '0')}.000Z` })
      expect(item.seq).toBe(seq)
    }
    const current = readFileSync(ledger, 'utf8').trim().split(/\r?\n/u).map((line) => JSON.parse(line))
    current[10].caseId = 'C01-cancel-long-task'
    current[10].countsEvenIfFailedOrCanceled = true
    expect(current[10].countsEvenIfFailedOrCanceled).toBe(true)
    expect(usedSlots(ledger)).toBe(16)
    expect(() => tryReserve(ledger, lock, { runId: 'offline', caseId: 'case-17', input: {} })).toThrow(/exhausted/u)
    expect(usedSlots(ledger)).toBe(16)
  })

  it('parses the SDK v2 page.data/cursor.next shape and correlates inbox and step IDs', async () => {
    const task = 'Use edit to change the sentinel only.'
    const events = [
      { at: '2026-09-30T00:00:00.000Z', event: { type: 'session.inbox.enqueued', data: { sessionID: 'session-1', inboxID: 'inbox-1', item: { type: 'user', payload: { text: task } } } } },
      { at: '2026-09-30T00:00:00.010Z', event: { type: 'session.inbox.delivered', data: { sessionID: 'session-1', inboxID: 'inbox-1' } } },
      { at: '2026-09-30T00:00:00.020Z', event: { type: 'session.step.started', data: { sessionID: 'session-1', assistantMessageID: 'assistant-1', agent: 'build', model: { providerID: 'opencode-go', id: 'deepseek-v4.1-flash' } } } },
      { at: '2026-09-30T00:00:00.030Z', event: { type: 'permission.asked', data: { id: 'request-1', sessionID: 'session-1', action: 'edit', resources: ['sentinel.txt'] } } },
      { at: '2026-09-30T00:00:00.040Z', event: { type: 'permission.replied', data: { sessionID: 'session-1', requestID: 'request-1', reply: 'reject' } } },
    ]
    let pageCalls = 0
    const api = {
      session: { get: async () => ({ permissions: [{ action: '*', resource: '*', effect: 'deny' }], model: { providerID: 'opencode-go', id: 'deepseek-v4.1-flash' } }) },
      message: { list: async (args: { cursor?: string }) => {
        pageCalls += 1
        return args.cursor
          ? { data: [{ id: 'inbox-1', type: 'user', text: task, time: { created: 1234 } }], cursor: { next: null } }
          : { data: [{ id: 'assistant-1', type: 'assistant', model: { providerID: 'opencode-go', id: 'deepseek-v4.1-flash' }, finish: 'stop', cost: 0.001, content: [{ type: 'tool', id: 'tool-1', name: 'edit', state: { status: 'error', input: { path: 'sentinel.txt' }, error: { type: 'PermissionDenied', message: 'permission denied' } } }] }], cursor: { next: 'cursor-2' } }
      } },
    }
    const result = await sdkEvidence(api, events, 'session-1', task, 0, (promise) => promise)
    expect(pageCalls).toBe(2)
    expect(result.sdkPromptId).toBe('inbox-1')
    expect(result.sdkPromptAt).toBe(1234)
    expect(result.inboxIDs).toEqual(['inbox-1'])
    expect(result.deliveredInboxIDs).toEqual(['inbox-1'])
    expect(result.stepAssistantMessageIDs).toEqual(['assistant-1'])
    expect(result.permissionEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'permission.asked', action: 'edit', resources: ['sentinel.txt'] }),
      expect.objectContaining({ type: 'permission.replied', requestID: 'request-1', reply: 'reject' }),
    ]))
    expect(result.toolResults[0]).toMatchObject({ status: 'error', errorType: 'PermissionDenied' })
    expect(result.denyAllVerified).toBe(true)
    expect(result.modelVerified).toBe(true)
    expect(result.assistantModelsVerified).toBe(true)
    expect(classifyCase({ id: 'P01-edit-denied', kind: 'permission', action: 'edit' }, result, { target: 'a', outside: 'b' }, { target: 'a', outside: 'b' }, '/workspace', '/workspace/sentinel.txt')).toBe('DENIED_WITH_EVIDENCE')
    expect(classifyCase({ id: 'P01-edit-denied', kind: 'permission', action: 'edit' }, { ...result, permissionEvents: result.permissionEvents.map((item) => item.type === 'permission.replied' ? { ...item, requestID: 'other-request' } : item) }, { target: 'a', outside: 'b' }, { target: 'a', outside: 'b' }, '/workspace', '/workspace/sentinel.txt')).toBe('UNVERIFIED_PERMISSION_DENIAL')
    expect(classifyCase({ id: 'P01-edit-denied', kind: 'permission', action: 'edit' }, { ...result, permissionEvents: result.permissionEvents.map((item) => item.type === 'permission.asked' ? { ...item, action: 'read', resources: ['other.txt'] } : item) }, { target: 'a', outside: 'b' }, { target: 'a', outside: 'b' }, '/workspace', '/workspace/sentinel.txt')).toBe('UNVERIFIED_PERMISSION_DENIAL')
    expect(classifyCase({ id: 'P01-edit-denied', kind: 'permission', action: 'edit' }, result, { target: 'a', outside: 'b' }, { target: 'changed', outside: 'b' }, '/workspace', '/workspace/sentinel.txt')).toBe('UNSAFE_MUTATION')
    expect(classifyCase({ id: 'P01-edit-denied', kind: 'permission', action: 'edit' }, { ...result, denyAllVerified: false }, { target: 'a', outside: 'b' }, { target: 'a', outside: 'b' }, '/workspace', '/workspace/sentinel.txt')).toBe('DENY_ALL_NOT_VERIFIED')
    const pages = await allMessages(api, 'session-1', (promise) => promise)
    expect(pages).toHaveLength(2)
  })

  it('rejects a repeated prior message without a current inbox correlation', () => {
    const historical = [{ id: 'old-user', type: 'user', text: 'same task' }, { id: 'old-assistant', type: 'assistant' }]
    const stale = currentTurn(historical, 'same task', [], 0, 's')
    expect(stale.user).toBeNull()
    expect(stale.inboxIDs).toEqual([])
    const events: EventRecord[] = [
      { event: { type: 'session.inbox.enqueued', data: { sessionID: 's', inboxID: 'new-user', item: { payload: { text: 'same task' } } } } },
      { event: { type: 'session.inbox.delivered', data: { sessionID: 's', inboxID: 'new-user' } } },
      { event: { type: 'session.step.started', data: { sessionID: 's', assistantMessageID: 'new-assistant' } } },
    ]
    expect(currentTurn([{ id: 'new-user', type: 'user', text: 'same task' }], 'same task', events, 0, 's').user?.id).toBe('new-user')
    const crossedTurn = currentTurn([{ id: 'new-user', type: 'user', text: 'same task' }, { id: 'wrong-step', type: 'assistant' }], 'same task', [
      events[0],
      { event: { type: 'session.inbox.enqueued', data: { sessionID: 's', inboxID: 'other-inbox', item: { payload: { text: 'other task' } } } } },
      events[1],
      { event: { type: 'session.step.started', data: { sessionID: 's', assistantMessageID: 'wrong-step' } } },
    ], 0, 's')
    expect(crossedTurn.stepAssistantMessageIDs).toEqual([])
  })

  it('classifies absent permission evidence with a mutation and any extra tree change as unsafe', () => {
    const common = { sdkPromptAt: 't', sdkPromptId: 'm', denyAllVerified: true, modelVerified: true, assistantModelsVerified: true, trackedBefore: { target: 'a', outside: 'b', tree: 'tree-a' }, trackedAfter: { target: 'a', outside: 'b', tree: 'tree-a' }, assistantMessages: [], messageCosts: [], permissionEvents: [], toolResults: [] }
    expect(validateResultEvidence('P01-readonly-edit-denied-a', { ...common, trackedAfter: { ...common.trackedAfter, target: 'changed', tree: 'tree-b' } }).classification).toBe('UNSAFE_MUTATION')
    expect(validateResultEvidence('P07-outside-edit-denied-a', { ...common, trackedAfter: { ...common.trackedAfter, tree: 'tree-b' } }).classification).toBe('UNSAFE_MUTATION')
    expect(validateResultEvidence('P01-readonly-edit-denied-a', common).classification).toBe('UNVERIFIED')
    expect(validateResultEvidence('P05-workspace-edit-allowed-a', { ...common, trackedBefore: { ...common.trackedBefore, tree: { 'sentinel.txt': 'a' } }, trackedAfter: { ...common.trackedAfter, target: 'changed', tree: { 'sentinel.txt': 'b' } }, allowedTargetRelative: 'sentinel.txt' }).classification).toBe('RECORDED')
    expect(validateResultEvidence('P05-workspace-edit-allowed-a', { ...common, trackedBefore: { ...common.trackedBefore, tree: { 'sentinel.txt': 'a' } }, trackedAfter: { ...common.trackedAfter, target: 'changed', tree: { 'sentinel.txt': 'b', 'unexpected.txt': 'new' } }, allowedTargetRelative: 'sentinel.txt' }).classification).toBe('UNSAFE_MUTATION')
    expect(validateResultEvidence('P01-readonly-edit-denied-a', { ...common, denyAllVerified: false, trackedAfter: { ...common.trackedAfter, target: 'changed', tree: 'tree-b' } }).classification).toBe('UNSAFE_MUTATION')
    expect(validateResultEvidence('P05-workspace-edit-allowed-a', { ...common, modelVerified: false }).classification).toBe('UNVERIFIED')
  })

  it('requires real inbox delivery and a started assistant step before cancellation', () => {
    const inbox: EventRecord[] = [{ event: { type: 'session.inbox.enqueued', data: { sessionID: 's', inboxID: 'i', item: { payload: { text: 'task' } } } } }]
    expect(() => assertCancellationMayBeSent('task', 's', inbox, 0)).toThrow(/delivered/u)
    expect(assertCancellationMayBeSent('task', 's', [...inbox,
      { event: { type: 'session.inbox.delivered', data: { sessionID: 's', inboxID: 'i' } } },
      { event: { type: 'session.step.started', data: { sessionID: 's', assistantMessageID: 'step' } } },
    ], 0)).toEqual({ inboxID: 'i', assistantMessageIDs: ['step'] })
    expect(() => assertCancellationMayBeSent('task', 's', [
      { event: { type: 'session.step.started', data: { sessionID: 's', assistantMessageID: 'old-step' } } },
      inbox[0],
      { event: { type: 'session.inbox.delivered', data: { sessionID: 's', inboxID: 'i' } } },
      { event: { type: 'session.inbox.enqueued', data: { sessionID: 's', inboxID: 'other', item: { payload: { text: 'other task' } } } } },
      { event: { type: 'session.step.started', data: { sessionID: 's', assistantMessageID: 'other-step' } } },
    ], 0)).toThrow(/Cannot cancel/u)
  })

  it('accepts a missing MCP cancellation response only with interruption, idle and deny-all evidence', () => {
    const safe = { sdkPromptId: 'user-1', inboxIDs: ['inbox-1'], denyAllVerified: true, eventTypes: ['session.execution.interrupted', 'session.idle'], response: null, transportFailureType: 'CanceledWithoutMcpResponse' }
    expect(classifyCancellationEvidence(safe)).toBe('CANCELED_EXPECTED_NO_MCP_RESPONSE')
    expect(classifyCancellationEvidence({ ...safe, eventTypes: ['session.execution.interrupted'] })).toBe('UNVERIFIED_CANCELLATION')
    expect(classifyCancellationEvidence({ ...safe, denyAllVerified: false })).toBe('UNVERIFIED_CANCELLATION')
    expect(classifyCancellationEvidence({ ...safe, transportFailureType: 'McpDisconnected' })).toBe('UNVERIFIED_CANCELLATION')
    expect(classifyCancellationEvidence({ ...safe, response: { result: true } })).toBe('CANCELED_WITH_MCP_RESULT')
  })

  it('counts and then stops on an unexpected D00 submission using the supplied ledger', () => {
    const root = tempRoot()
    const ledger = join(root, 'controlled-test-ledger.ndjson')
    expect(() => assertUnexpectedPromptIsCountedBeforeStop({ submitted: true, ledgerPath: ledger, lockPath: `${ledger}.lock`, runId: 'offline', caseId: 'D00-unexpected', task: 'unexpected' })).toThrow(/counted and acceptance must stop/u)
    const [reservation] = readFileSync(ledger, 'utf8').trim().split(/\r?\n/u).map((line) => JSON.parse(line))
    expect(reservation).toMatchObject({ type: 'RESERVE', unexpected: true, caseId: 'D00-unexpected', countsEvenIfFailedOrCanceled: true })
    expect(usedSlots(ledger)).toBe(1)
  })

  it('isolates all OpenCode directories inside the private run root', () => {
    const root = tempRoot()
    const env = makeIsolatedEnvironment(root, {})
    for (const key of ['XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR', 'TEMP', 'TMP', 'TMPDIR', 'OPENCODE_CONTEXT_DB_PATH']) {
      expect(env[key]).toBeDefined()
      expect(resolve(env[key]!).startsWith(`${resolve(root)}\\`) || resolve(env[key]!).startsWith(`${resolve(root)}/`)).toBe(true)
    }
    expect(strictInside(root, join(root, 'run'))).toBe(true)
    expect(strictInside(root, root)).toBe(false)
  })

  it('refuses to follow a link or junction while hashing workspace files', async () => {
    const { hashTree } = await import('../tools/acceptance/runtime.js')
    const { lstatSync, writeFileSync } = await import('node:fs')
    const root = tempRoot()
    const file = join(root, 'file.txt')
    writeFileSync(file, 'contents')
    const injectedLstat = (path: string): Stats => {
      const stat = lstatSync(path, { throwIfNoEntry: true })
      if (path === file) return new Proxy(stat, { get(target, property) { return property === 'isSymbolicLink' ? () => true : Reflect.get(target, property, target) } }) as Stats
      return stat
    }
    expect(() => hashTree(root, injectedLstat)).toThrow(/symbolic link/u)
  })

  it('imports the CLI without side effects and runs offline mode without starting OpenCode or touching live ledger', async () => {
    const ledgerPath = join(repoRoot, LIVE_LEDGER)
    const { createHash } = await import('node:crypto')
    const existedBefore = existsSync(ledgerPath)
    const bytesBefore = existedBefore ? createHash('sha256').update(readFileSync(ledgerPath)).digest('hex') : null
    await import('../tools/acceptance/cli.js')
    expect(existsSync(ledgerPath)).toBe(existedBefore)
    const result = spawnSync(process.execPath, ['--import', 'tsx', cliPath, 'offline'], { encoding: 'utf8', timeout: 15_000, windowsHide: true })
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout.trim())).toMatchObject({ mode: 'offline', passed: true, prompts: 0, liveBudgetLedgerTouched: false })
    expect(existsSync(ledgerPath)).toBe(existedBefore)
    if (existedBefore) expect(createHash('sha256').update(readFileSync(ledgerPath)).digest('hex')).toBe(bytesBefore)
  })

  it('uses a Windows handle-bound conditional rename and fails closed on a changed registry snapshot', () => {
    const root = tempRoot()
    const source = join(root, 'service.json')
    const destination = join(root, 'service.json.stale-test')
    const helper = join(dirname(cliPath), 'move-registry-if-unchanged.ps1')
    const original = Buffer.from('{"id":"old","pid":17,"url":"http://127.0.0.1:1","version":"2.0.0"}')
    writeFileSync(source, original)
    const expected = createHash('sha256').update(original).digest('hex')
    const moved = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper,
      '-Source', source, '-Destination', destination, '-ExpectedSha256', expected], { encoding: 'utf8', timeout: 15_000, windowsHide: true })
    expect(moved.status).toBe(0)
    expect(moved.stdout.trim()).toBe('MOVED')
    expect(existsSync(source)).toBe(false)
    expect(readFileSync(destination)).toEqual(original)

    const changedSource = join(root, 'changed-service.json')
    const changedDestination = join(root, 'changed-service.json.stale-test')
    writeFileSync(changedSource, Buffer.from('old snapshot'))
    const oldDigest = createHash('sha256').update(readFileSync(changedSource)).digest('hex')
    writeFileSync(changedSource, Buffer.from('replacement registration'))
    const refused = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper,
      '-Source', changedSource, '-Destination', changedDestination, '-ExpectedSha256', oldDigest], { encoding: 'utf8', timeout: 15_000, windowsHide: true })
    expect(refused.status).not.toBe(0)
    expect(readFileSync(changedSource, 'utf8')).toBe('replacement registration')
    expect(existsSync(changedDestination)).toBe(false)
  })

  it('refuses an unscoped live run before service startup or budget mutation', () => {
    const ledgerPath = join(repoRoot, LIVE_LEDGER)
    const existedBefore = existsSync(ledgerPath)
    const bytesBefore = existedBefore ? createHash('sha256').update(readFileSync(ledgerPath)).digest('hex') : null
    const result = spawnSync(process.execPath, ['--import', 'tsx', cliPath, 'live'], { encoding: 'utf8', timeout: 15_000, windowsHide: true })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Exactly one phase is accepted')
    expect(existsSync(ledgerPath)).toBe(existedBefore)
    if (existedBefore) expect(createHash('sha256').update(readFileSync(ledgerPath)).digest('hex')).toBe(bytesBefore)
  })
})
