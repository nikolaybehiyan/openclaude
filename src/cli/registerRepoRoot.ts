import { realpath, stat } from 'fs/promises'
import { isAbsolute, relative, sep } from 'path'

export type RegisterRepoRootRequest = {
  directory: string
  reload_claude_md?: boolean
  reload_plugins?: boolean
  reload_skills?: boolean
}

type Directory = { readonly path: string; readonly source: string }

export type RegisterRepoRootContext = {
  cwd: string
  getDirectories: () => ReadonlyMap<string, Directory>
  addDirectory: (directory: string) => void
  refreshSandbox: () => void
  directoryAdded: (directory: string) => void
  reloadClaudeMd: (directory: string) => void
  reloadSkills: () => void
  reloadPlugins: () => Promise<void>
}

function isStrictSubdirectory(directory: string, root: string): boolean {
  const path = relative(root, directory)
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

// Claude Code 2.1.221's register_repo_root contract: registration adds no
// authority outside cwd / launch-time --add-dir roots. Resolve symlinks before
// checking either the target or the roots; session-added directories cannot
// become new launch roots. Repeated registration is an error, not a reload.
export async function registerRepoRoot(
  request: RegisterRepoRootRequest,
  context: RegisterRepoRootContext,
): Promise<{ directory: string }> {
  const cwd = await realpath(context.cwd)
  const directory = await realpath(request.directory)
  if (!(await stat(directory)).isDirectory()) {
    throw new Error(`register_repo_root: ${request.directory} is not a directory`)
  }
  const directories = await Promise.all(
    [...context.getDirectories().values()].map(async value => ({
      source: value.source,
      path: await realpath(value.path).catch(() => value.path),
    })),
  )
  if (directory === cwd) {
    throw new Error(`register_repo_root: ${request.directory} is the current working directory, which is already registered; pass the cloned repo's own directory instead`)
  }
  if (directories.some(value => value.path === directory)) {
    throw new Error(`register_repo_root: ${request.directory} is already a registered working directory`)
  }
  if (!isStrictSubdirectory(directory, cwd) && !directories.some(value =>
    value.source === 'cliArg' && isStrictSubdirectory(directory, value.path),
  )) {
    throw new Error(`register_repo_root: ${request.directory} is not a subdirectory of cwd or of a launch-time --add-dir root`)
  }
  // Another control request may have registered it during realpath I/O.
  if (context.getDirectories().has(directory)) {
    throw new Error(`register_repo_root: ${request.directory} is already a registered working directory`)
  }
  context.addDirectory(directory)
  context.refreshSandbox()
  context.directoryAdded(directory)
  if (request.reload_claude_md) context.reloadClaudeMd(directory)
  if (request.reload_skills) context.reloadSkills()
  if (request.reload_plugins) await context.reloadPlugins()
  return { directory }
}
