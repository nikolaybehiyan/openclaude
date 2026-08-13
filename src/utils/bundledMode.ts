/**
 * Detects if the current runtime is Bun.
 * Returns true when:
 * - Running a JS file via the `bun` command
 * - Running a Bun-compiled standalone executable
 */
export function isRunningWithBun(): boolean {
  // https://bun.com/guides/util/detect-bun
  return process.versions.bun !== undefined
}

type BunRuntimeIdentity = Pick<typeof Bun, 'embeddedFiles' | 'main'>

export function isBundledBunRuntime(runtime: BunRuntimeIdentity): boolean {
  return (
    (Array.isArray(runtime.embeddedFiles) && runtime.embeddedFiles.length > 0) ||
    runtime.main.startsWith('/$bunfs/')
  )
}

/**
 * Detects if running as a Bun-compiled standalone executable.
 * Compiled Bun programs execute their virtual entry point from /$bunfs/ even
 * when they do not embed any additional asset files. Keep embeddedFiles as a
 * compatible signal for older Bun releases and asset-bearing executables.
 */
export function isInBundledMode(): boolean {
  return typeof Bun !== 'undefined' && isBundledBunRuntime(Bun)
}
