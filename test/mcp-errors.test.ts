import { describe, expect, it } from 'vitest'
import { DelegationError } from '../src/delegation.js'
import { ContextStoreError } from '../src/context-store.js'
import { failureOutput } from '../src/mcp.js'

describe('MCP delegation failures', () => {
  it.each([
    [new DelegationError('busy', undefined, 'context_busy'), 'context_busy'],
    [new ContextStoreError('quarantined', undefined, 'session_quarantined'), 'session_quarantined'],
  ])('preserves the code from a pre-delegation failure', (error, code) => {
    expect(failureOutput(error, 'context-1')).toMatchObject({
      status: 'failed', context_id: 'context-1', error_code: code,
    })
  })
})
