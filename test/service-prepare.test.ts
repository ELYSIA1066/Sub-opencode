import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, renameSync, lstatSync, unlinkSync, linkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareService, userServiceEnvironment, PrepareError, TaskServicePreparation, staleReason, windowsPowerShellEnvironment, type PrepareOptions, type OwnedService, type ProcessSnapshot } from '../src/service-bootstrap.js'
import { installedClientVersion } from '../src/service-registry.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'prepare-regression-')); roots.push(root)
  const file = join(root, 'opencode', 'service.json'); mkdirSync(dirname(file))
  const record = { id: 'old', pid: 42, url: 'http://127.0.0.1:4545', version: '2.0.18' }
  const write = (row = record) => writeFileSync(file, JSON.stringify(row))
  const processProbe = vi.fn(async (pid: number): Promise<ProcessSnapshot> => pid === process.pid ? { state: 'alive', startedAt: 1, executable: 'C:\\node.exe' } : { state: 'dead' })
  const verify = vi.fn(async (path: string) => { const row = JSON.parse(readFileSync(path, 'utf8')); return { id: row.id, pid: row.pid, url: row.url, version: row.version, registryPath: path } })
  const owned: OwnedService = { pid: 43, url: 'http://127.0.0.1:4546', version: installedClientVersion(), password: 'test-private-value', stop: vi.fn(async () => true), detach: vi.fn() }
  const launch = vi.fn(async () => owned)
  const listeners = vi.fn(async (url: string) => url === record.url ? [42] : [43])
  const move = vi.fn(async (source: string, dest: string, expected: string) => {
    if (existsSync(dest)) throw new PrepareError('publication_conflict')
    if (sha(readFileSync(source)) !== expected) throw new PrepareError('registration_changed')
    renameSync(source, dest)
  })
  const protect = vi.fn(async () => {})
  const release = vi.fn(async (file: string, expected: string) => { if (sha(readFileSync(file)) !== expected) throw new PrepareError('lock_changed'); unlinkSync(file) })
  const options: PrepareOptions = { registryFile: file, env: {}, timeoutMs: 1000, dependencies: { verify, launch, listeners, process: processProbe, move, protect, release } }
  const unhealthy = () => {
    verify.mockImplementation(async (path) => {
      if (path === file && JSON.parse(readFileSync(path, 'utf8')).pid === 42) throw new Error('private upstream detail')
      const row = JSON.parse(readFileSync(path, 'utf8')); return { id: row.id, pid: row.pid, url: row.url, version: row.version, registryPath: path }
    })
    listeners.mockImplementation(async (url) => url === record.url ? [] : [43])
  }
  return { file, record, write, verify, launch, listeners, processProbe, move, protect, owned, options, unhealthy }
}
describe('safe shared service preparation', () => {
  it('does not reclaim dead maintenance ownership with an unconfirmed launch journal', async () => {
    const f = fixture(); writeFileSync(f.file + '.prepare.lock', JSON.stringify({ schemaVersion: 1, token: 'pending', pid: 99, startedAt: 10, executable: 'C:\\node.exe' }))
    writeFileSync(f.file + '.prepare.lock.launch-pending', JSON.stringify({ token: 'pending', serviceID: 'unpublished' }))
    await expect(prepareService(f.options)).rejects.toMatchObject({ code: 'maintenance_launch_unconfirmed' })
    expect(f.move).not.toHaveBeenCalled(); expect(f.launch).not.toHaveBeenCalled()
  })
  it('refuses a linked maintenance lock without modifying its target', async () => {
    const f = fixture(); const target = join(dirname(f.file), 'other.txt'); writeFileSync(target, 'foreign')
    linkSync(target, f.file + '.prepare.lock')
    await expect(prepareService(f.options)).rejects.toMatchObject({ code: 'maintenance_lock_unsafe' })
    expect(f.move).not.toHaveBeenCalled(); expect(f.launch).not.toHaveBeenCalled(); expect(readFileSync(target, 'utf8')).toBe('foreign')
  })
  it('reuses a verified publication while another known owner is finishing its lock', async () => {
    const f = fixture(); f.write(); writeFileSync(f.file + '.prepare.lock', JSON.stringify({ schemaVersion: 1, token: 'publisher', pid: process.pid, startedAt: 1, executable: 'C:\\node.exe' }))
    expect((await prepareService(f.options)).source).toBe('reused'); expect(f.move).not.toHaveBeenCalled(); expect(f.launch).not.toHaveBeenCalled()
    expect(existsSync(f.file + '.prepare.lock')).toBe(true)
  })
  it('removes duplicate PowerShell module path casing in Windows worker environments', () => {
    const env = windowsPowerShellEnvironment({ PSMODULEPATH: 'pwsh7', PSModulePath: 'pwsh7', SYSTEMROOT: 'C:\\Windows' })
    expect(Object.keys(env).filter((key) => key.toLowerCase() === 'psmodulepath')).toEqual(['PSModulePath'])
    expect(env.PSModulePath).toContain('WindowsPowerShell')
  })
  it('starts once, verifies before publication, redacts secrets and retains published service', async () => {
    const f = fixture(); const receipt = await prepareService(f.options)
    expect(receipt).toMatchObject({ source: 'started', startedPid: 43, promptSubmissions: 0 })
    expect(f.launch).toHaveBeenCalledOnce(); expect(f.owned.stop).not.toHaveBeenCalled(); expect(f.owned.detach).toHaveBeenCalledOnce()
    expect(f.verify.mock.calls[0][0]).toContain('.pending-'); expect(f.verify.mock.calls[1][0]).toBe(f.file)
    expect(JSON.stringify(receipt)).not.toContain('test-private-value'); expect(existsSync(f.file + '.prepare.lock')).toBe(false)
  })
  it('reuses healthy registration byte-identically', async () => {
    const f = fixture(); f.write(); const bytes = readFileSync(f.file)
    expect(await prepareService(f.options)).toMatchObject({ source: 'reused' })
    expect(f.launch).not.toHaveBeenCalled(); expect(f.move).not.toHaveBeenCalled(); expect(readFileSync(f.file)).toEqual(bytes)
  })
  it.each(['2.0.20', '2.12.123'])('reuses release %s without selecting or starting another CLI', async (version) => {
    const f = fixture(); f.write({ ...f.record, version }); const bytes = readFileSync(f.file)
    expect(await prepareService(f.options)).toMatchObject({ source: 'reused', identity: { version } })
    expect(f.launch).not.toHaveBeenCalled(); expect(f.move).not.toHaveBeenCalled()
    expect(readFileSync(f.file)).toEqual(bytes)
  })
  it('registers the version reported by the started CLI, not the previous service or SDK version', async () => {
    const f = fixture(); f.owned.version = '2.0.20'
    const result = await prepareService(f.options)
    expect(result.identity.version).toBe(f.owned.version)
    expect(JSON.parse(readFileSync(f.file, 'utf8')).version).toBe(f.owned.version)
  })
  it('refuses to publish an incompatible launched service and cleans only its own child', async () => {
    const f = fixture(); f.owned.version = `${Number(installedClientVersion().split('.')[0]) + 1}.0.0`
    await expect(prepareService(f.options)).rejects.toMatchObject({ code: 'cli_version_mismatch' })
    expect(existsSync(f.file)).toBe(false); expect(f.move).not.toHaveBeenCalled()
    expect(f.owned.stop).toHaveBeenCalledOnce()
  })
  it('rejects a service whose reported version does not match its registration', async () => {
    const f = fixture(); f.write({ ...f.record, version: '2.0.20' })
    f.verify.mockImplementation(async (path) => ({ id: f.record.id, pid: f.record.pid, url: f.record.url, version: '2.0.21', registryPath: path }))
    await expect(prepareService(f.options)).rejects.toMatchObject({ code: 'listener_identity_mismatch' })
    expect(f.launch).not.toHaveBeenCalled(); expect(f.move).not.toHaveBeenCalled()
  })
  it.each(['malformed', 'incompatible', 'unhealthy-open-code', 'unknown-pid', 'port-in-use'])('preserves %s without launching or moving', async (fault) => {
    const f = fixture(); f.write()
    if (fault === 'malformed') writeFileSync(f.file, 'broken')
    if (fault === 'incompatible') f.write({ ...f.record, version: `${Number(installedClientVersion().split('.')[0]) + 1}.0.0` })
    if (fault.includes('pid') || fault === 'unhealthy-open-code') {
      f.unhealthy(); f.processProbe.mockImplementation(async (pid) => pid === process.pid ? { state: 'alive', startedAt: 1, executable: 'C:\\node.exe' } : fault === 'unknown-pid' ? { state: 'unknown' } : { state: 'alive', startedAt: Date.now() + 10000, executable: 'C:\\opencode-cli.exe' })
    }
    if (fault === 'port-in-use') f.verify.mockRejectedValue(new Error('unhealthy'))
    const bytes = readFileSync(f.file)
    await expect(prepareService(f.options)).rejects.toThrow()
    expect(f.launch).not.toHaveBeenCalled(); expect(f.move).not.toHaveBeenCalled(); expect(readFileSync(f.file)).toEqual(bytes)
  })
  it('backs up dead PID registration with identical bytes before a single start', async () => {
    const f = fixture(); f.write(); f.unhealthy(); const bytes = readFileSync(f.file)
    const receipt = await prepareService(f.options)
    expect(receipt.recoveryReason).toBe('pid_exited'); expect(readFileSync(receipt.backupPath!)).toEqual(bytes)
    expect(f.launch).toHaveBeenCalledOnce(); expect(f.processProbe.mock.calls.filter(([pid]) => pid === 42)).toHaveLength(2)
  })
  it('recovers a proven reused Codex Node PID without sending it any signal', async () => {
    const f = fixture(); f.write(); f.unhealthy()
    f.processProbe.mockImplementation(async (pid) => ({ state: 'alive', startedAt: pid === process.pid ? 1 : lstatSync(f.file).mtimeMs + 3000, executable: 'C:\\node.exe' }))
    expect(await prepareService(f.options)).toMatchObject({ recoveryReason: 'pid_reused' })
    expect(f.owned.stop).not.toHaveBeenCalled()
  })
  it('does not guess PID reuse from just a foreign executable or timestamp', () => {
    expect(staleReason({ state: 'alive', startedAt: 1000, executable: 'C:\\node.exe' }, 1000)).toBeUndefined()
    expect(staleReason({ state: 'alive', startedAt: 10000, executable: 'C:\\unknown.exe' }, 1000)).toBeUndefined()
    expect(staleReason({ state: 'alive', startedAt: 10000, executable: 'C:\\opencode-cli.exe' }, 1000)).toBeUndefined()
  })
  it('stops recovery if process identity changes during final recheck', async () => {
    const f = fixture(); f.write(); f.unhealthy(); let calls = 0
    f.processProbe.mockImplementation(async (pid) => pid === process.pid ? { state: 'alive', startedAt: 1, executable: 'C:\\node.exe' } : ++calls === 1 ? { state: 'dead' } : { state: 'alive', startedAt: Date.now(), executable: 'C:\\opencode-cli.exe' })
    await expect(prepareService(f.options)).rejects.toMatchObject({ code: 'registration_owner_changed' })
    expect(f.launch).not.toHaveBeenCalled(); expect(f.move).not.toHaveBeenCalled()
  })
  it('preserves a new registration written during stale checking', async () => {
    const f = fixture(); f.write(); f.unhealthy()
    f.processProbe.mockImplementation(async (pid) => { if (pid !== process.pid) f.write({ ...f.record, id: 'foreign' }); return { state: 'dead' } })
    // Self owner must remain positively known.
    f.processProbe.mockImplementationOnce(async () => ({ state: 'alive', startedAt: 1, executable: 'C:\\node.exe' }))
    await expect(prepareService(f.options)).rejects.toMatchObject({ code: 'registration_changed' })
    expect(f.move).not.toHaveBeenCalled(); expect(f.launch).not.toHaveBeenCalled()
  })
  it('preserves legacy lock because ownership is unknown', async () => {
    const f = fixture(); writeFileSync(f.file + '.prepare.lock', 'old-opaque-token')
    await expect(prepareService(f.options)).rejects.toMatchObject({ code: 'maintenance_lock_unknown' })
    expect(readFileSync(f.file + '.prepare.lock', 'utf8')).toBe('old-opaque-token'); expect(f.launch).not.toHaveBeenCalled()
  })
  it.each(['dead', 'reused'] as const)('backs up a positively %s maintenance owner', async (state) => {
    const f = fixture(); writeFileSync(f.file + '.prepare.lock', JSON.stringify({ schemaVersion: 1, token: 'old', pid: 99, startedAt: 10, executable: 'C:\\node.exe' }))
    f.processProbe.mockImplementation(async (pid) => pid === process.pid ? { state: 'alive', startedAt: 1, executable: 'C:\\node.exe' } : state === 'dead' ? { state: 'dead' } : { state: 'alive', startedAt: 5000, executable: 'C:\\node.exe' })
    expect(await prepareService(f.options)).toMatchObject({ source: 'started' }); expect(f.move.mock.calls[0][0]).toBe(f.file + '.prepare.lock')
  })
  it('bounds waiting on a live maintenance owner and never steals its lock', async () => {
    const f = fixture(); f.options.timeoutMs = 25
    const bytes = JSON.stringify({ schemaVersion: 1, token: 'live', pid: process.pid, startedAt: 1, executable: 'C:\\node.exe' })
    writeFileSync(f.file + '.prepare.lock', bytes)
    await expect(prepareService(f.options)).rejects.toMatchObject({ code: 'prepare_timeout' })
    expect(readFileSync(f.file + '.prepare.lock', 'utf8')).toBe(bytes); expect(f.launch).not.toHaveBeenCalled()
  })
  it('serializes two contenders, starts only once and makes the second reuse', async () => {
    const f = fixture()
    const receipts = await Promise.all([prepareService(f.options), prepareService(f.options)])
    expect(receipts.map((r) => r.source).sort()).toEqual(['reused', 'started']); expect(f.launch).toHaveBeenCalledOnce()
  })
  it('does not overwrite external publication and stops only own unpublished child', async () => {
    const f = fixture(); f.launch.mockImplementation(async () => { f.write({ ...f.record, id: 'foreign' }); return f.owned })
    await expect(prepareService(f.options)).rejects.toMatchObject({ code: 'publication_conflict' })
    expect(JSON.parse(readFileSync(f.file, 'utf8')).id).toBe('foreign'); expect(f.owned.stop).toHaveBeenCalledOnce()
  })
  it('preserves ownership lock if own child exit cannot be confirmed', async () => {
    const f = fixture(); f.launch.mockImplementation(async () => { f.write(); return f.owned }); vi.mocked(f.owned.stop).mockResolvedValue(false)
    await expect(prepareService(f.options)).rejects.toThrow(); expect(existsSync(f.file + '.prepare.lock')).toBe(true)
  })
  it('does not publish when another instance appears at the atomic move', async () => {
    const f = fixture(); f.move.mockImplementation(async (_source, _dest) => { f.write({ ...f.record, id: 'foreign' }); throw new PrepareError('publication_conflict') })
    await expect(prepareService(f.options)).rejects.toMatchObject({ code: 'publication_conflict' })
    expect(JSON.parse(readFileSync(f.file, 'utf8')).id).toBe('foreign'); expect(f.owned.stop).toHaveBeenCalledOnce()
  })
  it('stops when maintenance token changes before publication', async () => {
    const f = fixture(); f.launch.mockImplementation(async () => { writeFileSync(f.file + '.prepare.lock', 'foreign'); return f.owned })
    await expect(prepareService(f.options)).rejects.toMatchObject({ code: 'maintenance_lock_changed' })
    expect(readFileSync(f.file + '.prepare.lock', 'utf8')).toBe('foreign'); expect(f.owned.stop).toHaveBeenCalledOnce()
  })
  it('never launches when already canceled', async () => {
    const f = fixture(); const c = new AbortController(); c.abort()
    await expect(prepareService({ ...f.options, signal: c.signal })).rejects.toThrow(); expect(f.launch).not.toHaveBeenCalled()
  })
  it('cancellation after spawn stops own child and prevents publication', async () => {
    const f = fixture(); const c = new AbortController()
    f.launch.mockImplementation(async () => { c.abort(); return f.owned })
    await expect(prepareService({ ...f.options, signal: c.signal })).rejects.toThrow()
    expect(f.owned.stop).toHaveBeenCalledOnce(); expect(existsSync(f.file)).toBe(false)
  })
  it('bounds an unresponsive launch and preserves unknown state', async () => {
    const f = fixture(); f.options.timeoutMs = 25; f.launch.mockImplementation(() => new Promise(() => {}))
    const at = Date.now(); await expect(prepareService(f.options)).rejects.toMatchObject({ code: 'prepare_timeout' })
    expect(Date.now() - at).toBeLessThan(2200); expect(f.launch).toHaveBeenCalledOnce(); expect(existsSync(f.file + '.prepare.lock')).toBe(true)
  })
  it('does not stop a service after published verification becomes uncertain', async () => {
    const f = fixture(); const normal = f.verify.getMockImplementation()!
    f.verify.mockImplementation(async (file) => { if (file === f.file) throw new Error('disconnected'); return normal(file) })
    await expect(prepareService(f.options)).rejects.toThrow(); expect(f.owned.stop).not.toHaveBeenCalled(); expect(existsSync(f.file + '.prepare.lock')).toBe(true)
  })
  it('shares preparation while keeping a surviving waiter independent of cancellation', async () => {
    const f = fixture(); const coordinator = new TaskServicePreparation(f.options); const a = new AbortController(); const b = new AbortController()
    let release!: () => void; const ready = new Promise<void>((res) => { release = res })
    f.launch.mockImplementation(async () => { await ready; return f.owned })
    const first = coordinator.prepare(Date.now() + 1000, a.signal).catch(() => 'canceled')
    const second = coordinator.prepare(Date.now() + 1000, b.signal)
    a.abort(); release()
    expect(await first).toBe('canceled'); expect((await second).source).toBe('started'); expect(f.launch).toHaveBeenCalledOnce(); expect(f.owned.stop).not.toHaveBeenCalled()
  })
  it('strips acceptance state paths without copying credentials', () => {
    const inherited = { XDG_STATE_HOME: 'isolated', XDG_DATA_HOME: 'isolated', XDG_CONFIG_HOME: 'isolated', XDG_RUNTIME_DIR: 'isolated', TEMP: 'isolated', TMP: 'isolated', TMPDIR: 'isolated', OPENCODE_SERVICE_REGISTRY_FILE: 'isolated', OTHER: 'retained' }
    const env = userServiceEnvironment(inherited)
    for (const key of ['XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR', 'TMPDIR', 'OPENCODE_SERVICE_REGISTRY_FILE']) expect(env[key]).toBeUndefined()
    expect(inherited.XDG_STATE_HOME).toBe('isolated'); expect(env.TEMP).toBe(env.TMP); expect(env.OTHER).toBe('retained')
  })
})
