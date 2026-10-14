import type { OpenCodeClient, OpenCodeEvent } from '@opencode/client'
import { DelegationError } from './delegation-types.js'

export class TurnEvidence {
  private deliveredInboxId: string | undefined
  private readonly delivered = new Set<string>()
  private readonly stepsByInbox = new Map<string, string[]>()
  permissionDenied = false

  observe(event: OpenCodeEvent, sessionId: string): void {
    if (event.type === 'session.inbox.delivered' && event.data.sessionID === sessionId) {
      this.deliveredInboxId = event.data.inboxID
      this.stepsByInbox.set(event.data.inboxID, [])
      this.delivered.add(event.data.inboxID)
    } else if (event.type === 'session.step.started' && event.data.sessionID === sessionId && this.deliveredInboxId) {
      const ids = this.stepsByInbox.get(this.deliveredInboxId) ?? []
      ids.push(event.data.assistantMessageID)
      this.stepsByInbox.set(this.deliveredInboxId, ids)
    }
  }

  recordPermissionDenied(): void { this.permissionDenied = true }
  assistantIds(inboxId: string): string[] { return [...(this.stepsByInbox.get(inboxId) ?? [])] }
  hasDelivered(inboxId: string): boolean { return this.delivered.has(inboxId) }
}

export type AssistantResponse = {
  id: string
  type: 'assistant'
  finish?: string
  error?: { type: string; message: string; status?: number }
  cost?: number
  tokens?: unknown
  content: Array<{ type: string; text?: string }>
}

export async function findCurrentAssistant(
  api: OpenCodeClient,
  sessionId: string,
  promptId: string,
  evidence: TurnEvidence,
  signal: AbortSignal,
  timeoutMs: number,
  call: <T>(promise: Promise<T>) => Promise<T>,
): Promise<AssistantResponse> {
  const deadline = Date.now() + Math.max(1, Math.min(timeoutMs, 500))
  while (Date.now() < deadline) {
    const assistantIds = evidence.assistantIds(promptId)
    const finalAssistantId = assistantIds.at(-1)
    if (evidence.hasDelivered(promptId) && assistantIds.length > 0) {
      let cursor: string | undefined
      const seenCursors = new Set<string>()
      let foundCurrentUser = false
      let finalAssistant: AssistantResponse | undefined
      for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
        const page = await call(api.message.list({ sessionID: sessionId, limit: 100, ...(cursor ? { cursor } : { order: 'desc' as const }) }, { signal }))
        for (const message of page.data) {
          if (message.type === 'user') {
            if (message.id === promptId) { foundCurrentUser = true; break }
            throw new DelegationError('A newer user message appeared before the current prompt boundary; refusing to return an unlinked result.', undefined, 'turn_unmatched')
          }
          if (message.type === 'assistant' && message.id === finalAssistantId) finalAssistant = message as AssistantResponse
        }
        if (foundCurrentUser) break
        const next = page.cursor.next ?? undefined
        if (!next) break
        if (seenCursors.has(next)) throw new DelegationError('OpenCode repeated a message pagination cursor.', undefined, 'turn_unmatched')
        seenCursors.add(next)
        cursor = next
      }
      if (foundCurrentUser && finalAssistant && (finalAssistant.error || finalAssistant.finish === 'error' || ['stop', 'length', 'content-filter'].includes(finalAssistant.finish ?? ''))) return finalAssistant
    }
    if (signal.aborted) throw signal.reason
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new DelegationError('No terminal assistant step could be matched to the current prompt before the event deadline.', undefined, 'turn_unmatched')
}
