import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ContextStore, ContextStoreError, defaultContextStorePath } from '../src/context-store.js'

const roots: string[] = []

function temporaryDirectory(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'opencode-context-store-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('local context store', () => {
  it('persists context mappings and their timestamps across store instances', () => {
    const databasePath = path.join(temporaryDirectory(), 'contexts.sqlite')
    const first = new ContextStore(databasePath)
    const created = first.create({
      contextId: 'context-1',
      sessionId: 'session-1',
      workspaceRoot: 'D:\\workspace',
    })
    first.close()

    const reopened = new ContextStore(databasePath)
    const restored = reopened.get('context-1')
    expect(restored).toMatchObject({
      contextId: 'context-1',
      sessionId: 'session-1',
      workspaceRoot: 'D:\\workspace',
      createdAt: created.createdAt,
    })
    expect(restored?.updatedAt).toBeTruthy()
    reopened.close()
  })

  it('rejects a corrupted database instead of replacing its contents', () => {
    const databasePath = path.join(temporaryDirectory(), 'contexts.sqlite')
    writeFileSync(databasePath, 'not a sqlite database')
    expect(() => new ContextStore(databasePath)).toThrow(ContextStoreError)
  })

  it('uses an explicit database path or a per-user default', () => {
    expect(defaultContextStorePath({ OPENCODE_CONTEXT_DB_PATH: '.\\state\\contexts.sqlite' }))
      .toBe(path.resolve('.\\state\\contexts.sqlite'))
    expect(defaultContextStorePath({ LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' }))
      .toBe(path.join('C:\\Users\\tester\\AppData\\Local', 'codex-subagent-opencode', 'contexts.sqlite'))
  })
})
