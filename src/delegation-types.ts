import type { PermissionScope } from './permission-policy.js'

export type DelegateInput = {
  task: string
  workspace_root: string
  context_id?: string
  model?: string
  permission_scope: PermissionScope
}

export type DelegateOutput = {
  status: 'completed' | 'failed' | 'rejected' | 'canceled'
  context_id: string
  session_id?: string
  result?: string
  error?: string
  error_code?: string
  server_url?: string
  attach_command?: string
}

export class DelegationError extends Error {
  constructor(message: string, options?: ErrorOptions, readonly errorCode?: string) {
    super(message, options)
    this.name = 'DelegationError'
  }
}
