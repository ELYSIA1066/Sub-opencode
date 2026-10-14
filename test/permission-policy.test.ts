import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decidePermission, lockedPermissionRules, permissionRulesForCall, type PermissionScope } from '../src/permission-policy.js'

describe('permission policy', () => {
  let tempRoot: string
  let workspace: string
  const scope: PermissionScope = { fileAccess: 'workspace_write', shellCommands: ['npm test'] }

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'permission-policy-'))
    workspace = path.join(tempRoot, 'workspace')
    mkdirSync(workspace)
    writeFileSync(path.join(workspace, 'inside.txt'), 'content')
    writeFileSync(path.join(tempRoot, 'outside.txt'), 'secret')
  })

  afterEach(() => rmSync(tempRoot, { recursive: true, force: true }))

  it('allows reads and workspace writes only when requested', () => {
    expect(decidePermission({ action: 'edit', resource: 'new.txt' }, scope, workspace)).toBe('allow_once')
    expect(decidePermission({ action: 'read', resource: 'inside.txt' }, scope, workspace)).toBe('allow_once')
    expect(decidePermission({ action: 'edit', resource: 'inside.txt' }, { ...scope, fileAccess: 'read_only' }, workspace)).toBe('deny')
  })

  it('denies outside paths and traversal', () => {
    expect(decidePermission({ action: 'edit', resource: path.join(tempRoot, 'outside.txt') }, scope, workspace)).toBe('deny')
    expect(decidePermission({ action: 'edit', resource: '../outside.txt' }, scope, workspace)).toBe('deny')
  })

  it('denies symlinks that escape the workspace', () => {
    const link = path.join(workspace, 'escape.txt')
    try {
      symlinkSync(path.join(tempRoot, 'outside.txt'), link)
      expect(decidePermission({ action: 'edit', resource: 'escape.txt' }, scope, workspace)).toBe('deny')
    } catch (error) {
      if (process.platform === 'win32') return
      throw error
    }
  })

  it('allows only exact shell command matches', () => {
    expect(decidePermission({ action: 'shell', resource: 'npm test' }, scope, workspace)).toBe('allow_once')
    expect(decidePermission({ action: 'shell', resource: 'npm test --watch' }, scope, workspace)).toBe('deny')
    expect(decidePermission({ action: 'shell', resource: 'npm *' }, { ...scope, shellCommands: ['npm *'] }, workspace)).toBe('deny')
  })

  it('denies external directories and unknown actions', () => {
    expect(decidePermission({ action: 'external_directory', resource: path.join(tempRoot, '*') }, scope, workspace)).toBe('deny')
    expect(decidePermission({ action: 'websearch', resource: '*' }, scope, workspace)).toBe('deny')
  })

  it('creates a per-call ask policy and a deny-all cleanup policy', () => {
    expect(permissionRulesForCall(scope)).toEqual([
      { action: '*', resource: '*', effect: 'deny' },
      { action: 'read', resource: '*', effect: 'ask' },
      { action: 'edit', resource: '*', effect: 'ask' },
      { action: 'shell', resource: '*', effect: 'ask' },
    ])
    expect(lockedPermissionRules()).toEqual([{ action: '*', resource: '*', effect: 'deny' }])
  })

  it('keeps edit and shell denied when the requested scope excludes them', () => {
    expect(permissionRulesForCall({ fileAccess: 'read_only', shellCommands: [] })).toEqual([
      { action: '*', resource: '*', effect: 'deny' },
      { action: 'read', resource: '*', effect: 'ask' },
      { action: 'edit', resource: '*', effect: 'deny' },
      { action: 'shell', resource: '*', effect: 'deny' },
    ])
  })
})
