import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, lstatSync, type Stats } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { sanitize } from './budget.js'

export const SYSTEM_TEMP_ROOT = tmpdir()
export const PINNED_CLI = 'C:\\Users\\10638\\AppData\\Roaming\\ai.opencode.desktop\\cli\\2.0.18\\opencode-cli.exe'
export const PINNED_MODEL = 'opencode-go/deepseek-v4.1-flash'

export function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }

export function strictInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate))
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

export function makeIsolatedEnvironment(root: string, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const state = resolve(root, 'xdg-state')
  const data = resolve(root, 'xdg-data')
  const config = resolve(root, 'xdg-config')
  const runtime = resolve(root, 'xdg-runtime')
  const privateTemp = resolve(root, 'os-temp')
  for (const value of [state, data, config, runtime, privateTemp]) assert(strictInside(root, value), 'XDG/temp isolation path escaped the private run root.')
  return { ...inherited, XDG_STATE_HOME: state, XDG_DATA_HOME: data, XDG_CONFIG_HOME: config, XDG_RUNTIME_DIR: runtime,
    TEMP: privateTemp, TMP: privateTemp, TMPDIR: privateTemp, OPENCODE_COMMAND: PINNED_CLI, OPENCODE_MODEL: PINNED_MODEL,
    OPENCODE_CONTEXT_DB_PATH: resolve(root, 'contexts.sqlite'), OPENCODE_HOST: '127.0.0.1', OPENCODE_AUTO_PREPARE: 'false' }
}

export interface ServiceIdentity { id: string; pid: number; url: string }
export function readIdentity(file: string): ServiceIdentity | undefined {
  try {
    const row = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    if (typeof row.id !== 'string' || typeof row.url !== 'string' || !Number.isSafeInteger(row.pid)) return undefined
    return { id: row.id, pid: row.pid as number, url: row.url }
  } catch { return undefined }
}

export function pidIsAlive(pid: number): boolean | null {
  try { process.kill(pid, 0); return true } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ESRCH' ? false : null
  }
}

export function readContextState(databasePath: string, contextId: string) {
  if (!existsSync(databasePath)) throw new Error(`Context database is missing: ${databasePath}`)
  const db = new DatabaseSync(databasePath, { readOnly: true })
  try {
    db.exec('PRAGMA busy_timeout = 1000')
    const context = db.prepare('SELECT context_id, session_id, workspace_root FROM contexts WHERE context_id = ?').get(contextId) ?? null
    const lease = db.prepare('SELECT session_id FROM context_leases WHERE context_id = ?').get(contextId) ?? null
    const quarantine = db.prepare('SELECT session_id, reason FROM quarantined_contexts WHERE context_id = ?').get(contextId) ?? null
    return { context, lease, quarantine }
  } finally { db.close() }
}

function sha256(data: Buffer): string { return createHash('sha256').update(data).digest('hex') }
export function hashTree(root: string, getInfo: (path: string) => Stats = (path) => lstatSync(path, { throwIfNoEntry: true })): Record<string, string> {
  const out: Record<string, string> = {}
  const rootInfo = getInfo(root)
  assert(!rootInfo.isSymbolicLink() && rootInfo.isDirectory(), 'Workspace root must be a real directory, not a symbolic link or junction.')
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const absolute = join(dir, name)
      const stat = getInfo(absolute)
      assert(!stat.isSymbolicLink(), `Workspace contains a symbolic link and cannot be safely hashed: ${absolute}`)
      if (stat.isDirectory()) walk(absolute)
      else out[relative(root, absolute).replaceAll('\\', '/')] = sha256(readFileSync(absolute))
    }
  }
  walk(root)
  return out
}

export function parseMcpDiagnostic(line: string): Record<string, unknown> | undefined {
  let parsed: unknown
  try { parsed = JSON.parse(line) } catch { return undefined }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  if (!['opencode-delegator', 'case3-control'].includes(String((parsed as { component?: unknown }).component))) return undefined
  return sanitize(parsed) as Record<string, unknown>
}

export class McpStdioClient {
  readonly diagnostics: Record<string, unknown>[] = []
  readonly diagnosticCaptureErrors: string[] = []
  private nextId = 1
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
  private buffer = ''
  private stderrBuffer = ''
  private pipesClosed = false
  private child?: ReturnType<typeof spawn>

  constructor(readonly name: string, private readonly repo: string, private readonly env: NodeJS.ProcessEnv,
    private readonly executable?: { entrypoint: string; args: string[] }) {}

  get pid(): number | undefined { return this.child?.pid }
  // A child is gone on either a numeric exit or a terminating signal. Killed
  // children keep exitCode === null so callers still see a non-clean result.
  get exited(): boolean { return !this.child || this.child.exitCode !== null || this.child.signalCode !== null }
  get exitCode(): number | null { return this.child?.exitCode ?? null }

  async start(): Promise<void> {
    this.child = spawn(process.execPath, ['--import', 'tsx', this.executable?.entrypoint ?? 'src/mcp.ts', ...(this.executable?.args ?? [])], { cwd: this.repo, env: this.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stdout?.setEncoding('utf8')
    this.child.stdout?.on('data', (chunk: string) => this.onData(chunk))
    this.child.stderr?.setEncoding('utf8')
    this.child.stderr?.on('data', (chunk: string) => this.onStderr(chunk))
    this.child.stderr?.on('end', () => this.flushStderr())
    this.child.on('close', () => { this.flushStderr(); this.pipesClosed = true })
    this.child.on('exit', (code, signal) => this.rejectAll(new Error(`MCP ${this.name} disconnected (${signal ?? code}).`)))
    const init = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: `go-acceptance-${this.name}`, version: '1.0.0' } })
    if (init.error) throw new Error(`MCP initialize failed for ${this.name}.`)
    this.notify('notifications/initialized')
  }

  get requestId(): number { return this.nextId }
  callTool(args: unknown, timeoutMs = 150_000): Promise<any> { return this.request('tools/call', { name: 'delegate_to_opencode', arguments: args }, timeoutMs) }
  cancel(requestId: number, reason = 'Canceled by acceptance harness'): void { this.notify('notifications/cancelled', { requestId, reason }) }

  request(method: string, params: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<any> {
    if (!this.child || this.child.exitCode !== null) return Promise.reject(new Error(`MCP ${this.name} is not running.`))
    const id = this.nextId++
    return new Promise((resolveResult, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Timed out waiting for ${method} from ${this.name}.`)) }, timeoutMs)
      this.pending.set(id, { resolve: resolveResult, reject, timer })
      this.child!.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    if (!this.child || this.child.exitCode !== null) throw new Error(`MCP ${this.name} is not running.`)
    this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    while (this.buffer.includes('\n')) {
      const index = this.buffer.indexOf('\n')
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      if (!line.trim()) continue
      let message: any
      try { message = JSON.parse(line) } catch { continue }
      const pending = this.pending.get(message.id)
      if (!pending) continue
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      pending.resolve(message)
    }
  }

  private onStderr(chunk: string): void {
    this.stderrBuffer += chunk
    while (this.stderrBuffer.includes('\n')) {
      const index = this.stderrBuffer.indexOf('\n')
      const line = this.stderrBuffer.slice(0, index).trim()
      this.stderrBuffer = this.stderrBuffer.slice(index + 1)
      if (!line) continue
      const parsed = parseMcpDiagnostic(line)
      if (parsed) this.diagnostics.push(parsed)
      else if (line.includes('case3-control')) this.diagnosticCaptureErrors.push('invalid_control_diagnostic')
    }
  }

  private flushStderr(): void {
    const line = this.stderrBuffer.trim()
    this.stderrBuffer = ''
    if (!line) return
    const parsed = parseMcpDiagnostic(line)
    if (parsed) this.diagnostics.push(parsed)
    else if (line.includes('case3-control')) this.diagnosticCaptureErrors.push('truncated_control_diagnostic')
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
  }

  // Event-driven wait: resolves on the child's exit event or after `ms` as an
  // upper bound. The timer is always cleared and unref'd so shutdown never
  // busy-waits or keeps the process alive past the deadline.
  private waitForExit(ms: number): Promise<void> {
    if (this.exited) return Promise.resolve()
    const child = this.child!
    return new Promise<void>((resolveWait) => {
      let timer: NodeJS.Timeout | undefined
      const onExit = (): void => { if (timer) clearTimeout(timer); resolveWait() }
      timer = setTimeout(() => { child.removeListener('exit', onExit); resolveWait() }, ms)
      timer.unref?.()
      child.once('exit', onExit)
    })
  }

  async close(): Promise<void> {
    const child = this.child
    if (!child || this.pipesClosed) return
    // Single total 11s shutdown: let the CLI finish its 10s graceful exit
    // (10.2s to absorb scheduling), then kill only our own child and spend at
    // most the 0.8s remainder waiting for it.
    const deadline = Date.now() + 11_000
    if (!this.exited) { child.stdin!.end(); await this.waitForExit(10_200) }
    if (!this.exited) {
      child.kill()
      const remaining = Math.min(deadline - Date.now(), 800)
      if (remaining > 0) await this.waitForExit(remaining)
    }
    if (!this.exited) throw new Error(`MCP child ${this.name} did not stop within the shutdown deadline.`)
    // exit precedes close: stdout/stderr may still contain the final audit. Drain
    // within the same total deadline, rather than classifying a partial receipt.
    if (!this.pipesClosed) await new Promise<void>((done) => {
      const onClose = () => { clearTimeout(timer); done() }
      const timer = setTimeout(() => { child.removeListener('close', onClose); done() }, Math.max(0, deadline - Date.now()))
      timer.unref?.()
      child.once('close', onClose)
    })
    if (!this.pipesClosed) {
      this.diagnosticCaptureErrors.push('diagnostic_stream_not_closed')
      throw new Error(`MCP child ${this.name} audit did not drain within the shutdown deadline.`)
    }
  }
}

export function createPrivateWorkspace(root: string, name: string): string {
  const workspace = resolve(root, 'workspace', name)
  assert(strictInside(resolve(root, 'workspace'), workspace), 'Workspace path escaped its isolated workspace root.')
  const firstCreation = !existsSync(workspace)
  mkdirSync(workspace, { recursive: true })
  if (firstCreation) {
    writeFileSync(join(workspace, 'marker.txt'), `marker:${name}\n`, 'utf8')
    writeFileSync(join(workspace, 'sentinel.txt'), `baseline:${name}\n`, 'utf8')
  }
  return workspace
}
