import { homedir } from 'node:os'
import { readFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

export type ServiceIdentity = { id: string; pid: number; url: string }

/** Only stable release versions are eligible for automatic service preparation. */
export function stableVersion(value: string): number[] | undefined {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(value)) return undefined
  const parts = value.split('.').map(Number)
  return parts.every(Number.isSafeInteger) ? parts : undefined
}

let clientVersion: string | undefined
export function installedClientVersion(): string {
  if (clientVersion) return clientVersion
  let directory = dirname(fileURLToPath(import.meta.resolve('@opencode/client')))
  while (true) {
    const file = join(directory, 'package.json')
    if (existsSync(file)) {
      const metadata = JSON.parse(readFileSync(file, 'utf8')) as { name?: string; version?: string }
      if (metadata.name === '@opencode/client') {
        if (!metadata.version || !stableVersion(metadata.version)) throw new Error('sdk_version_unavailable')
        return clientVersion = metadata.version
      }
    }
    const parent = dirname(directory)
    if (parent === directory) throw new Error('sdk_version_unavailable')
    directory = parent
  }
}

/** Compatibility follows the installed SDK major; no service release is pinned. */
export function isCompatibleServiceVersion(version: string, sdkVersion = installedClientVersion()): boolean {
  const service = stableVersion(version)
  const sdk = stableVersion(sdkVersion)
  return Boolean(service && sdk && service[0] === sdk[0])
}

export function defaultRegistryFile(env: NodeJS.ProcessEnv = process.env): string {
  const stateHome = env.XDG_STATE_HOME?.trim() || join(homedir(), '.local', 'state')
  return join(stateHome, 'opencode', 'service.json')
}

export function registryPathHash(path: string): string {
  return createHash('sha256').update(resolve(path)).digest('hex')
}

/** Fresh: explicit > environment > default. Resume: manifest; never inherited XDG. */
export function resolveRegistryPath(options: {
  explicit?: string
  env?: NodeJS.ProcessEnv
  manifest?: { sharedRegistryPath: string; sharedRegistryPathHash?: string }
} = {}): string {
  const { explicit, manifest } = options
  if (manifest) {
    const path = manifest.sharedRegistryPath
    if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path
      || (manifest.sharedRegistryPathHash !== undefined && registryPathHash(path) !== manifest.sharedRegistryPathHash)) {
      throw new Error('registry_manifest_path_invalid')
    }
    if (explicit !== undefined && resolve(explicit) !== path) throw new Error('registry_path_conflict')
    return path
  }
  const env = options.env ?? process.env
  return resolve(explicit ?? (env.OPENCODE_SERVICE_REGISTRY_FILE?.trim() || defaultRegistryFile(env)))
}

export async function readRegistryIdentity(file: string, url: string): Promise<ServiceIdentity | undefined> {
  const record = await readRegistryRecord(file)
  return record !== undefined && record.url === url ? record : undefined
}

export async function readRegistryRecord(file: string): Promise<ServiceIdentity | undefined> {
  try {
    const record = JSON.parse(await readFile(file, 'utf8')) as unknown
    if (!isRegistryRecord(record)) return undefined
    return { id: record.id, pid: record.pid, url: record.url }
  } catch { return undefined }
}

export function isRegistryRecord(value: unknown): value is { id: string; pid: number; url: string; version: string } {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string' && record.id.length > 0
    && typeof record.pid === 'number' && Number.isSafeInteger(record.pid) && record.pid > 0
    && typeof record.version === 'string' && typeof record.url === 'string' && isLoopbackUrl(record.url)
}

export function sameIdentity(left: ServiceIdentity, right: ServiceIdentity): boolean {
  return left.id === right.id && left.pid === right.pid && left.url === right.url
}

function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)
  } catch { return false }
}
