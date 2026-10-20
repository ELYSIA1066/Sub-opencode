import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareService, PrepareError, SHARED_REGISTRY, userServiceEnvironment } from '../src/service-bootstrap.js'

export { prepareService, PrepareError, SHARED_REGISTRY, SERVICE_CLI_ROOT, SERVICE_ARGS, selectServiceCli, userServiceEnvironment, listeningOwnerMatches } from '../src/service-bootstrap.js'
export type { PrepareOptions } from '../src/service-bootstrap.js'

async function main(): Promise<void> {
  if (process.argv.length !== 2) throw new PrepareError('maintenance_arguments_not_allowed')
  const result = await prepareService({ registryFile: SHARED_REGISTRY, env: userServiceEnvironment() })
  process.stdout.write(JSON.stringify({ mode: 'service-prepare', ...result, sharedServiceKeptRunning: true }) + '\n', () => process.exit(0))
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(JSON.stringify({ mode: 'service-prepare', code: error instanceof PrepareError ? error.code : 'prepare_failed', promptSubmissions: 0, statePreserved: true }) + '\n', () => process.exit(1))
  })
}
