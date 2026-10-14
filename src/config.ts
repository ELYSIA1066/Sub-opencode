import { defaultContextStorePath } from './context-store.js'
import { resolveRegistryPath } from './service-registry.js'
import { SHARED_REGISTRY } from './service-bootstrap.js'
import { resolve } from 'node:path'

export type AppConfig = {
  opencodeCommand: string
  model: string
  promptTimeoutMs: number
  contextStorePath: string
  serviceRegistryFile?: string
  autoPrepareSharedService?: boolean
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const model = env.OPENCODE_MODEL?.trim() || 'opencode-go/deepseek-v4.1-flash'
  if (!/^[^/]+\/.+$/u.test(model)) {
    throw new Error('OPENCODE_MODEL must use the provider/model-id format.')
  }
  const registry = resolveRegistryPath({ env })
  const flag = env.OPENCODE_AUTO_PREPARE?.trim().toLowerCase()
  if (flag && !['true', 'false'].includes(flag)) throw new Error('OPENCODE_AUTO_PREPARE must be true or false.')
  return {
    opencodeCommand: env.OPENCODE_COMMAND?.trim() || 'opencode',
    model,
    promptTimeoutMs: positiveInteger(env.OPENCODE_PROMPT_TIMEOUT_MS, 18_000_000),
    contextStorePath: defaultContextStorePath(env),
    serviceRegistryFile: registry,
    autoPrepareSharedService: flag !== 'false' && resolve(registry).toLowerCase() === resolve(SHARED_REGISTRY).toLowerCase(),
  }
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback
  const parsed = Number(value.trim())
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer configuration value, got: ${value}`)
  }
  return parsed
}
