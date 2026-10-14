import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'
import { DelegationError, OpenCodeDelegator, type DelegateOutput } from './delegation.js'
import { loadConfig } from './config.js'
import { ContextStoreError } from './context-store.js'
import { OpenCodeServerError, OpenCodeServerManager } from './opencode-server.js'
import { shutdownTogether } from './shutdown.js'
import { TaskServicePreparation, userServiceEnvironment, SHARED_REGISTRY, PrepareError } from './service-bootstrap.js'

export type McpServerOptions = {
  config?: ReturnType<typeof loadConfig>
  serverManager?: OpenCodeServerManager
  delegator?: OpenCodeDelegator
}

const outputSchema = z.object({
  status: z.enum(['completed', 'failed', 'rejected', 'canceled']),
  context_id: z.string(),
  session_id: z.string().optional(),
  result: z.string().optional(),
  error: z.string().optional(),
  error_code: z.string().optional(),
  server_url: z.string().optional(),
  attach_command: z.string().optional(),
})

export function createMcpServer(options: McpServerOptions = {}): McpServer {
  const config = options.config ?? loadConfig()
  const serverManager = options.serverManager ?? new OpenCodeServerManager({
    ...(config.serviceRegistryFile && { registryFile: config.serviceRegistryFile }),
  })
  const delegator = options.delegator ?? createDelegator(serverManager, config)
  const server = new McpServer(
    { name: 'opencode-agent', version: '0.1.0' },
    { capabilities: { tools: {} } },
  )

  server.registerTool(
    'delegate_to_opencode',
    {
      description: 'Delegate a coding or technical task to OpenCode. Provide the absolute workspace_root. Choose the smallest permission_scope needed for this task; only workspace file access and exact shell commands are supported. Reuse context_id for a follow-up in the same OpenCode session. Returns a server URL and an OpenCode --server command for viewing the shared session.',
      inputSchema: z.object({
        task: z.string().trim().min(1).describe('Task for the OpenCode coding agent.'),
        workspace_root: z.string().min(1).describe('Absolute path to the workspace OpenCode may work in.'),
        context_id: z.string().min(1).optional().describe('Reuse a returned context_id to continue the same session.'),
        model: z.string().trim().min(3).optional().describe('Optional OpenCode model in provider/model-id format. Defaults to the configured model.'),
        permission_scope: z.object({
          fileAccess: z.enum(['read_only', 'workspace_write']).describe('Whether OpenCode may modify files in workspace_root.'),
          shellCommands: z.array(z.string()).default([]).describe('Exact shell command strings approved for this delegation. Commands are not remembered after this task.'),
        }),
      }),
      outputSchema,
    },
    async ({ task, workspace_root, context_id, model, permission_scope }, extra) => {
      const contextId = context_id ?? randomUUID()
      let output: DelegateOutput
      try {
        output = await delegator.delegate({
          task,
          workspace_root,
          context_id: contextId,
          ...(model && { model }),
          permission_scope,
        }, extra.mcpReq.signal)
      } catch (error) {
        output = failureOutput(error, contextId)
      }
      const text = output.result ?? output.error ?? `OpenCode task ${output.status}.`
      return {
        structuredContent: output,
        content: [{ type: 'text' as const, text }],
        isError: output.status !== 'completed',
      }
    },
  )

  return server
}

export function createDelegator(manager: OpenCodeServerManager, config: ReturnType<typeof loadConfig>): OpenCodeDelegator {
  const preparation = config.autoPrepareSharedService ? new TaskServicePreparation({ registryFile: SHARED_REGISTRY, env: userServiceEnvironment() }) : undefined
  return new OpenCodeDelegator(manager, config, undefined, preparation ? async (deadline, signal) => {
    try {
      const receipt = await preparation.prepare(deadline, signal)
      const old = manager.diagnosticInfo.identity
      if (old && (old.id !== receipt.identity.id || old.pid !== receipt.identity.pid || old.url !== receipt.identity.url || manager.diagnosticInfo.version !== receipt.identity.version)) manager.invalidate()
      console.error(JSON.stringify({ component: 'opencode-service', event: 'task_service_prepared', ...receipt }))
    } catch (error) {
      if (signal.aborted) throw signal.reason
      console.error(JSON.stringify({ component: 'opencode-service', event: 'task_service_prepare_failed', reason: error instanceof PrepareError ? error.code : 'unknown', promptSubmissions: 0 }))
      throw new OpenCodeServerError(error instanceof PrepareError ? 'OpenCode service preparation failed: ' + error.code : 'OpenCode service preparation failed.')
    }
  } : undefined)
}

export function failureOutput(error: unknown, contextId: string): DelegateOutput {
  return {
    status: 'failed',
    context_id: contextId,
    error: error instanceof Error ? error.message : 'OpenCode task failed.',
    ...(error instanceof OpenCodeServerError && { error_code: error.errorCode }),
    ...(error instanceof DelegationError && error.errorCode && { error_code: error.errorCode }),
    ...(error instanceof ContextStoreError && { error_code: error.errorCode ?? 'context_store_failed' }),
  }
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
}

if (isMainModule()) {
  const config = loadConfig()
  const serverManager = new OpenCodeServerManager({
    ...(config.serviceRegistryFile && { registryFile: config.serviceRegistryFile }),
  })
  const delegator = createDelegator(serverManager, config)
  const server = createMcpServer({ config, serverManager, delegator })
  const handle = serveStdio(() => server, {
    onerror: (error) => console.error(JSON.stringify({ component: 'mcp-server', event: 'stdio_error', message: error.message })),
  })
  let shutdown: Promise<void> | undefined
  const close = () => {
    shutdown ??= shutdownTogether({
      beginShutdown: (deadline) => { delegator.beginShutdown(deadline) },
      closeTransport: () => handle.close(),
      closeTasks: (deadline) => delegator.close(deadline),
    }).then((result) => {
      if (result.status !== 'closed') {
        console.error(JSON.stringify({ component: 'mcp-server', event: 'shutdown_failed', status: result.status, failures: result.failures }))
        process.exit(1)
      }
    })
  }
  process.stdin.once('end', close)
  process.stdin.once('close', close)
  process.once('SIGINT', close)
  process.once('SIGTERM', close)
}
