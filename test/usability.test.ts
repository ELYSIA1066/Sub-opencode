import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { removeOwnedTree } from '../tools/cleanup/owned-tree.js'
import { rows, tryReserve, usedSlots } from '../tools/acceptance/budget.js'
import { parseLiveOptions } from '../tools/acceptance/cli.js'
import { classifyUsabilityRound, makeUsabilityEnvironment, runUsability, type UsabilityDependencies, type UsabilityRound } from '../tools/acceptance/usability.js'

const model = { providerID: 'opencode-go', id: 'deepseek-v4.1-flash' }
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) if (existsSync(root)) removeOwnedTree(root, tmpdir()) })

function round(stage: 'U01' | 'U02' = 'U01'): UsabilityRound {
  const tools = stage === 'U01' ? ['read', 'edit', 'read'] : ['read']
  return {
    stage, response: { status: 'completed', context_id: 'context', session_id: 'session', result: stage === 'U01' ? 'USABILITY_EDIT_OK' : 'USABILITY_CONTINUE_OK|MEM_example|USABILITY_EDIT_OK' },
    expectedContext: 'context', previousSession: 'session', previousPrompt: 'previous-inbox', target: join(tmpdir(), 'workspace', 'target.txt'), workspace: join(tmpdir(), 'workspace'),
    sdk: { sdkPromptId: 'inbox', inboxIDs: ['inbox'], deliveredInboxIDs: ['inbox'], stepAssistantMessageIDs: ['step1', 'step2', 'step3'],
      modelVerified: true, assistantModelsVerified: true, assistantMessages: [{ id: 'step1', model, error: null }], messageCosts: [], permissionEvents: [], denyAllVerified: true,
      toolResults: tools.map((name, index) => ({ name, callID: `tool${index}`, assistantMessageID: `step${index + 1}`, status: 'completed', input: { filePath: 'target.txt' } })) },
    inboxCount: 1, targetText: 'USABILITY_EDIT_OK\n', before: { 'target.txt': stage === 'U01' ? 'before' : 'after', '../sentinel': 'stable' },
    after: { 'target.txt': 'after', '../sentinel': 'stable' }, expectedReply: stage === 'U01' ? 'USABILITY_EDIT_OK' : 'USABILITY_CONTINUE_OK|MEM_example|USABILITY_EDIT_OK',
    idleVerified: true, mappingVerified: true, leaseAbsent: true, quarantineAbsent: true, cleanupVerified: true, sharedIdentityUnchanged: true, clientClosed: true, faults: [],
  }
}

describe('ordinary usability evidence', () => {
  it('accepts current read/edit/read and persistent read-only continuation', () => {
    expect(classifyUsabilityRound(round()).verdict).toBe('PASS')
    expect(classifyUsabilityRound(round('U02')).verdict).toBe('PASS')
    const input = round(); input.targetText = 'USABILITY_EDIT_OK\r\n'
    expect(classifyUsabilityRound(input).verdict).toBe('PASS')
  })
  it.each(['no-tools', 'one-read', 'wrong-target', 'wrong-order', 'no-assistant-link', 'historical', 'no-inbox', 'undelivered'])(
    'does not substitute text or history for tool evidence: %s', (scenario) => {
      const input = round()
      if (scenario === 'no-tools') input.sdk.toolResults = []
      if (scenario === 'one-read') input.sdk.toolResults.pop()
      if (scenario === 'wrong-target') input.sdk.toolResults[1].input.filePath = 'other.txt'
      if (scenario === 'wrong-order') input.sdk.toolResults[0].assistantMessageID = 'step3'
      if (scenario === 'no-assistant-link') input.sdk.toolResults[1].assistantMessageID = 'old-step'
      if (scenario === 'historical') input.sdk.assistantMessages[0].id = 'old-assistant'
      if (scenario === 'no-inbox') input.sdk.sdkPromptId = null
      if (scenario === 'undelivered') input.sdk.deliveredInboxIDs = []
      expect(classifyUsabilityRound(input).verdict).toBe('UNVERIFIED')
    })
  it.each(['outside-write', 'extra-file', 'wrong-text', 'wrong-reply', 'wrong-model', 'quota-error', 'shell', 'lease', 'quarantine', 'close', 'cleanup', 'identity', 'context', 'incomplete'])(
    'fails incorrect or unsafe results: %s', (scenario) => {
      const input = round()
      if (scenario === 'outside-write') input.after['../sentinel'] = 'changed'
      if (scenario === 'extra-file') input.after['extra.txt'] = 'changed'
      if (scenario === 'wrong-text') input.targetText = 'WRONG'
      if (scenario === 'wrong-reply') input.response.result = 'WRONG'
      if (scenario === 'wrong-model') input.sdk.modelVerified = false
      if (scenario === 'quota-error') input.sdk.assistantMessages[0].error = { type: 'api', status: 429 }
      if (scenario === 'shell') input.sdk.toolResults.push({ name: 'shell', status: 'error' })
      if (scenario === 'lease') input.leaseAbsent = false
      if (scenario === 'quarantine') input.quarantineAbsent = false
      if (scenario === 'close') input.clientClosed = false
      if (scenario === 'cleanup') input.cleanupVerified = false
      if (scenario === 'identity') input.sharedIdentityUnchanged = false
      if (scenario === 'context') input.response.context_id = 'other'
      if (scenario === 'incomplete') input.response.status = 'failed'
      expect(classifyUsabilityRound(input).verdict).toBe('FAIL')
    })
  it.each(['session-changed', 'memory-wrong', 'file-changed', 'previous-prompt'])(
    'checks restart continuation: %s', (scenario) => {
      const input = round('U02')
      if (scenario === 'session-changed') input.response.session_id = 'new-session'
      if (scenario === 'memory-wrong') input.response.result = 'USABILITY_CONTINUE_OK|MEM_wrong|USABILITY_EDIT_OK'
      if (scenario === 'file-changed') input.after['target.txt'] = 'changed'
      if (scenario === 'previous-prompt') input.sdk.sdkPromptId = input.previousPrompt
      expect(classifyUsabilityRound(input).verdict).toBe(scenario === 'previous-prompt' ? 'UNVERIFIED' : 'FAIL')
    })
  it('clears model override only in the child environment; controlled mode is forbidden', () => {
    const inherited = { OPENCODE_MODEL: 'some-other/model', EXAMPLE: 'unchanged' }
    const env = makeUsabilityEnvironment(join(tmpdir(), 'isolated-usability'), 'registry.json', inherited)
    expect(env.OPENCODE_MODEL).toBeUndefined()
    expect(env.OPENCODE_REUSE_ONLY).toBe('true')
    expect(env.EXAMPLE).toBe('unchanged')
    expect(inherited.OPENCODE_MODEL).toBe('some-other/model')
    expect(() => parseLiveOptions(['--controlled'], 'usability')).toThrow(/only for case3-recheck/u)
  })
})

type Scenario = 'pass' | 'no-tools' | 'bad-memory' | 'wrong-session' | 'initialize-failed' | 'close-failed' | 'unsafe-mapping' | 'identity-changed' | 'extra-prompt'
function fixture(scenario: Scenario = 'pass', startingSlots = 8) {
  const outer = mkdtempSync(join(tmpdir(), 'usability-regression-')); roots.push(outer)
  const tempRoot = join(outer, 'run'), workspaceRoot = join(tempRoot, 'workspace'), evidenceDir = join(outer, 'evidence')
  mkdirSync(workspaceRoot, { recursive: true }); mkdirSync(evidenceDir)
  const runId = `usability-${randomUUID()}`, ledgerPath = join(outer, 'budget.ndjson')
  for (let index = 0; index < startingSlots; index++) tryReserve(ledgerPath, `${ledgerPath}.lock`, { runId: 'historical', caseId: `old-${index}`, input: { task: 'old' } })
  const beforeLedger = readFileSync(ledgerPath)
  const manifest = { runId, tempRoot, workspaceRoot, contextDatabasePath: join(tempRoot, 'contexts.sqlite'), sharedRegistryPath: join(outer, 'registry.json'),
    localRootOwnership: { createdBy: 'acceptance-preflight', runId, tempRoot }, contextIds: {}, readiness: 'ready' }
  writeFileSync(join(evidenceDir, 'manifest.json'), JSON.stringify(manifest))
  const queued: any[] = [{ type: 'server.connected', data: {} }]
  let wake = () => {}, memory = '', state: any = { context: null, lease: null, quarantine: null }
  const requests: any[] = [], operations: string[] = [], envs: NodeJS.ProcessEnv[] = [], messages: any[] = [], pages: any[] = []
  const api = {
    event: { subscribe: async function* ({ signal }: { signal: AbortSignal }) {
      signal.addEventListener('abort', () => wake(), { once: true })
      while (!signal.aborted) { if (queued.length) yield queued.shift(); else await new Promise<void>((done) => { wake = done }) }
    } },
    session: { wait: vi.fn(async () => {}), get: async () => ({ model, permissions: [{ action: '*', resource: '*', effect: 'deny' }] }) },
    message: { list: async (args: any) => {
      pages.push(args)
      const offset = args.cursor ? Number(args.cursor) : 0
      const data = messages.slice(offset, offset + 2)
      return { data, cursor: { next: offset + 2 < messages.length ? String(offset + 2) : null } }
    } },
  }
  const manager = { assertIdentity: vi.fn(async () => {
    if (scenario === 'identity-changed' && operations.includes('start:usability-U02')) throw new Error('identity changed')
  }), close: vi.fn(async () => {}) }
  const prepare = vi.fn(async () => ({ repoRoot: process.cwd(), evidenceDir, manifest, ledgerPath, manager, api,
    identity: { id: 'shared-instance', pid: 12345, url: 'http://127.0.0.1:4444', version: '2.0.18' } }))
  const dependencies: UsabilityDependencies = {
    prepare: prepare as unknown as UsabilityDependencies['prepare'],
    createClient: (name, _repo, env) => {
      envs.push(env)
      const client = { diagnostics: [] as Record<string, unknown>[], requestId: 2, pid: envs.length, exited: false, exitCode: null as number | null,
        start: async () => { operations.push(`start:${name}`); if (scenario === 'initialize-failed') throw new Error('initialize') },
        cancel: () => {},
        close: async () => { operations.push(`close:${name}`); client.exited = true; client.exitCode = scenario === 'close-failed' ? 1 : 0 },
        callTool: async (request: any) => {
          requests.push(request); operations.push(`submit:${name}`)
          const first = requests.length === 1, prompt = `inbox-${requests.length}`, sessionID = scenario === 'wrong-session' && !first ? 'different-session' : 'shared-test-session'
          if (first) { memory = request.task.match(/MEM_[a-f0-9]+/u)![0]; writeFileSync(join(workspaceRoot, 'target.txt'), 'USABILITY_EDIT_OK\n') }
          const toolNames = first ? ['read', 'edit', 'read'] : ['read']
          const assistants = toolNames.map((tool, index) => ({ id: `${prompt}-step${index}`, type: 'assistant', model, cost: 0.00001,
            content: scenario === 'no-tools' ? [] : [{ type: 'tool', id: `${prompt}-tool${index}`, name: tool, state: { status: 'completed', input: { filePath: join(workspaceRoot, 'target.txt') } } }] }))
          const final = { id: `${prompt}-final`, type: 'assistant', model, cost: 0.00001, content: [] }
          messages.unshift(final, ...assistants.toReversed(), { id: prompt, type: 'user', text: request.task })
          queued.push({ type: 'session.inbox.enqueued', data: { sessionID, inboxID: prompt, item: { payload: { text: request.task } } } },
            { type: 'session.inbox.delivered', data: { sessionID, inboxID: prompt } },
            ...[...assistants, final].map((assistant) => ({ type: 'session.step.started', data: { sessionID, assistantMessageID: assistant.id } })))
          if (scenario === 'extra-prompt') queued.push({ type: 'session.inbox.enqueued', data: { sessionID, inboxID: 'unexpected', item: { payload: { text: 'extra' } } } })
          wake(); await new Promise((done) => setImmediate(done))
          state = { context: { context_id: request.context_id, session_id: sessionID, workspace_root: workspaceRoot }, lease: null, quarantine: null }
          client.diagnostics.push({ event: 'task_cleanup_complete', correlationId: digest(request.context_id).slice(0, 16),
            cleanup: { idleVerified: true, denyAllVerified: true, leaseReleased: true, quarantined: false, errors: [] } })
          return { result: { structuredContent: { status: 'completed', context_id: request.context_id, session_id: sessionID,
            result: first ? 'USABILITY_EDIT_OK' : `USABILITY_CONTINUE_OK|${scenario === 'bad-memory' ? 'MEM_WRONG' : memory}|USABILITY_EDIT_OK` } } }
        },
      }
      return client
    },
    readContext: () => scenario === 'unsafe-mapping' && operations.includes('start:usability-U02') ? { ...state, lease: { session_id: 'pending' } } : state,
  }
  return { outer, manifest, evidenceDir, ledgerPath, beforeLedger, runId, dependencies, requests, operations, envs, prepare, manager, pages, memory: () => memory }
}

describe('usability orchestration without any model or service', () => {
  it('uses ordinary clients, omits model, closes A before B, preserves budget and cleans only its root', async () => {
    const f = fixture()
    const result = await runUsability(f.runId, undefined, f.dependencies)
    expect(result.classification.verdict).toBe('PASS')
    expect(f.requests).toHaveLength(2)
    expect(f.requests.every((request) => !('model' in request))).toBe(true)
    expect(f.envs.every((env) => env.OPENCODE_MODEL === undefined)).toBe(true)
    expect(f.requests[1].context_id).toBe(f.requests[0].context_id)
    expect(f.requests[1].task).not.toContain(f.memory())
    expect(f.operations.indexOf('close:usability-U01')).toBeLessThan(f.operations.indexOf('start:usability-U02'))
    expect(result.stages[1].response.session_id).toBe(result.stages[0].response.session_id)
    expect(f.pages.filter((page) => page.cursor).every((page) => !('order' in page))).toBe(true)
    expect(usedSlots(f.ledgerPath)).toBe(10)
    expect(readFileSync(f.ledgerPath).subarray(0, f.beforeLedger.length).equals(f.beforeLedger)).toBe(true)
    expect(rows(f.ledgerPath).filter((row) => row.type === 'RESULT')).toHaveLength(2)
    expect(existsSync(f.manifest.tempRoot)).toBe(false)
    expect(existsSync(f.ledgerPath)).toBe(true)
    expect(result.localCleanup.deleted).toBe(true)
    expect(f.manager.close).toHaveBeenCalledOnce()
    await expect(runUsability(f.runId, undefined, f.dependencies)).rejects.toThrow('usability_already_attempted')
    expect(f.requests).toHaveLength(2)
  })
  it.each(['no-tools', 'close-failed', 'initialize-failed', 'extra-prompt'] as const)('stops before U02 on %s', async (scenario) => {
    const f = fixture(scenario)
    const result = await runUsability(f.runId, undefined, f.dependencies)
    expect(result.classification.verdict).toBe(scenario === 'no-tools' ? 'UNVERIFIED' : 'FAIL')
    expect(f.requests).toHaveLength(scenario === 'initialize-failed' ? 0 : 1)
    expect(result.U02Skipped).toBe(true)
    expect(f.operations).not.toContain('start:usability-U02')
    expect(usedSlots(f.ledgerPath)).toBe(scenario === 'initialize-failed' ? 8 : scenario === 'extra-prompt' ? 10 : 9)
    expect(existsSync(f.manifest.tempRoot)).toBe(true)
    expect(readFileSync(f.ledgerPath).subarray(0, f.beforeLedger.length).equals(f.beforeLedger)).toBe(true)
  })
  it.each(['unsafe-mapping', 'identity-changed'] as const)('does not submit second prompt if restart check fails: %s', async (scenario) => {
    const f = fixture(scenario)
    const result = await runUsability(f.runId, undefined, f.dependencies)
    expect(result.classification.verdict).toBe('FAIL')
    expect(f.requests).toHaveLength(1)
    expect(usedSlots(f.ledgerPath)).toBe(9)
    expect(existsSync(f.manifest.tempRoot)).toBe(true)
  })
  it.each(['bad-memory', 'wrong-session'] as const)('counts but rejects bad continuation: %s', async (scenario) => {
    const f = fixture(scenario)
    const result = await runUsability(f.runId, undefined, f.dependencies)
    expect(result.classification.verdict).toBe('FAIL')
    expect(f.requests).toHaveLength(2)
    expect(usedSlots(f.ledgerPath)).toBe(10)
    expect(existsSync(f.manifest.tempRoot)).toBe(true)
  })
  it('requires two slots before reserving or starting any MCP', async () => {
    const f = fixture('pass', 15)
    await expect(runUsability(f.runId, undefined, f.dependencies)).rejects.toThrow('usability_requires_two_remaining_slots')
    expect(f.operations).toEqual([])
    expect(readFileSync(f.ledgerPath).equals(f.beforeLedger)).toBe(true)
    expect(existsSync(join(f.evidenceDir, 'usability-attempt.json'))).toBe(false)
  })
})
