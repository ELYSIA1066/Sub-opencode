import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { SYSTEM_TEMP_ROOT, strictInside } from './runtime.js'
import { removeOwnedTree } from '../cleanup/owned-tree.js'

// Case 3 run-root cleanup: an independent, fail-closed helper.
//
// This module intentionally has no dependency on tools/acceptance/cli.ts. It
// never touches the shared service registry or any service process. A run root
// is only removed when every ownership, path, identity and cleanliness guard
// below is positively confirmed; any uncertainty keeps the root and leaves an
// audit receipt behind. A failed deletion or receipt write throws so a caller
// can never mistake a retained root for a completed cleanup.

export const CASE3_CLEANUP_OWNER = 'acceptance-preflight'
export const CASE3_CLEANUP_INTENT_FILE = 'case3-cleanup-intent.json'
export const CASE3_CLEANUP_COMPLETION_FILE = 'case3-cleanup-completion.json'
export const CASE3_CLEANUP_RETAINED_FILE = 'case3-cleanup-retained.json'

export interface Case3CleanupOwnership {
  createdBy: string
  runId: string
  tempRoot: string
}

// The subset of the run manifest this helper needs. No new manifest schema.
export interface Case3CleanupRootInput {
  runId: string
  tempRoot: string
  workspaceRoot: string
  contextDatabasePath: string
  localRootOwnership?: Case3CleanupOwnership
}

export interface Case3CleanupResult {
  deleted: boolean
  reason: string
  root: string | null
  intentPath?: string
  completionPath?: string
  retainedPath?: string
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError'
}

function retentionReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Write an immutable (`wx`) receipt outside the run root. Never overwrites. */
function writeReceipt(evidenceDir: string, file: string, record: Record<string, unknown>): string {
  mkdirSync(evidenceDir, { recursive: true })
  const path = join(evidenceDir, file)
  writeFileSync(path, JSON.stringify(record, null, 2), { encoding: 'utf8', flag: 'wx' })
  return path
}

/**
 * Recursively reject symbolic links and junctions (Windows reparse points are
 * reported as symlinks by lstat). The root itself must be a real directory.
 */
function assertRealTree(root: string): void {
  const rootInfo = lstatSync(root)
  if (rootInfo.isSymbolicLink()) throw new Error('run root is a symbolic link or junction')
  if (!rootInfo.isDirectory()) throw new Error('run root is not a directory')
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const absolute = join(dir, name)
      const info = lstatSync(absolute)
      if (info.isSymbolicLink()) throw new Error(`run root contains a symbolic link or junction: ${absolute}`)
      if (info.isDirectory()) walk(absolute)
    }
  }
  walk(root)
}

/**
 * Delete an owned Case 3 run root, or retain it with an audit receipt.
 *
 * Deletion requires ALL of:
 *   - `verdict` is `'PASS'` or `'UNVERIFIED'`
 *   - `mcpClosed`, `identityConfirmed` and `contextClean` are all `true`
 *   - `localRootOwnership.createdBy === 'acceptance-preflight'` with matching
 *     `runId` and `tempRoot`
 *   - the declared root resolves and realpaths to the same absolute path
 *   - the root is strictly inside the actual `SYSTEM_TEMP_ROOT`
 *   - `workspaceRoot` and `contextDatabasePath` are the exact descendants
 *     `<root>/workspace` and `<root>/contexts.sqlite`
 *   - no symlink/junction exists anywhere in the root tree
 *
 * Any condition that is unmet or cannot be determined retains the root. Receipt
 * writes and the removal itself are fail-closed: if they fail, the error is
 * thrown so the caller cannot report a false PASS.
 */
export function cleanupCase3Root(
  input: Case3CleanupRootInput,
  evidenceDir: string,
  verdict: string,
  mcpClosed: boolean,
  identityConfirmed: boolean,
  contextClean: boolean,
): Case3CleanupResult {
  const root = typeof input?.tempRoot === 'string' && isAbsolute(input.tempRoot) ? resolve(input.tempRoot) : null

  const retain = (reason: string): Case3CleanupResult => {
    const record = {
      status: 'retained',
      action: 'none',
      reason,
      runId: typeof input?.runId === 'string' ? input.runId : null,
      declaredRoot: typeof input?.tempRoot === 'string' ? input.tempRoot : null,
      resolvedRoot: root,
      verdict,
      mcpClosed,
      identityConfirmed,
      contextClean,
      decidedAt: new Date().toISOString(),
    }
    const retainedPath = writeReceipt(evidenceDir, CASE3_CLEANUP_RETAINED_FILE, record)
    return { deleted: false, reason, root, retainedPath }
  }

  if (typeof input?.runId !== 'string' || input.runId.length === 0) return retain('manifest runId is missing')
  if (root === null) return retain('manifest tempRoot is not an absolute path')
  if (typeof input.workspaceRoot !== 'string' || !isAbsolute(input.workspaceRoot)) return retain('manifest workspaceRoot is not an absolute path')
  if (typeof input.contextDatabasePath !== 'string' || !isAbsolute(input.contextDatabasePath)) return retain('manifest contextDatabasePath is not an absolute path')

  if (typeof verdict !== 'string' || verdict.length === 0) return retain('verdict is unknown')
  if (verdict !== 'PASS' && verdict !== 'UNVERIFIED') return retain('verdict is not PASS or UNVERIFIED; the run root is preserved')
  if (mcpClosed !== true || identityConfirmed !== true || contextClean !== true) {
    return retain('mcp close, identity confirmation and context cleanliness are not all confirmed')
  }

  const owner = input.localRootOwnership
  if (!owner || owner.createdBy !== CASE3_CLEANUP_OWNER) return retain('run root is not owned by acceptance-preflight')
  if (owner.runId !== input.runId) return retain('ownership runId does not match the manifest')
  if (typeof owner.tempRoot !== 'string' || resolve(owner.tempRoot) !== root) return retain('ownership tempRoot does not match the manifest')

  if (!existsSync(root)) return retain('run root does not exist')

  let real: string
  try { real = realpathSync(root) } catch (error) { return retain(`run root realpath could not be resolved: ${errorName(error)}`) }
  if (real !== root) return retain('run root realpath does not equal the declared absolute path (symlink or junction)')

  if (!strictInside(SYSTEM_TEMP_ROOT, root)) return retain('run root is not strictly inside the system temp root')
  if (resolve(input.workspaceRoot) !== resolve(root, 'workspace')) return retain('workspaceRoot is not the exact <root>/workspace descendant')
  if (resolve(input.contextDatabasePath) !== resolve(root, 'contexts.sqlite')) return retain('contextDatabasePath is not the exact <root>/contexts.sqlite descendant')

  const resolvedEvidence = resolve(evidenceDir)
  if (resolvedEvidence === root || strictInside(root, resolvedEvidence)) {
    return retain('evidence directory is inside the run root; refusing to delete')
  }

  try { assertRealTree(root) } catch (error) { return retain(`run root tree is not link-free: ${retentionReason(error)}`) }

  const intentPath = writeReceipt(evidenceDir, CASE3_CLEANUP_INTENT_FILE, {
    status: 'intent',
    action: 'delete',
    runId: input.runId,
    root,
    verdict,
    mcpClosed,
    identityConfirmed,
    contextClean,
    ownership: { createdBy: owner.createdBy, runId: owner.runId, tempRoot: resolve(owner.tempRoot) },
    decidedAt: new Date().toISOString(),
  })

  // Literal verified root, complete inventory, per-file unlink and nonrecursive rmdir.
  // Unknown/new children or an unremovable entry throw instead of reporting completion.
  removeOwnedTree(root, SYSTEM_TEMP_ROOT)

  const completionPath = writeReceipt(evidenceDir, CASE3_CLEANUP_COMPLETION_FILE, {
    status: 'completed',
    action: 'deleted',
    runId: input.runId,
    root,
    intentPath,
    deletedAt: new Date().toISOString(),
  })

  return { deleted: true, reason: 'owned run root deleted', root, intentPath, completionPath }
}
