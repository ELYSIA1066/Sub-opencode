import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type ContextEntry = {
  contextId: string
  sessionId: string
  workspaceRoot: string
  createdAt: string
  updatedAt: string
}

export class ContextStoreError extends Error {
  constructor(message: string, options?: ErrorOptions, readonly errorCode?: string) {
    super(message, options)
    this.name = 'ContextStoreError'
  }
}

type ContextRow = {
  context_id: string
  session_id: string
  workspace_root: string
  created_at: string
  updated_at: string
}

export function defaultContextStorePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OPENCODE_CONTEXT_DB_PATH?.trim()) return path.resolve(env.OPENCODE_CONTEXT_DB_PATH.trim())
  const root = env.LOCALAPPDATA?.trim()
    || env.XDG_DATA_HOME?.trim()
    || path.join(os.homedir(), '.local', 'share')
  return path.join(root, 'codex-subagent-opencode', 'contexts.sqlite')
}

export class ContextStore {
  private readonly db: DatabaseSync
  private readonly findEntry
  private readonly insertEntry
  private readonly updateTimestamp
  private closed = false

  constructor(readonly databasePath: string) {
    let database: DatabaseSync | undefined
    try {
      if (databasePath !== ':memory:') mkdirSync(path.dirname(databasePath), { recursive: true })
      database = new DatabaseSync(databasePath)
      this.db = database
      database.exec(`
        PRAGMA busy_timeout = 20;
        CREATE TABLE IF NOT EXISTS contexts (
          context_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          workspace_root TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS context_leases (
          context_id TEXT PRIMARY KEY,
          owner_token TEXT NOT NULL,
          session_id TEXT,
          acquired_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS quarantined_sessions (
          session_id TEXT PRIMARY KEY,
          context_id TEXT NOT NULL,
          reason TEXT NOT NULL,
          quarantined_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS quarantined_contexts (
          context_id TEXT PRIMARY KEY,
          session_id TEXT,
          reason TEXT NOT NULL,
          quarantined_at TEXT NOT NULL
        ) STRICT;
      `)
      this.findEntry = database.prepare(`
        SELECT context_id, session_id, workspace_root, created_at, updated_at
        FROM contexts WHERE context_id = ?
      `)
      this.insertEntry = database.prepare(`
        INSERT INTO contexts (context_id, session_id, workspace_root, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(context_id) DO NOTHING
      `)
      this.updateTimestamp = database.prepare('UPDATE contexts SET updated_at = ? WHERE context_id = ?')
    } catch (cause) {
      database?.close()
      throw new ContextStoreError(`Unable to open the local context database at ${databasePath}.`, { cause })
    }
  }

  get(contextId: string): ContextEntry | undefined {
    try {
      const row = this.findEntry.get(contextId) as ContextRow | undefined
      if (!row) return undefined
      const updatedAt = new Date().toISOString()
      this.updateTimestamp.run(updatedAt, contextId)
      return {
        contextId: row.context_id,
        sessionId: row.session_id,
        workspaceRoot: row.workspace_root,
        createdAt: row.created_at,
        updatedAt,
      }
    } catch (cause) {
      throw new ContextStoreError('Unable to read the local context mapping.', { cause })
    }
  }

  acquireLease(contextId: string, workspaceRoot: string, ownerToken: string, deadline = Number.POSITIVE_INFINITY): ContextEntry | undefined {
    try {
      if (Date.now() >= deadline) throw new ContextStoreError('Task deadline expired before reserving the context.', undefined, 'task_timeout')
      this.db.exec('BEGIN IMMEDIATE')
      if (Date.now() >= deadline) throw new ContextStoreError('Task deadline expired while reserving the context.', undefined, 'task_timeout')
      const row = this.findEntry.get(contextId) as ContextRow | undefined
      if (row && row.workspace_root !== workspaceRoot) {
        throw new ContextStoreError('context_id is already bound to a different workspace_root.')
      }
      if (this.db.prepare('SELECT 1 FROM quarantined_contexts WHERE context_id = ?').get(contextId)) {
        throw new ContextStoreError('This context_id is persistently quarantined. Start a new context_id.', undefined, 'session_quarantined')
      }
      if (row) {
        const quarantined = this.db.prepare('SELECT 1 FROM quarantined_sessions WHERE session_id = ?').get(row.session_id)
        if (quarantined) {
          throw new ContextStoreError('This OpenCode session is persistently quarantined. Start a new context_id.', undefined, 'session_quarantined')
        }
      }
      const held = this.db.prepare('SELECT 1 FROM context_leases WHERE context_id = ?').get(contextId)
      if (held) {
        throw new ContextStoreError('Another OpenCode task owns this context_id, or a prior owner exited before safe release.', undefined, 'context_busy')
      }
      const now = new Date().toISOString()
      this.db.prepare(`INSERT INTO context_leases (context_id, owner_token, session_id, acquired_at) VALUES (?, ?, ?, ?)`)
        .run(contextId, ownerToken, row?.session_id ?? null, now)
      if (row) this.updateTimestamp.run(now, contextId)
      if (Date.now() >= deadline) throw new ContextStoreError('Task deadline expired while reserving the context.', undefined, 'task_timeout')
      this.db.exec('COMMIT')
      if (!row) return undefined
      return {
        contextId: row.context_id,
        sessionId: row.session_id,
        workspaceRoot: row.workspace_root,
        createdAt: row.created_at,
        updatedAt: now,
      }
    } catch (cause) {
      this.rollback()
      if (cause instanceof ContextStoreError) throw cause
      throw new ContextStoreError('Unable to reserve the OpenCode context in the local database.', { cause }, 'context_store_failed')
    }
  }

  bindLease(contextId: string, ownerToken: string, sessionId: string): void {
    try {
      const result = this.db.prepare('UPDATE context_leases SET session_id = ? WHERE context_id = ? AND owner_token = ?')
        .run(sessionId, contextId, ownerToken)
      if (!Number(result.changes)) throw new ContextStoreError('OpenCode context lease ownership was lost.', undefined, 'context_store_failed')
    } catch (cause) {
      if (cause instanceof ContextStoreError) throw cause
      throw new ContextStoreError('Unable to bind the OpenCode session to its context lease.', { cause }, 'context_store_failed')
    }
  }

  releaseLease(contextId: string, ownerToken: string, deadline = Number.POSITIVE_INFINITY): void {
    try {
      if (Date.now() >= deadline) throw new ContextStoreError('Cleanup deadline expired before lease release.', undefined, 'context_store_failed')
      this.db.exec('BEGIN IMMEDIATE')
      const result = this.db.prepare('DELETE FROM context_leases WHERE context_id = ? AND owner_token = ?').run(contextId, ownerToken)
      if (!Number(result.changes)) throw new ContextStoreError('OpenCode context lease ownership was lost; refusing to report success.', undefined, 'context_store_failed')
      if (Date.now() >= deadline) throw new ContextStoreError('Cleanup deadline expired while releasing the context lease.', undefined, 'context_store_failed')
      this.db.exec('COMMIT')
    } catch (cause) {
      this.rollback()
      if (cause instanceof ContextStoreError) throw cause
      throw new ContextStoreError('Unable to release the OpenCode context lease.', { cause }, 'context_store_failed')
    }
  }

  quarantineAndRelease(contextId: string, ownerToken: string, sessionId: string, reason: string, deadline = Number.POSITIVE_INFINITY): void {
    try {
      if (Date.now() >= deadline) throw new ContextStoreError('Cleanup deadline expired before quarantine persistence.', undefined, 'context_store_failed')
      this.db.exec('BEGIN IMMEDIATE')
      this.db.prepare(`INSERT INTO quarantined_sessions (session_id, context_id, reason, quarantined_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO NOTHING`)
        .run(sessionId, contextId, reason.slice(0, 500), new Date().toISOString())
      this.db.prepare(`INSERT INTO quarantined_contexts (context_id, session_id, reason, quarantined_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(context_id) DO NOTHING`)
        .run(contextId, sessionId, reason.slice(0, 500), new Date().toISOString())
      const result = this.db.prepare('DELETE FROM context_leases WHERE context_id = ? AND owner_token = ?').run(contextId, ownerToken)
      if (!Number(result.changes)) throw new ContextStoreError('OpenCode context lease ownership was lost; quarantine transaction aborted.', undefined, 'context_store_failed')
      if (Date.now() >= deadline) throw new ContextStoreError('Cleanup deadline expired while persisting quarantine.', undefined, 'context_store_failed')
      this.db.exec('COMMIT')
    } catch (cause) {
      this.rollback()
      if (cause instanceof ContextStoreError) throw cause
      throw new ContextStoreError('Unable to persist OpenCode session quarantine.', { cause }, 'context_store_failed')
    }
  }

  create(entry: Pick<ContextEntry, 'contextId' | 'sessionId' | 'workspaceRoot'>): ContextEntry {
    const now = new Date().toISOString()
    try {
      this.insertEntry.run(entry.contextId, entry.sessionId, entry.workspaceRoot, now, now)
      const stored = this.findEntry.get(entry.contextId) as ContextRow | undefined
      if (!stored) throw new Error('Mapping row was not found after insert.')
      if (stored.session_id !== entry.sessionId || stored.workspace_root !== entry.workspaceRoot) {
        throw new ContextStoreError('context_id is already mapped to another OpenCode session.')
      }
      return {
        contextId: stored.context_id,
        sessionId: stored.session_id,
        workspaceRoot: stored.workspace_root,
        createdAt: stored.created_at,
        updatedAt: stored.updated_at,
      }
    } catch (cause) {
      if (cause instanceof ContextStoreError) throw cause
      throw new ContextStoreError('Unable to persist the OpenCode context mapping.', { cause })
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  private rollback(): void {
    try { this.db.exec('ROLLBACK') } catch { /* transaction may already be closed */ }
  }
}
