import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'

describe('configuration', () => {
  it('enables preparation only for the canonical default and honors explicit opt-out', () => {
    expect(loadConfig({}).autoPrepareSharedService).toBe(true)
    expect(loadConfig({ OPENCODE_AUTO_PREPARE: 'false' }).autoPrepareSharedService).toBe(false)
    expect(loadConfig({ OPENCODE_SERVICE_REGISTRY_FILE: 'C:\\test\\service.json', OPENCODE_AUTO_PREPARE: 'true' }).autoPrepareSharedService).toBe(false)
    expect(() => loadConfig({ OPENCODE_AUTO_PREPARE: 'invalid' })).toThrow('true or false')
  })
  it('defaults to the documented model and timeout', () => {
    expect(loadConfig({})).toMatchObject({
      opencodeCommand: 'opencode',
      promptTimeoutMs: 18_000_000, model: 'opencode-go/deepseek-v4.1-flash',
    })
  })

  it('accepts an explicit shared registry in fail-closed reuse-only mode', () => {
    const registry = 'C:\\shared\\service.json'
    const expected = loadConfig({ OPENCODE_SERVICE_REGISTRY_FILE: registry })
    for (const value of ['true', 'false', 'invalid']) {
      expect(loadConfig({ OPENCODE_SERVICE_REGISTRY_FILE: registry, OPENCODE_REUSE_ONLY: value })).toEqual(expected)
    }
  })

  it('uses an explicitly configured OpenCode model and validates its format', () => {
    expect(loadConfig({ OPENCODE_MODEL: 'opencode/longcat-2.5-preview-free' }).model)
      .toBe('opencode/longcat-2.5-preview-free')
    expect(() => loadConfig({ OPENCODE_MODEL: 'claude-sonnet-5-5' })).toThrow('provider/model-id')
  })

  it('ignores deprecated host, port, and auth environment variables', () => {
    const config = loadConfig({
      OPENCODE_HOST: '0.0.0.0',
      OPENCODE_PORT: '70000',
      OPENCODE_SERVER_USERNAME: 'codex',
      OPENCODE_SERVER_PASSWORD: 'secret',
    })
    expect(config).toEqual(loadConfig({}))
    for (const name of ['host', 'port', 'reuseOnly', 'username', 'password']) expect(config).not.toHaveProperty(name)
  })

  it('rejects negative prompt timeout values', () => {
    expect(() => loadConfig({ OPENCODE_PROMPT_TIMEOUT_MS: '-1' })).toThrow('positive integer')
  })
})
