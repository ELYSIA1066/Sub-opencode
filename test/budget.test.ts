import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { tryReserve } from '../tools/acceptance/budget.js'

// Budget privacy regression: the reservation hash is derived from the actual
// task input, while the persisted ledger row only serializes the caller-supplied
// redacted `recordInput`. Every case uses a temporary ledger and never the live
// ledger.

const tempRoots: string[] = []
function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'go-budget-privacy-test-'))
  tempRoots.push(root)
  return root
}

afterEach(() => { for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('budget reservation privacy', () => {
  it('hashes the actual task input but serializes only the redacted recordInput', () => {
    const root = tempRoot()
    const ledger = join(root, 'controlled-budget.ndjson')
    const rawTask = 'RAW_TASK_SECRET_NEVER_IN_LEDGER'
    const rawCommand = 'node -e "RAW_COMMAND_SECRET"'
    const recordInput = {
      model: 'opencode-go/deepseek-v4.1-flash',
      context_id: 'ctx-privacy',
      workspace_root: 'C:/tmp/workspace',
      permission_scope: { fileAccess: 'read_only' },
      approvedCommandHashes: [createHash('sha256').update(rawCommand).digest('hex')],
      taskSHA256: createHash('sha256').update(rawTask).digest('hex'),
    }

    tryReserve(ledger, `${ledger}.lock`, {
      runId: 'offline',
      caseId: 'case-privacy',
      input: { task: rawTask, command: rawCommand },
      recordInput,
    })

    const persisted = readFileSync(ledger, 'utf8')
    expect(persisted).not.toContain(rawTask)
    expect(persisted).not.toContain(rawCommand)

    const rows = persisted.trim().split(/\r?\n/u).map((line) => JSON.parse(line))
    expect(rows).toHaveLength(1)
    expect(rows[0].promptSHA256).toBe(createHash('sha256').update(rawTask).digest('hex'))
    expect(rows[0].input).toEqual(recordInput)
  })
})
