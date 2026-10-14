import { resolve } from 'node:path'
import type { OpenCodeClient } from '@opencode/client'

export type MetadataAttempt = { round: number; providerCount: number; modelCount: number; providerAvailable: boolean; modelAvailable: boolean }
export class ModelMetadataError extends Error {
  constructor(readonly code: string, readonly attempts: MetadataAttempt[]) { super(code); this.name = 'ModelMetadataError' }
}

/** Zero-prompt queries only. No default workspace, cached models, authentication or fallback. */
export async function waitForModelMetadata(options: {
  api: Pick<OpenCodeClient, 'provider' | 'model'>
  workspace: string
  verifyIdentity: () => Promise<void>
  timeoutMs?: number
  intervalMs?: number
}): Promise<{ providerAvailable: true; modelAvailable: true; attempts: MetadataAttempt[] }> {
  const attempts: MetadataAttempt[] = []
  const controller = new AbortController()
  const deadline = Date.now() + Math.min(options.timeoutMs ?? 20_000, 20_000)
  let timer: NodeJS.Timeout
  const unavailable = () => new ModelMetadataError('model_metadata_unavailable', [...attempts])
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(unavailable()) }, Math.max(1, deadline - Date.now()))
  })
  const bounded = <T>(promise: Promise<T>) => Promise.race([promise, expiry])
  let consecutive = 0
  try {
    for (let round = 1; round <= 6; round++) {
      await bounded(options.verifyIdentity())
      const input = { location: { directory: options.workspace } }
      const providers = await bounded(options.api.provider.list(input, { signal: controller.signal }))
      const models = await bounded(options.api.model.list(input, { signal: controller.signal }))
      await bounded(options.verifyIdentity())
      if (!providers.location?.directory || !models.location?.directory
        || resolve(providers.location.directory) !== resolve(options.workspace)
        || resolve(models.location.directory) !== resolve(options.workspace)) throw new ModelMetadataError('metadata_workspace_mismatch', attempts)
      if (!Array.isArray(providers.data) || !Array.isArray(models.data)) throw new ModelMetadataError('model_metadata_invalid', attempts)
      const providerAvailable = providers.data.some((provider) => provider.id === 'opencode-go')
      const modelAvailable = models.data.some((model) => model.providerID === 'opencode-go' && model.id === 'deepseek-v4.1-flash' && model.enabled === true)
      attempts.push({ round, providerCount: providers.data.length, modelCount: models.data.length, providerAvailable, modelAvailable })
      consecutive = providerAvailable && modelAvailable ? consecutive + 1 : 0
      if (consecutive === 2) return { providerAvailable: true, modelAvailable: true, attempts }
      if (round < 6) await bounded(new Promise((res) => setTimeout(res, Math.min(options.intervalMs ?? 500, 500))))
    }
    throw unavailable()
  } finally { clearTimeout(timer!); controller.abort() }
}
