import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { McpStdioClient } from '../tools/acceptance/runtime.js'

it('captures controlled audit from an actual zero-model stdio process', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-audit-regression-'))
  const file = join(root, 'worker.mjs')
  writeFileSync(file, `import { createInterface } from 'node:readline';
const reader = createInterface({ input: process.stdin });
reader.on('line', (line) => {
  const row = JSON.parse(line);
  if (row.method === 'initialize') {
    console.error(JSON.stringify({component:'case3-control',kind:'barrier',complete:true,heldCount:3}));
    console.log(JSON.stringify({jsonrpc:'2.0',id:row.id,result:{protocolVersion:'2025-06-18',capabilities:{},serverInfo:{name:'zero-model-fixture',version:'1'}}}));
  }
});
reader.on('close', () => process.exit(0));`)
  const client = new McpStdioClient('audit-fixture', process.cwd(), process.env, { entrypoint: file, args: [] })
  try {
    await client.start(); await client.close()
    expect(client.exited).toBe(true); expect(client.exitCode).toBe(0)
    expect(client.diagnostics).toContainEqual({ component: 'case3-control', kind: 'barrier', complete: true, heldCount: 3 })
  } finally {
    await client.close()
    if (client.exited) { unlinkSync(file); rmdirSync(root) }
  }
})
