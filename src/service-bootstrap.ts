import { spawn, execFile } from 'node:child_process'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, basename } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { SharedConnection, type SharedConnectionIdentity } from './shared-connection.js'
import { isRegistryRecord } from './service-registry.js'
import { awaitBefore, raceAbort } from './deadline.js'

export const SHARED_REGISTRY = join(homedir(), '.local', 'state', 'opencode', 'service.json')
export const SERVICE_CLI = join(homedir(), 'AppData', 'Roaming', 'ai.opencode.desktop', 'cli', '2.0.18', 'opencode-cli.exe')
export const SERVICE_ARGS = ['serve', '--hostname', '127.0.0.1', '--port', '0'] as const
const fileHelper = fileURLToPath(new URL('./service-registry-file.ps1', import.meta.url))
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')

export class PrepareError extends Error {
  readonly errorCode = 'service_unavailable'
  constructor(readonly code: string, readonly unresolvedLaunch = false) { super(code); this.name = 'PrepareError' }
}
export type ProcessSnapshot = { state: 'dead' | 'alive' | 'unknown'; startedAt?: number; executable?: string }
export type OwnedService = { pid: number; url: string; password: string; stop: (deadline: number) => Promise<boolean>; detach: () => void }
export type Prepared = { source: 'reused' | 'started'; identity: SharedConnectionIdentity; startedPid?: number; backupPath?: string; recoveryReason?: 'pid_exited' | 'pid_reused'; promptSubmissions: 0 }
type Operation = { deadline: number; signal: AbortSignal }
export type PrepareDependencies = {
  process: (pid: number, operation: Operation) => Promise<ProcessSnapshot>
  listeners: (url: string, operation: Operation) => Promise<number[]>
  verify: (registry: string, operation: Operation) => Promise<SharedConnectionIdentity>
  move: (source: string, destination: string, sha256: string, operation: Operation) => Promise<void>
  protect: (file: string, operation: Operation) => Promise<void>
  release: (file: string, sha256: string, operation: Operation) => Promise<void>
  launch: (env: NodeJS.ProcessEnv, operation: Operation) => Promise<OwnedService>
}
export type PrepareOptions = { registryFile: string; env: NodeJS.ProcessEnv; timeoutMs?: number; deadline?: number; signal?: AbortSignal; dependencies?: Partial<PrepareDependencies> }

export function userServiceEnvironment(inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...inherited, TEMP: join(homedir(), 'AppData', 'Local', 'Temp'), TMP: join(homedir(), 'AppData', 'Local', 'Temp') }
  for (const key of ['XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR', 'TMPDIR', 'OPENCODE_SERVICE_REGISTRY_FILE', 'OPENCODE_PTY_HANDOFF']) delete env[key]
  return env
}
function check(operation: Operation) {
  if (operation.signal.aborted) throw operation.signal.reason
  if (Date.now() >= operation.deadline) throw new PrepareError('prepare_timeout')
}
async function bounded<T>(promise: Promise<T>, operation: Operation): Promise<T> {
  check(operation)
  try { return await raceAbort(awaitBefore(promise, operation.deadline), operation.signal) }
  catch (error) { if (operation.signal.aborted) throw operation.signal.reason; if (Date.now() >= operation.deadline) throw new PrepareError('prepare_timeout'); throw error }
}
async function powershell(args: string[], operation: Operation): Promise<string> {
  check(operation)
  const env = windowsPowerShellEnvironment(process.env)
  return new Promise((res, rej) => execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', ...args],
    { windowsHide: true, env,
      signal: operation.signal, timeout: Math.max(1, operation.deadline - Date.now()), maxBuffer: 8192 },
    (error, stdout) => error ? rej(new PrepareError('os_verification_failed')) : res(stdout.trim())))
}
export function windowsPowerShellEnvironment(inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...inherited }
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key]
  const root = Object.entries(inherited).find(([key]) => key.toLowerCase() === 'systemroot')?.[1] ?? 'C:\\Windows'
  env.PSModulePath = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules')
  return env
}
export async function inspectProcess(pid: number, operation: Operation): Promise<ProcessSnapshot> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || process.platform !== 'win32') return { state: 'unknown' }
  const script = '$ErrorActionPreference="Stop"; $p=Get-CimInstance Win32_Process -Filter "ProcessId=' + pid + '"; if ($null -eq $p) { "null" } else { @{startedAt=$p.CreationDate.ToUniversalTime().ToString("o");executable=$p.ExecutablePath} | ConvertTo-Json -Compress }'
  try {
    const value = JSON.parse(await powershell(['-Command', script], operation)) as { startedAt?: string; executable?: string } | null
    if (value === null) return { state: 'dead' }
    const startedAt = Date.parse(value.startedAt ?? '')
    return Number.isFinite(startedAt) && value.executable ? { state: 'alive', startedAt, executable: value.executable } : { state: 'unknown' }
  } catch { check(operation); return { state: 'unknown' } }
}
export async function listenerPids(url: string, operation: Operation): Promise<number[]> {
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') throw new PrepareError('registration_url_invalid')
  const port = Number(parsed.port)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new PrepareError('registration_url_invalid')
  const script = '$ErrorActionPreference="Stop"; $r=@(Get-NetTCPConnection -State Listen | Where-Object LocalPort -eq ' + port + ' | Select-Object -ExpandProperty OwningProcess); ConvertTo-Json -InputObject $r -Compress'
  const output = await powershell(['-Command', script], operation)
  const result: unknown = JSON.parse(output.slice(output.lastIndexOf('\n') + 1))
  if (!Array.isArray(result) || !result.every((pid) => Number.isSafeInteger(pid) && pid > 0)) throw new PrepareError('listener_verification_failed')
  return result as number[]
}
async function moveRegistry(source: string, destination: string, sha256: string, operation: Operation) {
  await powershell(['-File', fileHelper, '-Source', source, '-Destination', destination, '-ExpectedSha256', sha256], operation)
}
async function protectFile(file: string, operation: Operation) {
  await powershell(['-File', fileHelper, '-Source', file, '-Operation', 'Protect'], operation)
}
async function releaseLock(file: string, sha256: string, operation: Operation) {
  await powershell(['-File', fileHelper, '-Source', file, '-ExpectedSha256', sha256, '-Operation', 'Release'], operation)
}
export async function listeningOwnerMatches(identity: SharedConnectionIdentity, remainingMs: number): Promise<boolean> {
  const owners = await listenerPids(identity.url, { deadline: Date.now() + remainingMs, signal: AbortSignal.timeout(remainingMs) })
  return owners.length > 0 && owners.every((pid) => pid === identity.pid)
}
async function launchOfficialCli(env: NodeJS.ProcessEnv, operation: Operation): Promise<OwnedService> {
  check(operation)
  if (!existsSync(SERVICE_CLI)) throw new PrepareError('cli_missing')
  const version = await new Promise<string>((res, rej) => execFile(SERVICE_CLI, ['--version'],
    { env, windowsHide: true, signal: operation.signal, timeout: Math.max(1, operation.deadline - Date.now()), maxBuffer: 4096 },
    (error, stdout) => error ? rej(new PrepareError('cli_version_unavailable')) : res(stdout.trim())))
  if (!/^(?:opencode v)?2\.0\.18$/u.test(version)) throw new PrepareError('cli_version_mismatch')
  check(operation)
  const password = randomBytes(32).toString('base64url')
  const childEnv: NodeJS.ProcessEnv = { ...env }
  for (const key of Object.keys(childEnv)) if (['opencode_password', 'opencode_server_password'].includes(key.toLowerCase())) delete childEnv[key]
  childEnv.OPENCODE_SERVER_PASSWORD = password
  const child = spawn(SERVICE_CLI, [...SERVICE_ARGS], { env: childEnv, cwd: homedir(), detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  let output = ''
  let url = ''
  const detach = () => { child.stdout?.destroy(); child.unref() }
  const stop = async (deadline: number) => {
    if (child.exitCode !== null || child.signalCode !== null) return true
    const done = new Promise<boolean>((res) => child.once('exit', () => res(true)))
    // ChildProcess.kill uses the held Windows process handle, never a registry PID.
    if (!child.kill()) return false
    try { return await awaitBefore(done, deadline) } catch { return false }
  }
  try {
    await bounded(new Promise<void>((res, rej) => {
      child.once('error', () => rej(new PrepareError('cli_start_failed')))
      child.once('exit', () => rej(new PrepareError('cli_exited_before_ready')))
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (part: string) => {
        output = (output + part).slice(-8192)
        const found = /server listening on (http:\/\/127\.0\.0\.1:\d+)\r?\n/u.exec(output)
        if (found) { url = found[1]; res() }
      })
    }), operation)
    if (!child.pid) throw new PrepareError('cli_pid_unknown')
    return { pid: child.pid, url, password, stop, detach }
  } catch (error) {
    // Only our own child handle may be stopped, even when readiness never arrived.
    const stopped = await stop(Date.now() + 1500); detach()
    if (!stopped) throw new PrepareError('cli_cleanup_unconfirmed', true)
    throw error instanceof PrepareError ? error : new PrepareError('cli_start_canceled')
  }
}
function readSnapshot(file: string) {
  const stats = lstatSync(file)
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) throw new PrepareError('registration_file_unsafe')
  const bytes = readFileSync(file)
  let record: unknown
  try { record = JSON.parse(bytes.toString('utf8')) } catch { throw new PrepareError('registration_invalid') }
  if (!isRegistryRecord(record) || record.version !== '2.0.18') throw new PrepareError('registration_invalid_or_incompatible')
  const parsed = new URL(record.url)
  if (parsed.hostname !== '127.0.0.1' || parsed.protocol !== 'http:' || !parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') throw new PrepareError('registration_url_invalid')
  return { bytes, record, modifiedAt: stats.mtimeMs }
}
function unchanged(file: string, bytes: Buffer) {
  if (!existsSync(file) || !readFileSync(file).equals(bytes)) throw new PrepareError('registration_changed')
}
export function staleReason(info: ProcessSnapshot, modifiedAt: number): 'pid_exited' | 'pid_reused' | undefined {
  if (info.state === 'dead') return 'pid_exited'
  // Only positively identified foreign executables qualify; an arbitrary unknown image does not.
  const foreign = ['node.exe', 'codex.exe', 'chrome.exe', 'msedge.exe', 'powershell.exe', 'pwsh.exe']
  if (info.state === 'alive' && info.startedAt !== undefined && info.startedAt >= modifiedAt + 2000
    && info.executable && foreign.includes(basename(info.executable).toLowerCase())) return 'pid_reused'
  return undefined
}
function sameProcess(a: ProcessSnapshot, b: ProcessSnapshot) { return a.state === b.state && a.startedAt === b.startedAt && a.executable === b.executable }

/** Explicit controller only. SharedConnection, SDK guards and cleanup never invoke this. */
export async function prepareService(options: PrepareOptions): Promise<Prepared> {
  const deadline = Math.min(options.deadline ?? Infinity, Date.now() + Math.min(options.timeoutMs ?? 30_000, 30_000))
  const timerController = new AbortController()
  const timer = setTimeout(() => timerController.abort(new PrepareError('prepare_timeout')), Math.max(1, deadline - Date.now()))
  const operation = { deadline, signal: options.signal ? AbortSignal.any([options.signal, timerController.signal]) : timerController.signal }
  const deps: PrepareDependencies = {
    process: inspectProcess, listeners: listenerPids, move: moveRegistry, protect: protectFile, release: releaseLock, launch: launchOfficialCli,
    verify: async (file, op) => { const c = new SharedConnection({ registryFile: file }); try { return (await bounded(c.connect(), op)).identity } finally { c.close() } },
    ...options.dependencies,
  }
  const registry = resolve(options.registryFile)
  const lock = registry + '.prepare.lock'
  const token = randomUUID()
  const serviceID = randomUUID()
  const launchJournal = lock + '.launch-' + token
  let journalBytes: Buffer | undefined
  let lockBytes: Buffer | undefined
  let owned: OwnedService | undefined
  let launching: Promise<OwnedService> | undefined
  let temporary: string | undefined
  let published = false
  let cleanupConfirmed = true
  let backupPath: string | undefined
  let recoveryReason: 'pid_exited' | 'pid_reused' | undefined
  const assertLock = () => { check(operation); if (!lockBytes || !existsSync(lock) || !readFileSync(lock).equals(lockBytes)) throw new PrepareError('maintenance_lock_changed') }
  const takeLock = async () => {
    const self = await bounded(deps.process(process.pid, operation), operation)
    if (self.state !== 'alive' || self.startedAt === undefined || !self.executable) throw new PrepareError('maintenance_owner_unknown')
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, token, pid: process.pid, startedAt: self.startedAt, executable: self.executable }))
    while (true) {
      check(operation)
      try { const fd = openSync(lock, 'wx', 0o600); try { writeFileSync(fd, bytes) } finally { closeSync(fd) }; lockBytes = bytes; await bounded(deps.protect(lock, operation), operation); return }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      // A contender may use a fully verified publication while its publisher is
      // finishing lock cleanup; reusing requires no mutation or lock ownership.
      if (existsSync(registry)) {
        const snapshot = readSnapshot(registry)
        let identity: SharedConnectionIdentity | undefined
        try { identity = await bounded(deps.verify(registry, operation), operation) } catch { check(operation) }
        if (identity) {
          unchanged(registry, snapshot.bytes)
          const owners = await bounded(deps.listeners(identity.url, operation), operation)
          if (identity.id !== snapshot.record.id || identity.pid !== snapshot.record.pid || identity.url !== snapshot.record.url || identity.version !== snapshot.record.version
            || owners.length === 0 || owners.some((pid) => pid !== identity!.pid)) throw new PrepareError('listener_identity_mismatch')
          unchanged(registry, snapshot.bytes)
          return { source: 'reused' as const, identity, promptSubmissions: 0 as const }
        }
      }
      let held: Buffer
      try {
        const st = lstatSync(lock)
        if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) throw new PrepareError('maintenance_lock_unsafe')
        held = readFileSync(lock)
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
      let row: { schemaVersion?: number; token?: string; pid?: number; startedAt?: number; executable?: string }
      try { row = JSON.parse(held.toString('utf8')) } catch { throw new PrepareError('maintenance_lock_unknown') }
      if (row.schemaVersion !== 1 || !Number.isSafeInteger(row.pid) || !row.token || !Number.isFinite(row.startedAt) || !row.executable) throw new PrepareError('maintenance_lock_unknown')
      const owner = await bounded(deps.process(row.pid!, operation), operation)
      const gone = owner.state === 'dead' || (owner.state === 'alive' && owner.startedAt !== undefined && owner.startedAt > row.startedAt! + 2000)
      if (gone) {
        const again = await bounded(deps.process(row.pid!, operation), operation)
        if (!sameProcess(owner, again)) throw new PrepareError('maintenance_owner_changed')
        const pending = lock + '.launch-' + row.token
        if (existsSync(pending)) {
          let journal: { serviceID?: string; token?: string }
          try { journal = JSON.parse(readFileSync(pending, 'utf8')) } catch { throw new PrepareError('maintenance_launch_unconfirmed') }
          if (!existsSync(registry) || journal.token !== row.token || !journal.serviceID) throw new PrepareError('maintenance_launch_unconfirmed')
          const registration = readSnapshot(registry)
          const process = await bounded(deps.process(registration.record.pid, operation), operation)
          const listeners = await bounded(deps.listeners(registration.record.url, operation), operation)
          unchanged(registry, registration.bytes)
          if (registration.record.id !== journal.serviceID || !staleReason(process, registration.modifiedAt) || listeners.length) throw new PrepareError('maintenance_launch_unconfirmed')
        }
        await bounded(deps.move(lock, lock + '.stale-' + randomUUID(), digest(held), operation), operation)
        continue
      }
      if (owner.state === 'unknown') {
        if (!existsSync(lock)) continue
        if (!readFileSync(lock).equals(held)) throw new PrepareError('maintenance_lock_changed')
        throw new PrepareError('maintenance_owner_unknown')
      }
      await bounded(new Promise((res) => setTimeout(res, 200)), operation)
    }
  }
  try {
    check(operation); mkdirSync(dirname(registry), { recursive: true })
    const reusable = await takeLock()
    if (reusable) return reusable
    if (existsSync(registry)) {
      const snapshot = readSnapshot(registry)
      let healthy: SharedConnectionIdentity | undefined
      try { healthy = await bounded(deps.verify(registry, operation), operation) } catch { check(operation) }
      unchanged(registry, snapshot.bytes)
      const owners = await bounded(deps.listeners(snapshot.record.url, operation), operation)
      if (healthy) {
        if (healthy.id !== snapshot.record.id || healthy.pid !== snapshot.record.pid || healthy.url !== snapshot.record.url || healthy.version !== snapshot.record.version || owners.length === 0 || owners.some((pid) => pid !== snapshot.record.pid)) throw new PrepareError('listener_identity_mismatch')
        unchanged(registry, snapshot.bytes)
        assertLock()
        return { source: 'reused', identity: healthy, promptSubmissions: 0 }
      }
      if (owners.length > 0) throw new PrepareError('registered_port_in_use')
      const before = await bounded(deps.process(snapshot.record.pid, operation), operation)
      recoveryReason = staleReason(before, snapshot.modifiedAt)
      if (!recoveryReason) throw new PrepareError('registration_owner_unconfirmed')
      const again = await bounded(deps.process(snapshot.record.pid, operation), operation)
      const listeners = await bounded(deps.listeners(snapshot.record.url, operation), operation)
      unchanged(registry, snapshot.bytes)
      if (lstatSync(registry).mtimeMs !== snapshot.modifiedAt || !sameProcess(before, again) || staleReason(again, snapshot.modifiedAt) !== recoveryReason || listeners.length) throw new PrepareError('registration_owner_changed')
      backupPath = registry + '.stale-' + randomUUID()
      assertLock()
      await bounded(deps.move(registry, backupPath, digest(snapshot.bytes), operation), operation)
    }
    assertLock()
    if (existsSync(registry)) throw new PrepareError('registration_changed')
    // Survives a maintenance crash before publication: owner death alone cannot
    // prove an unregistered child exited. No credentials are stored here.
    journalBytes = Buffer.from(JSON.stringify({ token, serviceID }))
    writeFileSync(launchJournal, journalBytes, { flag: 'wx', mode: 0o600 })
    await bounded(deps.protect(launchJournal, operation), operation)
    assertLock()
    launching = deps.launch(options.env, operation).then((service) => { owned = service; return service })
    owned = await bounded(launching, operation)
    check(operation)
    if (existsSync(registry)) throw new PrepareError('publication_conflict')
    temporary = registry + '.pending-' + token
    const record = { id: serviceID, pid: owned.pid, url: owned.url, version: '2.0.18', password: owned.password }
    const bytes = Buffer.from(JSON.stringify(record))
    writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 })
    await bounded(deps.protect(temporary, operation), operation)
    const verified = await bounded(deps.verify(temporary, operation), operation)
    if (verified.id !== record.id || verified.pid !== owned.pid || verified.url !== owned.url || verified.version !== record.version) throw new PrepareError('started_identity_mismatch')
    const owners = await bounded(deps.listeners(owned.url, operation), operation)
    if (owners.length === 0 || owners.some((pid) => pid !== owned!.pid)) throw new PrepareError('listener_identity_mismatch')
    unchanged(temporary, bytes); assertLock()
    await bounded(deps.move(temporary, registry, digest(bytes), operation), operation)
    published = true; temporary = undefined
    const identity = await bounded(deps.verify(registry, operation), operation)
    unchanged(registry, bytes)
    if (identity.id !== record.id || identity.pid !== record.pid || identity.url !== record.url || identity.version !== record.version) throw new PrepareError('registration_changed')
    return { source: 'started', identity, startedPid: owned.pid, ...(backupPath && { backupPath, recoveryReason }), promptSubmissions: 0 }
  } catch (error) {
    if (launching && !owned) {
      try { await awaitBefore(launching, Date.now() + 1800) } catch (launchError) { cleanupConfirmed = launchError instanceof PrepareError && !launchError.unresolvedLaunch }
    }
    if (owned && !published) {
      // If an atomic publish completed before cancellation was observed, it is shared now.
      try { published = existsSync(registry) && readSnapshot(registry).record.pid === owned.pid && readSnapshot(registry).record.url === owned.url } catch { /* preserve ambiguity */ }
      if (!published) { try { cleanupConfirmed = await owned.stop(Date.now() + 1500) } catch { cleanupConfirmed = false } }
    }
    if (published) cleanupConfirmed = false
    if (operation.signal.aborted && !(operation.signal.reason instanceof PrepareError)) throw operation.signal.reason
    throw error instanceof PrepareError ? error : new PrepareError('service_verification_failed')
  } finally {
    clearTimeout(timer)
    owned?.detach()
    if (cleanupConfirmed && journalBytes && existsSync(launchJournal) && readFileSync(launchJournal).equals(journalBytes)) unlinkSync(launchJournal)
    if (cleanupConfirmed && temporary && existsSync(temporary)) {
      // A pending credential file is ours only if it is a regular single-link file.
      const st = lstatSync(temporary)
      if (st.isFile() && !st.isSymbolicLink() && st.nlink === 1) unlinkSync(temporary)
    }
    if (cleanupConfirmed && lockBytes && existsSync(lock) && readFileSync(lock).equals(lockBytes)) {
      const releaseOperation = { deadline: Date.now() + 2000, signal: AbortSignal.timeout(2000) }
      try { await bounded(deps.release(lock, digest(lockBytes), releaseOperation), releaseOperation) }
      catch { throw new PrepareError('maintenance_lock_release_unconfirmed') }
    }
  }
}

/** Lazy, shared preparation; canceling one waiter must not cancel another live task. */
export class TaskServicePreparation {
  private active?: { controller: AbortController; promise: Promise<Prepared>; waiters: number }
  constructor(private readonly options: Omit<PrepareOptions, 'signal' | 'deadline'>) {}
  async prepare(deadline: number, signal: AbortSignal): Promise<Prepared> {
    if (signal.aborted) throw signal.reason
    if (!this.active) {
      const controller = new AbortController()
      const promise = prepareService({ ...this.options, deadline, signal: controller.signal })
      const active = { controller, promise, waiters: 0 }
      this.active = active
      void promise.finally(() => { if (this.active === active) this.active = undefined }).catch(() => undefined)
    }
    const active = this.active
    active.waiters++
    try { return await raceAbort(awaitBefore(active.promise, deadline), signal) }
    finally {
      if (--active.waiters === 0 && this.active === active) {
        active.controller.abort(new DOMException('Preparation no longer has an active task.', 'AbortError'))
        try { await awaitBefore(active.promise.catch(() => undefined), Date.now() + 2000) } catch { /* controller retains unknown state */ }
      }
    }
  }
}
