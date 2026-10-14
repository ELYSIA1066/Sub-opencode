import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { resolveRegistryPath, registryPathHash } from '../src/service-registry.js'
import { loadConfig } from '../src/config.js'

describe('shared registry source is stable across MCP and acceptance', () => {
  it('normalizes fresh paths with explicit > environment > user default priority', () => {
    const env = { OPENCODE_SERVICE_REGISTRY_FILE: resolve('env-service.json'), XDG_STATE_HOME: resolve('isolated-state') }
    expect(resolveRegistryPath({ explicit: './chosen/../explicit.json', env })).toBe(resolve('explicit.json'))
    expect(resolveRegistryPath({ env })).toBe(env.OPENCODE_SERVICE_REGISTRY_FILE)
    expect(resolveRegistryPath({ env: { XDG_STATE_HOME: env.XDG_STATE_HOME } })).toBe(join(env.XDG_STATE_HOME, 'opencode/service.json'))
    expect(resolveRegistryPath({ env: {} })).toBe(join(homedir(), '.local/state/opencode/service.json'))
  })
  it('uses the saved run path despite inherited isolated XDG or registry variables', () => {
    const path = resolve('shared/service.json')
    const manifest = { sharedRegistryPath: path, sharedRegistryPathHash: registryPathHash(path) }
    expect(resolveRegistryPath({ manifest, env: { XDG_STATE_HOME: 'other', OPENCODE_SERVICE_REGISTRY_FILE: 'other' } })).toBe(path)
    expect(resolveRegistryPath({ manifest, explicit: path })).toBe(path)
  })
  it('fails on explicit conflicts rather than connecting or submitting a prompt', () => {
    const manifest = { sharedRegistryPath: resolve('saved.json') }
    expect(() => resolveRegistryPath({ manifest, explicit: resolve('other.json') })).toThrow('registry_path_conflict')
  })
  it('detects edited, relative or unnormalized manifest paths', () => {
    const path = resolve('saved.json')
    expect(() => resolveRegistryPath({ manifest: { sharedRegistryPath: resolve('changed.json'), sharedRegistryPathHash: registryPathHash(path) } })).toThrow('registry_manifest_path_invalid')
    expect(() => resolveRegistryPath({ manifest: { sharedRegistryPath: 'relative.json' } })).toThrow('registry_manifest_path_invalid')
    expect(() => resolveRegistryPath({ manifest: { sharedRegistryPath: `${resolve('folder')}/../saved.json` } })).toThrow('registry_manifest_path_invalid')
  })
  it('MCP config uses the same resolver without reading ambient process XDG', () => {
    const env = { XDG_STATE_HOME: resolve('config-state') }
    expect(loadConfig(env).serviceRegistryFile).toBe(resolveRegistryPath({ env }))
    expect(loadConfig({ OPENCODE_SERVICE_REGISTRY_FILE: './relative-service.json' }).serviceRegistryFile).toBe(resolve('relative-service.json'))
  })
})
