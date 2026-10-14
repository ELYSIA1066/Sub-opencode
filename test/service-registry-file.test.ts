import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { windowsPowerShellEnvironment } from '../src/service-bootstrap.js'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
function fixture() { const root = mkdtempSync(join(tmpdir(), 'registry-handle-test-')); roots.push(root); return { root, source: join(root, 'source.txt'), dest: join(root, 'dest.txt') } }
async function run(args: string[]) {
  return promisify(execFile)('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', join(process.cwd(), 'src/service-registry-file.ps1'), ...args],
    { windowsHide: true, env: windowsPowerShellEnvironment(process.env), timeout: 4000 })
}
describe.skipIf(process.platform !== 'win32')('actual Windows registry file operations', () => {
  it('publishes only into an absent destination', async () => {
    const f = fixture(); writeFileSync(f.source, 'new-record')
    expect((await run(['-Source', f.source, '-Destination', f.dest, '-ExpectedSha256', sha('new-record')])).stdout).toContain('MOVED')
    expect(existsSync(f.source)).toBe(false); expect(readFileSync(f.dest, 'utf8')).toBe('new-record')
  })
  it('preserves a concurrently occupied publication destination', async () => {
    const f = fixture(); writeFileSync(f.source, 'new-record'); writeFileSync(f.dest, 'foreign-record')
    await expect(run(['-Source', f.source, '-Destination', f.dest, '-ExpectedSha256', sha('new-record')])).rejects.toThrow()
    expect(readFileSync(f.source, 'utf8')).toBe('new-record'); expect(readFileSync(f.dest, 'utf8')).toBe('foreign-record')
  })
  it('rejects stale snapshots and does not release another owner lock', async () => {
    const f = fixture(); writeFileSync(f.source, 'foreign-owner')
    await expect(run(['-Source', f.source, '-Operation', 'Release', '-ExpectedSha256', sha('our-owner')])).rejects.toThrow()
    expect(readFileSync(f.source, 'utf8')).toBe('foreign-owner')
  })
  it('protects a file and releases only its exact contents', async () => {
    const f = fixture(); writeFileSync(f.source, 'our-owner')
    expect((await run(['-Source', f.source, '-Operation', 'Protect'])).stdout).toContain('PROTECTED')
    expect((await run(['-Source', f.source, '-Operation', 'Release', '-ExpectedSha256', sha('our-owner')])).stdout).toContain('RELEASED')
    expect(existsSync(f.source)).toBe(false)
  })
})
