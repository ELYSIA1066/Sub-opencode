import { OpenCode, type OpenCodeClient } from '@opencode/client'
import { Agent } from 'undici'

const disposers = new WeakMap<OpenCodeClient, () => void>()

/** Only requests carrying a caller deadline may outlive Node's 300s HTTP idle timers. */
export function createSdkClient(baseUrl: string, headers: HeadersInit): OpenCodeClient {
  let dispatcher: Agent | undefined
  const fetch: typeof globalThis.fetch = (input, init) => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    if (!signal) return globalThis.fetch(input, init)
    signal.throwIfAborted()
    dispatcher ??= new Agent({ headersTimeout: 0, bodyTimeout: 0 })
    const options: RequestInit & { dispatcher: Agent } = { ...init, dispatcher }
    return globalThis.fetch(input, options)
  }
  const client = OpenCode.make({ baseUrl, headers, fetch })
  disposers.set(client, () => {
    // Destroy rather than drain: invalidation must not wait for a long request to finish.
    void dispatcher?.destroy().catch(() => {})
  })
  return client
}

export function disposeSdkClient(client: OpenCodeClient): void {
  disposers.get(client)?.()
  disposers.delete(client)
}
