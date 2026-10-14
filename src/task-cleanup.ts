import type { OpenCodeClient } from '@opencode/client'
import { createHash } from 'node:crypto'
import { awaitBefore, cleanupCall, raceAbort } from './deadline.js'
import { PermissionRecoveryError } from './session-permission-guard.js'

export type TaskCleanupReceipt = {
  idleVerified: boolean
  denyAllVerified: boolean
  quarantined: boolean
  leaseRetained: boolean
  leaseReleased: boolean
  errors: readonly string[]
  failureCode?: string
  failureMessage?: string
}
export type InterruptSource = 'caller_cancel' | 'task_timeout' | 'mcp_shutdown' | 'event_stream_failure' | 'permission_reply_failure' | 'unknown'

/** Small immutable receipt shared by task coordination and final output mapping. */
export function cleanupReceipt(input: TaskCleanupReceipt): TaskCleanupReceipt {
  return Object.freeze({ ...input, errors: Object.freeze([...input.errors]) })
}

export async function cleanupTask(input: {
  api: OpenCodeClient | undefined
  sessionId: string | undefined
  sessionCreateStarted: boolean
  taskAborted: boolean
  interruptSource?: InterruptSource
  forceQuarantine: boolean
  quarantineCode?: string
  quarantineMessage?: string
  contextId: string
  leaseToken: string
  shutdownRequested: () => boolean
  cleanupControllers: Set<AbortController>
  inFlight: Set<Promise<unknown>>
  preparationInFlight?: Promise<void>
  eventPump: Promise<void> | undefined
  shutdownSignal: AbortSignal
  deadline: () => number
  releaseLease: (contextId: string, leaseToken: string, deadline: number) => boolean
  quarantine: (contextId: string, leaseToken: string, sessionId: string, deadline: number) => boolean
  onShutdownFailure: () => void
  onDiagnostic: (event: string, errorType: string, fields?: Record<string, unknown>) => void
  revokeAndVerify: (api: OpenCodeClient, sessionId: string) => Promise<boolean>
}): Promise<TaskCleanupReceipt> {
  const errors: string[] = []
  const diagnostic = (event: string, errorType: string, fields?: Record<string, unknown>) => {
    try { input.onDiagnostic(event, errorType, fields) } catch { /* Logging cannot alter cleanup or its deadline. */ }
  }
  const addError = (stage: string, error: unknown) => {
    const name = error instanceof Error ? error.name.replace(/[^A-Za-z0-9_-]/gu, '').slice(0, 40) || 'Error' : 'UnknownError'
    errors.push(`${stage}:${name}`)
  }
  let idleVerified = !input.taskAborted
  let denyAllVerified = false
  let quarantined = false
  let leaseRetained = true
  let leaseReleased = false
  const api = input.api
  if (!api && input.preparationInFlight) {
    try { await raceAbort(awaitBefore(Promise.allSettled([input.preparationInFlight]), input.deadline() - 150), input.shutdownSignal) }
    catch (error) {
      addError('prepare_drain', error)
      if (input.shutdownRequested()) input.onShutdownFailure()
      return cleanupReceipt({ idleVerified: false, denyAllVerified: false, quarantined: false, leaseRetained: true, leaseReleased: false, errors,
        failureCode: 'service_unavailable', failureMessage: 'Service initialization did not exit before cleanup; the context lease was retained.' })
    }
  }
  if (api) {
    if (input.sessionId && input.taskAborted) {
      const fields = { session: createHash('sha256').update(input.sessionId).digest('hex').slice(0, 16), source: input.interruptSource ?? 'unknown' }
      let startedAt: number | undefined
      try {
        const result = await cleanupCall((signal) => {
          startedAt = performance.now()
          diagnostic('session_interrupt_started', 'none', fields)
          return api.session.interrupt({ sessionID: input.sessionId! }, { signal })
        }, Math.min(input.deadline() - 150, Date.now() + 2_000), input.cleanupControllers)
        diagnostic('session_interrupt_completed', 'none', { ...fields, status: 'accepted', interrupted: result.interrupted, durationMs: performance.now() - startedAt! })
      } catch (error) {
        if (startedAt !== undefined) diagnostic('session_interrupt_completed', error instanceof Error ? error.name.replace(/[^A-Za-z0-9_-]/gu, '').slice(0, 40) : 'UnknownError',
          { ...fields, status: 'failed', durationMs: performance.now() - startedAt })
        addError('interrupt', error)
      }
      try { await cleanupCall((signal) => api.session.wait({ sessionID: input.sessionId! }, { signal }), Math.min(input.deadline() - 150, Date.now() + 2_000), input.cleanupControllers); idleVerified = true } catch (error) { addError('wait', error); idleVerified = false }
    }
    try {
      const pending = [...input.inFlight, ...(input.eventPump ? [input.eventPump] : [])]
      const remain = Math.min(input.deadline() - 150, Date.now() + 2_000) - Date.now()
      if (remain <= 0) throw new Error('DeadlineExceeded')
      await raceAbort(awaitBefore(Promise.allSettled(pending), Date.now() + remain), input.shutdownSignal)
    } catch (error) { addError('drain', error); idleVerified = false }
    if (input.sessionId) {
      try {
        denyAllVerified = await input.revokeAndVerify(api, input.sessionId)
        if (!denyAllVerified) addError('readback', new Error('PermissionVerificationFailed'))
      } catch (error) {
        if (error instanceof PermissionRecoveryError) {
          if (error.updateFailure) addError('revoke', error.updateFailure)
          if (error.readFailure) addError('readback', error.readFailure)
          if (!error.updateFailure && !error.readFailure) addError('readback', error)
        } else addError('revoke_or_readback', error)
      }
    }
    if (input.sessionId && (!denyAllVerified || !idleVerified || errors.length > 0 || input.forceQuarantine)) {
      try { quarantined = input.quarantine(input.contextId, input.leaseToken, input.sessionId, input.deadline()) }
      catch (error) { addError('quarantine_persist', error); quarantined = false }
      leaseRetained = !quarantined
      if (!quarantined) errors.push('quarantine_persistence_failed')
      diagnostic(quarantined ? 'session_quarantined' : 'quarantine_persistence_failed', errors[0] ?? 'UnknownError')
      if (input.shutdownRequested()) input.onShutdownFailure()
    } else if (input.sessionCreateStarted && !input.sessionId) {
      errors.push('session_create_outcome_unknown')
      diagnostic('session_create_outcome_unknown', 'UnknownError')
      if (input.shutdownRequested()) input.onShutdownFailure()
    } else {
      leaseReleased = input.releaseLease(input.contextId, input.leaseToken, input.deadline())
      leaseRetained = !leaseReleased
      if (!leaseReleased) {
        errors.push('lease_release_failed')
        diagnostic('lease_release_failed', 'ContextStoreError')
        if (input.shutdownRequested()) input.onShutdownFailure()
      }
    }
  } else if (input.sessionCreateStarted) {
    errors.push('session_create_outcome_unknown')
    diagnostic('session_create_outcome_unknown', 'UnknownError')
    if (input.shutdownRequested()) input.onShutdownFailure()
  } else {
    leaseReleased = input.releaseLease(input.contextId, input.leaseToken, input.deadline())
    leaseRetained = !leaseReleased
    if (!leaseReleased) { errors.push('lease_release_failed'); if (input.shutdownRequested()) input.onShutdownFailure() }
  }
  return cleanupReceipt({ idleVerified, denyAllVerified, quarantined, leaseRetained, leaseReleased, errors,
    ...(quarantined && { failureCode: input.quarantineCode ?? 'permission_reset_failed', failureMessage: input.quarantineMessage ?? 'Permission cleanup could not be verified; do not reuse this context_id.' }),
    ...(errors.includes('lease_release_failed') || errors.includes('quarantine_persistence_failed') ? { failureCode: 'context_store_failed', failureMessage: 'The context lease or quarantine could not be safely persisted; do not reuse this context_id.' } : {}),
  })
}
