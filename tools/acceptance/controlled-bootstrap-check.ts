import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { prepareCase3Run } from './case3-live.js'
import { makeIsolatedEnvironment, McpStdioClient } from './runtime.js'

/** No tool call: validates the actual isolated test executable and shutdown. */
export async function checkControlledBootstrap(runId: string) {
  const prepared = await prepareCase3Run(runId)
  const { manifest, identity, manager, ledgerPath, evidenceDir, repoRoot } = prepared
  const ledger = readFileSync(ledgerPath)
  const path = join(manifest.tempRoot, 'controlled-bootstrap-config.json')
  const bytes = JSON.stringify({ mode: 'case3-controlled', workspace: manifest.workspaceRoot,
    seeds: [join(manifest.workspaceRoot, 'unused-a'), join(manifest.workspaceRoot, 'unused-b')], marker: 'unused-marker', identity })
  const client = new McpStdioClient('controlled-bootstrap', repoRoot,
    { ...makeIsolatedEnvironment(manifest.tempRoot), OPENCODE_SERVICE_REGISTRY_FILE: identity.registryPath },
    { entrypoint: 'tools/acceptance/controlled-mcp.ts', args: [path] })
  let passed = false
  try {
    writeFileSync(path, bytes, { flag: 'wx' })
    await client.start(); await client.close(); await manager.assertIdentity(identity)
    passed = client.exited && client.exitCode === 0 && readFileSync(ledgerPath).equals(ledger)
    if (passed && readFileSync(path, 'utf8') === bytes) unlinkSync(path)
    writeFileSync(join(evidenceDir, 'controlled-bootstrap.json'), JSON.stringify({ promptSubmissions: 0, passed,
      pid: client.pid, exited: client.exited, exitCode: client.exitCode, sharedIdentity: identity, budgetUnchanged: readFileSync(ledgerPath).equals(ledger) }, null, 2), { flag: 'wx' })
    return { passed }
  } finally { await client.close(); await manager.close() }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  checkControlledBootstrap(process.argv[2]!).then((result) => { console.log(JSON.stringify(result)); process.exit(result.passed ? 0 : 1) }, () => { console.error('controlled_bootstrap_failed'); process.exit(1) })
}
