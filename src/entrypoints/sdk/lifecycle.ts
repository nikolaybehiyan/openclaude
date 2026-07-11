import { runCleanupFunctions } from '../../utils/cleanupRegistry.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'

export async function unstable_shutdownRuntime(): Promise<void> {
  await SandboxManager.reset()
  await runCleanupFunctions()
}
