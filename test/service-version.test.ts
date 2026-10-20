import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { installedClientVersion, isCompatibleServiceVersion } from '../src/service-registry.js'
import { selectServiceCli } from '../src/service-bootstrap.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('derives compatibility from SDK metadata rather than a fixed service release or major', () => {
  expect(isCompatibleServiceVersion(installedClientVersion())).toBe(true)
  expect(isCompatibleServiceVersion('8.12.123', '8.0.1')).toBe(true)
  expect(isCompatibleServiceVersion('9.0.0', '8.0.1')).toBe(false)
  expect(isCompatibleServiceVersion('7.99.99', '8.0.1')).toBe(false)
})

it.each(['2', 'v2.0.20', '2.0.20-beta.1', '2.0.20+custom', '02.0.20', '2.0.20/path', '2.0.20\n', '9007199254740992.0.0'])(
  'rejects malformed or non-stable release %j', (version) => {
    expect(isCompatibleServiceVersion(version)).toBe(false)
  },
)

it('selects the newest compatible installed executable using numeric release ordering', () => {
  const root = mkdtempSync(join(tmpdir(), 'cli-selection-')); roots.push(root)
  const major = Number(installedClientVersion().split('.')[0])
  for (const version of [`${major}.0.9`, `${major}.0.20`, `${major}.10.1`, `${major + 1}.0.0`, `${major}.99.0-beta.1`, `${major}.100.0`]) {
    const directory = join(root, version); mkdirSync(directory)
    if (version !== `${major}.100.0`) writeFileSync(join(directory, 'opencode-cli.exe'), 'selection fixture only')
  }
  expect(selectServiceCli(root)).toEqual({ file: join(root, `${major}.10.1`, 'opencode-cli.exe'), version: `${major}.10.1` })
})

it('fails closed when the installed CLI directory has no compatible executable', () => {
  const root = mkdtempSync(join(tmpdir(), 'cli-missing-')); roots.push(root)
  const nextMajor = Number(installedClientVersion().split('.')[0]) + 1
  mkdirSync(join(root, `${nextMajor}.0.0`)); writeFileSync(join(root, `${nextMajor}.0.0`, 'opencode-cli.exe'), 'not compatible')
  expect(() => selectServiceCli(root)).toThrow('cli_missing_or_incompatible')
  expect(() => selectServiceCli(join(root, 'missing'))).toThrow('cli_missing')
})
