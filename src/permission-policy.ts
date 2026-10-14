import { realpathSync } from 'node:fs'
import path from 'node:path'

export type PermissionScope = {
  fileAccess: 'read_only' | 'workspace_write'
  shellCommands: string[]
}

export type PermissionRequest = {
  action: string
  resource?: string
}

export type OpenCodePermissionRule = {
  action: string
  resource: string
  effect: 'allow' | 'deny' | 'ask'
}

type PathApi = typeof path

export function decidePermission(
  request: PermissionRequest,
  scope: PermissionScope,
  workspaceRoot: string,
): 'allow_once' | 'deny' {
  if (request.action === 'shell') {
    return typeof request.resource === 'string' && request.resource.length > 0 &&
      !/[?*]/.test(request.resource) && scope.shellCommands.includes(request.resource)
      ? 'allow_once'
      : 'deny'
  }

  if (request.action === 'external_directory') return 'deny'
  if (request.action !== 'read' && request.action !== 'edit') return 'deny'
  if (typeof request.resource !== 'string' || request.resource.trim() === '') return 'deny'
  if (request.action === 'edit' && scope.fileAccess !== 'workspace_write') return 'deny'

  const api = pathApi(request.resource)
  const rootApi = pathApi(workspaceRoot)
  if (api !== rootApi || hasTraversal(request.resource, api) || hasTraversal(workspaceRoot, rootApi)) return 'deny'

  const root = resolvePhysical(workspaceRoot, rootApi)
  const target = resolvePhysical(
    api.isAbsolute(request.resource) ? request.resource : api.resolve(workspaceRoot, request.resource),
    api,
  )
  if (!root || !target) return 'deny'
  return isWithin(api.normalize(target), api.normalize(root), api) ? 'allow_once' : 'deny'
}

/** Put a deny-all rule first, then make only supported permission categories ask. */
export function permissionRulesForCall(scope: PermissionScope): OpenCodePermissionRule[] {
  return [
    { action: '*', resource: '*', effect: 'deny' },
    { action: 'read', resource: '*', effect: 'ask' },
    { action: 'edit', resource: '*', effect: scope.fileAccess === 'workspace_write' ? 'ask' : 'deny' },
    { action: 'shell', resource: '*', effect: scope.shellCommands.length > 0 ? 'ask' : 'deny' },
  ]
}

export function lockedPermissionRules(): OpenCodePermissionRule[] {
  return [{ action: '*', resource: '*', effect: 'deny' }]
}

function pathApi(value: string): PathApi {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\') ? path.win32 : path
}

function hasTraversal(value: string, api: PathApi): boolean {
  return value.replace(/[\\/]+/g, '/').split('/').some((part) => part === '..') ||
    (api === path.win32 && value.startsWith('\\\\?\\'))
}

/** Resolve a path physically, including symlinks in existing path components. */
function resolvePhysical(value: string, api: PathApi): string | undefined {
  try {
    const absolute = api.resolve(value)
    let cursor = absolute
    const suffix: string[] = []

    while (true) {
      try {
        const physical = realpathSync.native(cursor)
        return api.resolve(physical, ...suffix.reverse())
      } catch {
        const parent = api.dirname(cursor)
        if (parent === cursor) return undefined
        suffix.push(api.basename(cursor))
        cursor = parent
      }
    }
  } catch {
    return undefined
  }
}

function isWithin(candidate: string, root: string, api: PathApi): boolean {
  const relative = api.relative(root, candidate)
  return relative === '' || (!api.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${api.sep}`))
}
