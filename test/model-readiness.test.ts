import { resolve } from 'node:path'
import type { OpenCodeClient } from '@opencode/client'
import { describe, expect, it, vi } from 'vitest'
import { waitForModelMetadata } from '../tools/acceptance/model-readiness.js'

const workspace = resolve('controlled-workspace')
function harness() {
  const providers = { location: { directory: workspace }, data: [{ id: 'opencode-go' }] }
  const models = { location: { directory: workspace }, data: [{ providerID: 'opencode-go', id: 'deepseek-v4.1-flash', enabled: true }] }
  const providerList = vi.fn(async () => providers)
  const modelList = vi.fn(async () => models)
  const verifyIdentity = vi.fn(async () => {})
  const api = { provider: { list: providerList }, model: { list: modelList } } as unknown as OpenCodeClient
  return { providers, models, providerList, modelList, verifyIdentity, options: { api, workspace, verifyIdentity, intervalMs: 1 } }
}
describe('zero-prompt model metadata readiness', () => {
  it('requires two consecutive ready rounds after an initial empty list', async () => {
    const h = harness(); h.providerList.mockResolvedValueOnce({ ...h.providers, data: [] }); h.modelList.mockResolvedValueOnce({ ...h.models, data: [] })
    const result = await waitForModelMetadata(h.options)
    expect(result.attempts).toHaveLength(3)
    expect(result.attempts[0]).toMatchObject({ providerCount: 0, modelCount: 0, providerAvailable: false, modelAvailable: false })
    expect(h.providerList).toHaveBeenCalledTimes(3); expect(h.modelList).toHaveBeenCalledTimes(3)
  })
  it('limits persistent missing or disabled models to six rounds', async () => {
    const h = harness(); h.models.data[0]!.enabled = false
    await expect(waitForModelMetadata(h.options)).rejects.toMatchObject({ code: 'model_metadata_unavailable', attempts: expect.any(Array) })
    expect(h.providerList).toHaveBeenCalledTimes(6); expect(h.modelList).toHaveBeenCalledTimes(6)
  })
  it('does not use a model from a different provider', async () => {
    const h = harness(); h.models.data[0]!.providerID = 'opencode'
    await expect(waitForModelMetadata(h.options)).rejects.toMatchObject({ code: 'model_metadata_unavailable' })
  })
  it('resets consecutive confirmation when metadata disappears', async () => {
    const h = harness(); h.modelList.mockResolvedValueOnce(h.models).mockResolvedValueOnce({ ...h.models, data: [] })
    expect((await waitForModelMetadata(h.options)).attempts).toHaveLength(4)
  })
  it.each(['authentication', 'disconnect', 'identity'])('stops immediately for %s faults', async (kind) => {
    const h = harness(); const fault = { type: kind, status: 401 }
    if (kind === 'identity') h.verifyIdentity.mockRejectedValue(fault)
    else h.providerList.mockRejectedValue(fault)
    await expect(waitForModelMetadata(h.options)).rejects.toBe(fault)
    expect(h.modelList).not.toHaveBeenCalled(); expect(h.providerList.mock.calls.length).toBeLessThanOrEqual(1)
  })
  it('refuses metadata returned for another workspace', async () => {
    const h = harness(); h.models.location.directory = resolve('other-workspace')
    await expect(waitForModelMetadata(h.options)).rejects.toMatchObject({ code: 'metadata_workspace_mismatch' })
    expect(h.modelList).toHaveBeenCalledOnce()
  })
  it('bounds a hanging query with the shared deadline and aborts its request', async () => {
    const h = harness(); let signal: AbortSignal | undefined
    h.providerList.mockImplementation((_input?: any, options?: any) => { signal = options.signal; return new Promise(() => {}) })
    const start = Date.now()
    await expect(waitForModelMetadata({ ...h.options, timeoutMs: 30 })).rejects.toMatchObject({ code: 'model_metadata_unavailable' })
    expect(Date.now() - start).toBeLessThan(500); expect(signal?.aborted).toBe(true)
    expect(h.providerList).toHaveBeenCalledOnce(); expect(h.modelList).not.toHaveBeenCalled()
  })
})
