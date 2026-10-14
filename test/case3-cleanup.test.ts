import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanupCase3Root, type Case3CleanupRootInput } from '../tools/acceptance/case3-cleanup.js'
import { removeOwnedTree } from '../tools/cleanup/owned-tree.js'
import { strictInside } from '../tools/acceptance/runtime.js'

const SYSTEM_TEMP_ROOT = tmpdir()
const created: { path: string; parent: string }[] = []
const links: string[] = []
afterEach(() => {
  for (const link of links.splice(0)) {
    if (!strictInside(SYSTEM_TEMP_ROOT, link) || !lstatSync(link).isSymbolicLink()) throw new Error('Unverified fixture link')
    unlinkSync(link)
  }
  for (const { path, parent } of created.splice(0)) if (existsSync(path)) removeOwnedTree(path, parent)
})

function fixture(ownership: boolean, parent = SYSTEM_TEMP_ROOT) {
  const root = mkdtempSync(join(parent, 'case3-cleanup-root-'))
  const evidenceDir = mkdtempSync(join(SYSTEM_TEMP_ROOT, 'case3-cleanup-evidence-'))
  created.push({ path: root, parent }, { path: evidenceDir, parent: SYSTEM_TEMP_ROOT })
  const runId = 'cleanuprun001'
  mkdirSync(join(root, 'workspace'), { recursive: true })
  writeFileSync(join(root, 'workspace', 'sentinel.txt'), 'baseline')
  writeFileSync(join(root, 'contexts.sqlite'), 'dummy')
  const input: Case3CleanupRootInput = {
    runId,
    tempRoot: root,
    workspaceRoot: join(root, 'workspace'),
    contextDatabasePath: join(root, 'contexts.sqlite'),
    ...(ownership && { localRootOwnership: { createdBy: 'acceptance-preflight', runId, tempRoot: root } }),
  }
  return { root, evidenceDir, input }
}

describe('cleanupCase3Root', () => {
  it('deletes an owned run root on a clean PASS', () => {
    const f = fixture(true)
    const result = cleanupCase3Root(f.input, f.evidenceDir, 'PASS', true, true, true)
    expect(result.deleted).toBe(true)
    expect(existsSync(f.root)).toBe(false)
    expect(existsSync(join(f.evidenceDir, 'case3-cleanup-completion.json'))).toBe(true)
    expect(JSON.parse(readFileSync(result.intentPath!, 'utf8'))).toMatchObject({ status: 'intent', action: 'delete', root: f.root })
    expect(JSON.parse(readFileSync(result.completionPath!, 'utf8'))).toMatchObject({ status: 'completed', action: 'deleted', root: f.root })
  })

  it('retains the run root when the verdict is FAIL', () => {
    const f = fixture(true)
    const result = cleanupCase3Root(f.input, f.evidenceDir, 'FAIL', true, true, true)
    expect(result.deleted).toBe(false)
    expect(existsSync(f.root)).toBe(true)
    expect(existsSync(join(f.evidenceDir, 'case3-cleanup-retained.json'))).toBe(true)
  })

  it('retains the run root when ownership is missing or unconfirmed', () => {
    const missingOwner = fixture(false)
    const noOwner = cleanupCase3Root(missingOwner.input, missingOwner.evidenceDir, 'PASS', true, true, true)
    expect(noOwner.deleted).toBe(false)
    expect(existsSync(missingOwner.root)).toBe(true)

    const unconfirmed = fixture(true)
    const notIdentity = cleanupCase3Root(unconfirmed.input, unconfirmed.evidenceDir, 'PASS', true, false, true)
    expect(notIdentity.deleted).toBe(false)
    expect(existsSync(unconfirmed.root)).toBe(true)
  })

  it.each(['mcp-open', 'context-unsafe'])('retains the root if %s', (condition) => {
    const f = fixture(true)
    const result = cleanupCase3Root(f.input, f.evidenceDir, 'PASS', condition !== 'mcp-open', true, condition !== 'context-unsafe')
    expect(result.deleted).toBe(false)
    expect(existsSync(f.root)).toBe(true)
    expect(JSON.parse(readFileSync(result.retainedPath!, 'utf8'))).toMatchObject({ status: 'retained', verdict: 'PASS' })
  })

  it('retains a root containing a junction and preserves both trees', () => {
    const f = fixture(true), target = fixture(true)
    const link = join(f.root, 'redirect')
    symlinkSync(target.root, link, process.platform === 'win32' ? 'junction' : 'dir'); links.push(link)
    const result = cleanupCase3Root(f.input, f.evidenceDir, 'PASS', true, true, true)
    expect(result.deleted).toBe(false)
    expect(result.reason).toMatch(/symbolic link or junction/u)
    expect(existsSync(join(f.root, 'workspace/sentinel.txt'))).toBe(true)
    expect(existsSync(join(target.root, 'workspace/sentinel.txt'))).toBe(true)
  })

  it('preserves an owned fixture outside the system temporary directory', () => {
    const f = fixture(true, resolve(process.cwd()))
    const result = cleanupCase3Root(f.input, f.evidenceDir, 'PASS', true, true, true)
    expect(result.deleted).toBe(false)
    expect(result.reason).toMatch(/not strictly inside the system temp root/u)
    expect(existsSync(f.root)).toBe(true)
  })
})
