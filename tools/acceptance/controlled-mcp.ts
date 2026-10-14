import { readFileSync, realpathSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { OpenCode } from '@opencode/client'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { createMcpServer } from '../../src/mcp.js'
import { loadConfig } from '../../src/config.js'
import { OpenCodeServerManager } from '../../src/opencode-server.js'
import { OpenCodeDelegator } from '../../src/delegation.js'
import { shutdownTogether } from '../../src/shutdown.js'
import { controlledClient } from './controlled-events.js'

/** Explicit standalone test executable. The production MCP never imports it. */
async function main(): Promise<void> {
  if (process.argv.length !== 3) throw new Error('controlled_mcp_arguments')
  const file = resolve(process.argv[2]!)
  const input = JSON.parse(readFileSync(file, 'utf8'))
  const config = loadConfig()
  if (input.mode !== 'case3-controlled' || realpathSync(file) !== file
    || resolve(config.contextStorePath) !== resolve(dirname(file), 'contexts.sqlite')
    || resolve(input.workspace) !== resolve(dirname(file), 'workspace')
    || config.serviceRegistryFile !== input.identity?.registryPath
    || config.model !== 'opencode-go/deepseek-v4.1-flash'
    || !Array.isArray(input.seeds) || input.seeds.length !== 2) throw new Error('controlled_mcp_config_invalid')
  let sequence = 0
  const manager = new OpenCodeServerManager({ registryFile: config.serviceRegistryFile,
    createClient: (baseUrl, headers) => controlledClient(OpenCode.make({ baseUrl, headers }), {
      workspace: input.workspace, seeds: input.seeds, marker: input.marker, timeoutMs: config.promptTimeoutMs,
      audit: (record) => console.error(JSON.stringify({ component: 'case3-control', sequence: ++sequence, timestamp: new Date().toISOString(), ...record })),
    }) })
  const connected = await manager.connect()
  for (const key of ['id', 'pid', 'url', 'version', 'registryPath'] as const) if (connected.identity[key] !== input.identity[key]) throw new Error('controlled_identity_changed')
  const delegator = new OpenCodeDelegator(manager, config)
  const server = createMcpServer({ config, serverManager: manager, delegator })
  const handle = serveStdio(() => server)
  let shutdown: Promise<void> | undefined
  const close = () => {
    shutdown ??= shutdownTogether({ beginShutdown: (end) => delegator.beginShutdown(end), closeTransport: () => handle.close(), closeTasks: (end) => delegator.close(end) })
      .then((result) => { if (result.status !== 'closed') process.exit(1) })
  }
  process.stdin.once('end', close); process.stdin.once('close', close)
  process.once('SIGINT', close); process.once('SIGTERM', close)
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('controlled_mcp_start_failed'); process.exit(1) })
}
