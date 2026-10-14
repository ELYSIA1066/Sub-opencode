import { describe, expect, it } from 'vitest'
import type { OpenCodeEvent } from '@opencode/client'
import { controlEventStream, type ControlOptions } from '../tools/acceptance/controlled-events.js'
import { parseLiveOptions } from '../tools/acceptance/cli.js'
import { resolve } from 'node:path'
import { parseMcpDiagnostic, McpStdioClient } from '../tools/acceptance/runtime.js'

const workspace = process.cwd()
const ask = (rank: number, sessionID = 'ours', messageID = 'step') => ({ type: 'permission.asked', data: {
  id: `request-${rank}`, sessionID, action: rank === 0 ? 'shell' : 'read',
  resources: [rank === 0 ? 'write shell-marker.txt' : resolve(workspace, `seed-${rank}.txt`)], source: { type: 'tool', messageID, id: `tool-${rank}` },
} } as OpenCodeEvent)
const waitAbort = (signal: AbortSignal) => new Promise<void>((done) => { if (signal.aborted) done(); else signal.addEventListener('abort', () => done(), { once: true }) })
function setup(rows: OpenCodeEvent[], holdMs = 100) {
  const controller = new AbortController()
  const audit: Record<string, unknown>[] = []
  const options: ControlOptions = { sessionId: () => 'ours', workspace,
    seeds: [resolve(workspace, 'seed-1.txt'), resolve(workspace, 'seed-2.txt')], marker: 'shell-marker.txt',
    deadline: () => Date.now() + 1000, holdMs, audit: (row) => audit.push(row) }
  const source = (async function* () { yield* rows; await waitAbort(controller.signal) })()
  return { controller, audit, iterator: controlEventStream(source, controller.signal, options) }
}
describe('isolated control changes delivery only', () => {
  it('continuously collects all original asks, preserving raw order while delivering shell first', async () => {
    const original = [ask(1), ask(2), ask(0)]
    const f = setup(original)
    const delivered = [await f.iterator.next(), await f.iterator.next(), await f.iterator.next()].map((row) => row.value)
    expect(delivered).toEqual([original[2], original[0], original[1]])
    expect(delivered[0]).toBe(original[2])
    expect(f.audit.filter((row) => row.kind === 'raw').map((row) => row.requestID)).toEqual(['request-1', 'request-2', 'request-0'])
    expect(f.audit.some((row) => row.kind === 'barrier' && row.complete === true)).toBe(true)
    expect(JSON.stringify(f.audit)).not.toContain('write shell-marker')
    f.controller.abort(); await f.iterator.return(undefined)
  })
  it('flushes incomplete targets in original order after a bounded timeout', async () => {
    const f = setup([ask(2), ask(1)], 20); const start = Date.now()
    expect((await f.iterator.next()).value).toEqual(ask(2))
    expect((await f.iterator.next()).value).toEqual(ask(1))
    expect(Date.now() - start).toBeLessThan(300)
    expect(f.audit.find((row) => row.kind === 'barrier')).toMatchObject({ complete: false, reason: 'target_group_timeout' })
    f.controller.abort(); await f.iterator.return(undefined)
  })
  it('does not combine another session or assistant into the target batch', async () => {
    const f = setup([ask(1), ask(2, 'other'), ask(0, 'ours', 'different-step')], 20)
    expect((await f.iterator.next()).value).toEqual(ask(2, 'other'))
    expect((await f.iterator.next()).value).toEqual(ask(0, 'ours', 'different-step'))
    expect((await f.iterator.next()).value).toEqual(ask(1))
    expect(f.audit.some((row) => row.kind === 'barrier' && row.complete === true)).toBe(false)
    f.controller.abort(); await f.iterator.return(undefined)
  })
  it('does not deliver buffered asks after cancellation', async () => {
    const f = setup([ask(1)], 500)
    const next = f.iterator.next()
    setTimeout(() => f.controller.abort(), 10)
    expect(await next).toMatchObject({ done: true })
    expect(f.audit.filter((row) => row.kind === 'delivered')).toHaveLength(0)
  })
  it('does not turn raw EOF into normal completion', async () => {
    const f = setup([])
    const source = (async function* () { yield ask(1) })()
    const stream = controlEventStream(source, f.controller.signal, { sessionId: () => 'ours', workspace,
      seeds: [resolve(workspace, 'seed-1.txt'), resolve(workspace, 'seed-2.txt')], marker: 'shell-marker.txt', deadline: () => Date.now() + 1000, audit: () => {} })
    expect((await stream.next()).value).toEqual(ask(1))
    await expect(stream.next()).rejects.toThrow('controlled_raw_eof')
    f.controller.abort()
  })
  it('requires an explicit case3 CLI selection, preserving all ordinary defaults', () => {
    expect(parseLiveOptions([], 'case3-recheck')).toEqual({ controlled: false })
    expect(parseLiveOptions(['--controlled'], 'case3-recheck')).toEqual({ controlled: true })
    expect(() => parseLiveOptions(['--controlled'], 'permissions')).toThrow()
    expect(() => parseLiveOptions(['--controlled', '--controlled'], 'case3-recheck')).toThrow()
    expect(() => parseLiveOptions(['--registry-file', 'relative'], 'case3-recheck')).toThrow()
  })
  it('retains control audit lines through the actual MCP stderr reader, with redaction', () => {
    const line = JSON.stringify({ component: 'case3-control', kind: 'raw', requestID: 'request', password: 'secret' })
    expect(parseMcpDiagnostic(line)).toMatchObject({ component: 'case3-control', password: '[redacted]' })
    expect(parseMcpDiagnostic('{"component":"unrelated"}')).toBeUndefined()
    const client = new McpStdioClient('offline', process.cwd(), {})
    ;(client as unknown as { onStderr: (chunk: string) => void }).onStderr(`${line}\n`)
    expect(client.diagnostics).toHaveLength(1)
    expect(client.diagnostics[0]).toMatchObject({ kind: 'raw', requestID: 'request' })
  })
})
