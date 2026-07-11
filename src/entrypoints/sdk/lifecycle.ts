import { runCleanupFunctions } from '../../utils/cleanupRegistry.js'

export async function unstable_shutdownRuntime(): Promise<void> {
  await runCleanupFunctions()
}
