import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ContextStore, ContextStoreError } from '../src/context-store.js'

const roots: string[] = []

function fixture(): { root: string; databasePath: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'context-store-safety-'))
  roots.push(root)
  return { root, databasePath: path.join(root, 'contexts.sqlite') }
}

function expectStoreError(action: () => unknown, errorCode: string): void {
  try {
    action()
    expect.fail(`Expected ContextStoreError with code ${errorCode}`)
  } catch (error) {
    expect(error).toBeInstanceOf(ContextStoreError)
    expect((error as ContextStoreError).errorCode).toBe(errorCode)
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('context store lease and quarantine safety', () => {
  it('keeps existing context mappings compatible and intact while leasing', () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { databasePath } = fixture()
      const legacyDb = new DatabaseSync(databasePath)
      legacyDb.exec(`CREATE TABLE contexts (
        context_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        workspace_root TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT`)
      legacyDb.prepare(`INSERT INTO contexts (context_id, session_id, workspace_root, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)`)
        .run('legacy', 'session-legacy', 'D:\\workspace', '2020-01-01T00:00:00.000Z', '2020-01-02T00:00:00.000Z')
      legacyDb.close()
      const store = new ContextStore(databasePath)
      const legacyEntry = store.get('legacy')
      expect(legacyEntry).toMatchObject({ contextId: 'legacy', sessionId: 'session-legacy', workspaceRoot: 'D:\\workspace', createdAt: '2020-01-01T00:00:00.000Z' })
      const leased = store.acquireLease('legacy', 'D:\\workspace', 'owner')
      expect(leased).toMatchObject({ contextId: 'legacy', sessionId: 'session-legacy', workspaceRoot: 'D:\\workspace', createdAt: '2020-01-01T00:00:00.000Z' })
      store.bindLease('legacy', 'owner', 'session-legacy')
      store.releaseLease('legacy', 'owner')
      expect(store.get('legacy')).toMatchObject({ contextId: 'legacy', sessionId: 'session-legacy', workspaceRoot: 'D:\\workspace', createdAt: '2020-01-01T00:00:00.000Z' })
      store.close()
    }
  })

  it('serializes two store connections and a busy contender cannot release the first owner', () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { databasePath } = fixture()
      const first = new ContextStore(databasePath)
      const second = new ContextStore(databasePath)
      first.acquireLease('shared', 'workspace', 'owner-1')
      expectStoreError(() => second.acquireLease('shared', 'workspace', 'owner-2'), 'context_busy')
      expectStoreError(() => second.releaseLease('shared', 'owner-2'), 'context_store_failed')
      expectStoreError(() => second.acquireLease('shared', 'workspace', 'owner-2'), 'context_busy')
      first.releaseLease('shared', 'owner-1')
      first.close()
      second.close()
    }
  })

  it('allows leases for distinct context ids at the same time', () => {
    const { databasePath } = fixture()
    const first = new ContextStore(databasePath)
    const second = new ContextStore(databasePath)
    expect(first.acquireLease('one', 'workspace', 'owner-1')).toBeUndefined()
    expect(second.acquireLease('two', 'workspace', 'owner-2')).toBeUndefined()
    first.releaseLease('one', 'owner-1')
    second.releaseLease('two', 'owner-2')
    first.close()
    second.close()
  })

  it('rejects wrong-owner release and quarantine without affecting the rightful owner', () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { databasePath } = fixture()
      const store = new ContextStore(databasePath)
      store.acquireLease('owned', 'workspace', 'owner-1')
      expectStoreError(() => store.releaseLease('owned', 'owner-2'), 'context_store_failed')
      expectStoreError(() => store.quarantineAndRelease('owned', 'owner-2', 'session-bad', 'reason'), 'context_store_failed')
      expectStoreError(() => store.acquireLease('owned', 'workspace', 'owner-2'), 'context_busy')
      store.releaseLease('owned', 'owner-1')
      expect(store.acquireLease('owned', 'workspace', 'owner-2')).toBeUndefined()
      store.releaseLease('owned', 'owner-2')
      store.close()
    }
  })

  it('can reserve again after the legitimate owner releases', () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { databasePath } = fixture()
      const store = new ContextStore(databasePath)
      store.acquireLease('reusable', 'workspace', 'first')
      store.releaseLease('reusable', 'first')
      expect(store.acquireLease('reusable', 'workspace', 'second')).toBeUndefined()
      store.releaseLease('reusable', 'second')
      store.close()
    }
  })

  it('persists quarantine across close and reopen', () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { databasePath } = fixture()
      const initial = new ContextStore(databasePath)
      initial.create({ contextId: 'quarantined', sessionId: 'session-quarantined', workspaceRoot: 'workspace' })
      initial.acquireLease('quarantined', 'workspace', 'owner')
      initial.quarantineAndRelease('quarantined', 'owner', 'session-quarantined', 'unsafe shutdown')
      initial.close()
      const reopened = new ContextStore(databasePath)
      expectStoreError(() => reopened.acquireLease('quarantined', 'workspace', 'next'), 'session_quarantined')
      reopened.close()
    }
  })

  it('keeps an uncleanly abandoned lease busy across close and reopen', () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { databasePath } = fixture()
      const crashedOwner = new ContextStore(databasePath)
      crashedOwner.acquireLease('orphan', 'workspace', 'crashed-owner')
      crashedOwner.close()
      const reopened = new ContextStore(databasePath)
      expectStoreError(() => reopened.acquireLease('orphan', 'workspace', 'replacement'), 'context_busy')
      reopened.close()
    }
  })

  it('rolls back all reservation writes when its deadline expires inside the transaction', () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { databasePath } = fixture()
      const store = new ContextStore(databasePath)
      const created = store.create({ contextId: 'deadline', sessionId: 'session-deadline', workspaceRoot: 'workspace' })
      const clock = vi.spyOn(Date, 'now').mockReturnValueOnce(1).mockReturnValueOnce(1).mockReturnValueOnce(100)
      expectStoreError(() => store.acquireLease('deadline', 'workspace', 'late-owner', 50), 'task_timeout')
      clock.mockRestore()
      expect(store.acquireLease('deadline', 'workspace', 'new-owner')).toMatchObject({ createdAt: created.createdAt })
      store.releaseLease('deadline', 'new-owner')
      store.close()
    }
  })

  it('rolls back release and quarantine when cleanup deadlines expire inside their transactions', () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const releaseFixture = fixture()
      const releaseStore = new ContextStore(releaseFixture.databasePath)
      releaseStore.acquireLease('release-deadline', 'workspace', 'owner')
      const releaseClock = vi.spyOn(Date, 'now').mockReturnValueOnce(1).mockReturnValueOnce(100)
      expectStoreError(() => releaseStore.releaseLease('release-deadline', 'owner', 50), 'context_store_failed')
      releaseClock.mockRestore()
      expectStoreError(() => releaseStore.acquireLease('release-deadline', 'workspace', 'contender'), 'context_busy')
      releaseStore.releaseLease('release-deadline', 'owner')
      expect(releaseStore.acquireLease('release-deadline', 'workspace', 'replacement')).toBeUndefined()
      releaseStore.releaseLease('release-deadline', 'replacement')
      releaseStore.close()

      const quarantineFixture = fixture()
      const quarantineStore = new ContextStore(quarantineFixture.databasePath)
      quarantineStore.create({ contextId: 'quarantine-deadline', sessionId: 'session-deadline', workspaceRoot: 'workspace' })
      quarantineStore.acquireLease('quarantine-deadline', 'workspace', 'owner')
      const quarantineClock = vi.spyOn(Date, 'now').mockReturnValueOnce(1).mockReturnValueOnce(100)
      expectStoreError(() => quarantineStore.quarantineAndRelease('quarantine-deadline', 'owner', 'session-deadline', 'late cleanup', 50), 'context_store_failed')
      quarantineClock.mockRestore()
      expectStoreError(() => quarantineStore.acquireLease('quarantine-deadline', 'workspace', 'contender'), 'context_busy')
      quarantineStore.releaseLease('quarantine-deadline', 'owner')
      expect(quarantineStore.acquireLease('quarantine-deadline', 'workspace', 'replacement')).toMatchObject({ sessionId: 'session-deadline' })
      quarantineStore.releaseLease('quarantine-deadline', 'replacement')
      quarantineStore.close()
    }
  })

  it('bounds SQLite lock waits and preserves an existing lease after a busy release', () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { databasePath } = fixture()
      const store = new ContextStore(databasePath)
      const blocker = new DatabaseSync(databasePath)
      store.acquireLease('locked', 'workspace', 'owner')
      blocker.exec('BEGIN IMMEDIATE')
      const started = Date.now()
      expectStoreError(() => store.releaseLease('locked', 'owner'), 'context_store_failed')
      expect(Date.now() - started).toBeLessThan(1_000)
      blocker.exec('ROLLBACK')
      expectStoreError(() => store.acquireLease('locked', 'workspace', 'contender'), 'context_busy')
      store.releaseLease('locked', 'owner')
      blocker.close()
      store.close()
    }
  })
})
