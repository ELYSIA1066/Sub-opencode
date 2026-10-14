/** Explicit zero-prompt maintenance acceptance; never imported by MCP or live acceptance. */
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Service } from '@opencode/client/service'
import { SharedConnection, type SharedConnectionIdentity } from '../src/shared-connection.js'
import { prepareService, listeningOwnerMatches } from './service-prepare.js'
import { makeIsolatedEnvironment, McpStdioClient, pidIsAlive, strictInside } from './acceptance/runtime.js'
import { LIVE_LEDGER } from './acceptance/budget.js'
import { removeOwnedTree } from './cleanup/owned-tree.js'

const here = fileURLToPath(import.meta.url)
const repo = resolve(fileURLToPath(new URL('..', import.meta.url)))
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
function digest(file: string) { return createHash('sha256').update(readFileSync(file)).digest('hex') }
async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('check_timeout')), ms) })]).finally(() => clearTimeout(timer!))
}
function worker(registry: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; receipt: any }> {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, ['--import', 'tsx', here, 'child', registry], { cwd: repo, env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    let text = ''
    child.stdout.setEncoding('utf8'); child.stdout.on('data', (data) => { text += data })
    child.once('error', () => rej(new Error('worker_start_failed')))
    child.once('exit', (code) => { try { res({ code, receipt: JSON.parse(text.trim()) }) } catch { rej(new Error('worker_receipt_missing')) } })
  })
}
async function main() {
  if (process.argv[2] === 'child') {
    const registry = resolve(process.argv[3]!)
    assert(strictInside(join(homedir(), 'AppData/Local/Temp'), registry)
      && registry === resolve(process.env.XDG_STATE_HOME!, 'opencode/service.json'), 'test_registry_outside_temp')
    try {
      console.log(JSON.stringify(await prepareService({ registryFile: registry, env: process.env })))
    } catch (error) { console.log(JSON.stringify({ code: error instanceof Error ? error.message : 'failed' })); process.exitCode = 1 }
    return
  }
  assert(process.argv.length === 2, 'check_arguments_not_allowed')
  const ledger = resolve(repo, LIVE_LEDGER)
  const ledgerBefore = digest(ledger)
  const root = mkdtempSync(join(tmpdir(), 'service-prepare-check-'))
  const evidenceDir = resolve(repo, 'work/service-discovery', `${new Date().toISOString().replaceAll(':', '').replaceAll('.', '-')}-${randomUUID().slice(0, 8)}`)
  mkdirSync(evidenceDir, { recursive: true })
  const env = makeIsolatedEnvironment(root)
  for (const key of ['XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR', 'TEMP']) mkdirSync(env[key]!, { recursive: true })
  const registry = join(env.XDG_STATE_HOME!, 'opencode/service.json')
  const evidence: Record<string, any> = { capturedAt: new Date().toISOString(), promptSubmissions: 0, root, registry, ledgerBefore, passed: false, cleanup: { serviceStopAttempted: false, rootRemoved: false } }
  let owned: SharedConnectionIdentity | undefined
  let snapshot: Buffer | undefined
  try {
    const results = await within(Promise.all([worker(registry, env), worker(registry, env)]), 35_000)
    evidence.concurrentWorkers = results
    const winner = results.find((r) => r.code === 0 && r.receipt.source === 'started')
    assert(winner, 'no_verified_owned_service')
    owned = winner.receipt.identity
    assert(owned && owned.pid === winner.receipt.startedPid, 'started_identity_mismatch')
    snapshot = readFileSync(registry)
    assert(results.every((r) => r.code === 0) && results.filter((r) => r.receipt.source === 'started').length === 1
      && results.some((r) => r.receipt.source === 'reused'), 'competition_not_serialized')
    assert(pidIsAlive(owned.pid) === true && await listeningOwnerMatches(owned, 5000), 'service_died_after_maintenance_exit')
    evidence.survivedMaintenanceExit = true
    const reuse = await within(worker(registry, env), 30_000)
    evidence.healthyReuse = reuse
    assert(reuse.code === 0 && reuse.receipt.source === 'reused' && reuse.receipt.identity.id === owned.id && readFileSync(registry).equals(snapshot), 'healthy_reuse_failed')
    // A fresh MCP reads the explicit test registration. Initialize/close sends no model prompt.
    const mcp = new McpStdioClient('prepare-zero', repo, { ...env, OPENCODE_SERVICE_REGISTRY_FILE: registry, OPENCODE_REUSE_ONLY: 'true' })
    await mcp.start(); await mcp.close()
    assert(mcp.exited && mcp.exitCode === 0 && pidIsAlive(owned.pid) === true && readFileSync(registry).equals(snapshot), 'mcp_stopped_shared_service')
    evidence.mcpClose = { exited: mcp.exited, exitCode: mcp.exitCode, sharedServiceKeptRunning: true }
    evidence.passed = true
  } catch (error) { evidence.failure = error instanceof Error ? error.message : 'check_failed' }
  finally {
    // Stop only this check's newly created test service, never any shared/user service.
    if (owned && snapshot && existsSync(registry) && readFileSync(registry).equals(snapshot) && pidIsAlive(owned.pid) === true) {
      const connection = new SharedConnection({ registryFile: registry })
      try {
        const verified = await within(connection.connect(), 5000)
        assert(verified.identity.id === owned.id && verified.identity.pid === owned.pid && readFileSync(registry).equals(snapshot), 'cleanup_identity_changed')
        evidence.cleanup.serviceStopAttempted = true
        await within(Service.stop({ file: registry, pty: 'clear' }), 10_000)
        const until = Date.now() + 5000
        while (pidIsAlive(owned.pid) === true && Date.now() < until) await new Promise((res) => setTimeout(res, 100))
        evidence.cleanup.pidExited = pidIsAlive(owned.pid) === false
        if (evidence.cleanup.pidExited && strictInside(tmpdir(), root)) {
          const removalDeadline = Date.now() + 5000
          while (true) {
            try { removeOwnedTree(root, tmpdir()); evidence.cleanup.rootRemoved = true; break }
            catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'EPERM' || Date.now() >= removalDeadline) throw error
              await new Promise((res) => setTimeout(res, 200))
            }
          }
        }
      } catch (error) { evidence.cleanup.error = error instanceof Error ? error.message : 'cleanup_failed'; evidence.passed = false }
      finally { connection.close() }
    }
    evidence.ledgerAfter = digest(ledger)
    evidence.ledgerUnchanged = evidence.ledgerBefore === evidence.ledgerAfter
    evidence.passed = evidence.passed && evidence.ledgerUnchanged && evidence.cleanup.rootRemoved
    writeFileSync(join(evidenceDir, 'isolated-cli.json'), JSON.stringify(evidence, null, 2), { flag: 'wx' })
    console.log(JSON.stringify({ passed: evidence.passed, promptSubmissions: 0, evidencePath: join(evidenceDir, 'isolated-cli.json'), cleanup: evidence.cleanup }))
    if (!evidence.passed) process.exitCode = 1
  }
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(here)) main().catch((error) => { console.error(error instanceof Error ? error.message : 'check_failed'); process.exitCode = 1 })
