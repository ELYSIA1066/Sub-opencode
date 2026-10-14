import type { OpenCodeEvent } from '@opencode/client'
import type { OpenCodeClient } from '@opencode/client'
import { decidePermission, lockedPermissionRules, permissionRulesForCall, type PermissionScope } from './permission-policy.js'

export class PermissionLockError extends Error {
  constructor() { super('OpenCode did not confirm deny-all permissions before reusing the session.'); this.name = 'PermissionLockError' }
}

/** Owns the permission transition contract used by a task. */
export class SessionPermissionGuard {
  lockedRules() { return lockedPermissionRules() }
  taskRules(scope: PermissionScope) { return permissionRulesForCall(scope) }

  async lockSession(api: OpenCodeClient, sessionId: string, signal: AbortSignal, call: <T>(promise: Promise<T>) => Promise<T>): Promise<Awaited<ReturnType<OpenCodeClient['session']['get']>>> {
    await call(api.session.update({ sessionID: sessionId, permissions: this.lockedRules() }, { signal }))
    const session = await call(api.session.get({ sessionID: sessionId }, { signal }))
    if (!hasPermissionRules(session.permissions, this.lockedRules())) throw new PermissionLockError()
    return session
  }

  async openScope(api: OpenCodeClient, sessionId: string, scope: PermissionScope, signal: AbortSignal, call: <T>(promise: Promise<T>) => Promise<T>): Promise<void> {
    await call(api.session.update({ sessionID: sessionId, permissions: this.taskRules(scope) }, { signal }))
  }

  async revokeAndVerify(api: OpenCodeClient, sessionId: string, call: <T>(operation: (signal: AbortSignal) => Promise<T>, deadline: number) => Promise<T>, deadline: () => number): Promise<boolean> {
    let updateFailure: unknown
    let verified = false
    let readFailure: unknown
    try { await call((signal) => api.session.update({ sessionID: sessionId, permissions: this.lockedRules() }, { signal }), deadline() - 150) }
    catch (error) { updateFailure = error }
    try {
      const session = await call((signal) => api.session.get({ sessionID: sessionId }, { signal }), deadline() - 150)
      verified = hasPermissionRules(session.permissions, this.lockedRules())
    } catch (error) { readFailure = error }
    if (updateFailure || readFailure) throw new PermissionRecoveryError(updateFailure, readFailure)
    return verified
  }

  decideAsked(event: Extract<OpenCodeEvent, { type: 'permission.asked' }>, scope: PermissionScope, workspaceRoot: string): 'once' | 'reject' {
    const resources = event.data.resources
    return resources.length > 0 && resources.every((resource) =>
      decidePermission({ action: event.data.action, resource }, scope, workspaceRoot) === 'allow_once') ? 'once' : 'reject'
  }
}

export class PermissionRecoveryError extends Error {
  constructor(readonly updateFailure: unknown, readonly readFailure: unknown) {
    super('Permission revoke or readback failed.')
    this.name = 'PermissionRecoveryError'
  }
}

export function hasPermissionRules(actual: unknown, expected: ReturnType<typeof lockedPermissionRules>): boolean {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false
  const normalize = (rules: readonly { action: string; resource: string; effect: string }[]) =>
    rules.map((rule) => `${rule.action}\u0000${rule.resource}\u0000${rule.effect}`).sort()
  const normalizedActual = normalize(actual as { action: string; resource: string; effect: string }[])
  const normalizedExpected = normalize(expected)
  return normalizedActual.every((rule, index) => rule === normalizedExpected[index])
}
