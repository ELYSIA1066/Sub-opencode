import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { McpStdioClient } from '../tools/acceptance/runtime.js'
import { SHARED_REGISTRY } from '../src/service-bootstrap.js'
import { LIVE_LEDGER } from '../tools/acceptance/budget.js'

it('real stdio handshake and close do not run automatic preparation or submit prompts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lazy-service-mcp-'))
  const before = existsSync(SHARED_REGISTRY) ? readFileSync(SHARED_REGISTRY) : undefined
  const ledger = readFileSync(LIVE_LEDGER)
  const client = new McpStdioClient('lazy-service', process.cwd(), { ...process.env, OPENCODE_CONTEXT_DB_PATH: join(root, 'contexts.sqlite'),
    OPENCODE_SERVICE_REGISTRY_FILE: SHARED_REGISTRY, OPENCODE_AUTO_PREPARE: 'true' })
  try {
    await client.start(); await client.close()
    expect(client.exitCode).toBe(0)
    expect(existsSync(SHARED_REGISTRY) ? readFileSync(SHARED_REGISTRY) : undefined).toEqual(before)
    expect(readFileSync(LIVE_LEDGER)).toEqual(ledger)
  } finally { await client.close(); if (client.exited) rmSync(root, { recursive: true, force: true }) }
})
