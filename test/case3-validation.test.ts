import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { validateCase3Run, type Case3Manifest, type ValidateCase3RunInput } from '../tools/acceptance/case3-recheck.js'
import { LIVE_LEDGER } from '../tools/acceptance/budget.js'
import { registryPathHash } from '../src/service-registry.js'
import type { ServiceIdentity } from '../tools/acceptance/runtime.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SYSTEM_TEMP_ROOT = tmpdir()
const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(SYSTEM_TEMP_ROOT, 'case3-validation-'))
  tempRoots.push(root)
  return root
}

function sha256(value: string): string { return createHash('sha256').update(value).digest('hex') }

// Ledger digest/count are literals: validateCase3Run compares manifest values
// against the supplied input, so this test never reads or writes the real budget
// ledger and never touches authentication material.
const LEDGER_DIGEST = 'a'.repeat(64)
const ledgerPath = resolve(repoRoot, LIVE_LEDGER)
const ledgerPathHash = sha256(ledgerPath)
const RUN_ID = 'validcase3run'

function validManifest(root: string, service: ServiceIdentity): Case3Manifest {
  return {
    sharedRegistryPath: join(root, 'service.json'),
    sharedRegistryPathHash: registryPathHash(join(root, 'service.json')),
    runId: RUN_ID,
    readiness: 'ready',
    model: 'opencode-go/deepseek-v4.1-flash',
    ledgerPath,
    ledgerPathHash,
    ledgerDigest: LEDGER_DIGEST,
    ledgerReservations: 0,
    tempRoot: root,
    workspaceRoot: join(root, 'workspace'),
    contextDatabasePath: join(root, 'contexts.sqlite'),
    sharedService: service,
    sharedServiceVersion: '2.0.18',
  }
}

function baseInput(repo: string, manifest: Case3Manifest, currentService: ServiceIdentity): ValidateCase3RunInput {
  return {
    runId: RUN_ID,
    repoRoot: repo,
    manifest,
    ledgerPath,
    ledgerDigest: LEDGER_DIGEST,
    usedSlots: 0,
    currentService,
    serviceVersion: '2.0.18',
  }
}

const fixtureService: ServiceIdentity = { id: 'shared-instance', pid: 4242, url: 'http://127.0.0.1:49374' }

describe('validateCase3Run acceptance manifest validation', () => {
  it('accepts a fresh ready run with a real temp workspace and an uncreated context DB', () => {
    const root = tempRoot()
    const manifest = validManifest(root, fixtureService)
    mkdirSync(manifest.workspaceRoot, { recursive: true })
    expect(existsSync(manifest.contextDatabasePath)).toBe(false)
    expect(existsSync(manifest.workspaceRoot)).toBe(true)
    expect(() => validateCase3Run(baseInput(repoRoot, manifest, fixtureService))).not.toThrow()
  })

  it('rejects a manifest whose model is not the fixed Go model', () => {
    const root = tempRoot()
    const manifest = validManifest(root, fixtureService)
    manifest.model = 'opencode-go/other-model'
    expect(() => validateCase3Run(baseInput(repoRoot, manifest, fixtureService))).toThrow(/CASE3_RUN_INVALID/u)
  })

  it('rejects a wrong ledger digest or a wrong reservation count', () => {
    const root = tempRoot()
    const badDigest = validManifest(root, fixtureService)
    badDigest.ledgerDigest = 'b'.repeat(64)
    expect(() => validateCase3Run(baseInput(repoRoot, badDigest, fixtureService))).toThrow(/CASE3_RUN_INVALID/u)

    const badCount = validManifest(root, fixtureService)
    badCount.ledgerReservations = 3
    expect(() => validateCase3Run(baseInput(repoRoot, badCount, fixtureService))).toThrow(/CASE3_RUN_INVALID/u)
  })

  it('rejects a shared service id that differs from the current service', () => {
    const root = tempRoot()
    const manifest = validManifest(root, fixtureService)
    const current: ServiceIdentity = { ...fixtureService, id: 'different-instance' }
    expect(() => validateCase3Run(baseInput(repoRoot, manifest, current))).toThrow(/CASE3_RUN_INVALID/u)
  })

  it('rejects an edited saved registry path before a prompt can be submitted', () => {
    const root = tempRoot()
    const manifest = validManifest(root, fixtureService)
    manifest.sharedRegistryPath = join(root, 'changed.json')
    expect(() => validateCase3Run(baseInput(repoRoot, manifest, fixtureService))).toThrow(/CASE3_RUN_INVALID/u)
  })

  it('rejects changed service PID, URL or version even when the instance ID is the same', () => {
    const root = tempRoot()
    const manifest = validManifest(root, fixtureService)
    for (const service of [{ ...fixtureService, pid: 4243 }, { ...fixtureService, url: 'http://127.0.0.1:49375' }]) {
      expect(() => validateCase3Run(baseInput(repoRoot, manifest, service))).toThrow(/CASE3_RUN_INVALID/u)
    }
    expect(() => validateCase3Run({ ...baseInput(repoRoot, manifest, fixtureService), serviceVersion: '2.0.20' })).toThrow(/CASE3_RUN_INVALID/u)
  })

  it('rejects a workspace outside the temp root or redirected through a junction', () => {
    const root = tempRoot()
    const outside = validManifest(root, fixtureService)
    outside.workspaceRoot = resolve(SYSTEM_TEMP_ROOT, '..', 'case3-outside-workspace')
    expect(() => validateCase3Run(baseInput(repoRoot, outside, fixtureService))).toThrow(/CASE3_RUN_INVALID/u)

    // A directory junction makes realpathSync(link) !== resolve(link); when the
    // platform permits creating one, validation must reject it.
    const target = tempRoot()
    const link = join(root, 'workspace')
    let junctionCreated = false
    try { symlinkSync(target, link, 'junction'); junctionCreated = true } catch { junctionCreated = false }
    if (junctionCreated && existsSync(link) && statSync(link).isDirectory() && realpathSync(link) !== resolve(link)) {
      const junction = validManifest(root, fixtureService)
      expect(() => validateCase3Run(baseInput(repoRoot, junction, fixtureService))).toThrow(/CASE3_RUN_INVALID/u)
    } else {
      expect(junctionCreated).toBe(false)
    }
  })
})

describe('acceptance CLI import safety', () => {
  it('imports the CLI module with no run mode and does not autostart, start services, or touch the live ledger', async () => {
    const ledger = resolve(repoRoot, LIVE_LEDGER)
    const digestBefore = existsSync(ledger) ? createHash('sha256').update(readFileSync(ledger)).digest('hex') : null
    const argv = process.argv
    const exitCode = process.exitCode
    // argv[1] is not cli.ts, so isMain is false and main() must not run; no mode is supplied.
    process.argv = [argv[0]!, resolve(repoRoot, 'test/import-only.ts')]
    try {
      await expect(import('../tools/acceptance/cli.js')).resolves.toBeDefined()
      expect(process.exitCode).toBe(exitCode)
    } finally {
      process.argv = argv
      process.exitCode = exitCode
    }
    const digestAfter = existsSync(ledger) ? createHash('sha256').update(readFileSync(ledger)).digest('hex') : null
    expect(digestAfter).toBe(digestBefore)
  })
})
