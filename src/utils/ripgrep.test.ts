import { expect, test } from 'bun:test'
import path from 'path'

import {
  materializePackagedRipgrep,
  resolveRipgrepConfig,
  wrapRipgrepUnavailableError,
} from './ripgrep.js'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const MOCK_BUILTIN_PATH = path.normalize(
  process.platform === 'win32'
    ? `node_modules/@vscode/ripgrep/bin/rg.exe`
    : `node_modules/@vscode/ripgrep/bin/rg`,
)

test('falls back to system rg when @vscode/ripgrep cannot be resolved', () => {
  const config = resolveRipgrepConfig({
    userWantsSystemRipgrep: false,
    bundledMode: false,
    builtinCommand: null,
    systemExecutablePath: '/usr/bin/rg',
    processExecPath: '/fake/bun',
  })

  expect(config).toMatchObject({
    mode: 'system',
    command: 'rg',
    args: [],
  })
})

test('prefers a target-specific packaged rg over compiled-runtime multicall', () => {
  expect(
    resolveRipgrepConfig({
      userWantsSystemRipgrep: false,
      bundledMode: true,
      packagedCommand: '/tmp/openclaude/rg',
      builtinCommand: null,
      systemExecutablePath: 'rg',
      processExecPath: '/tmp/openclaude/claude',
    }),
  ).toEqual({ mode: 'builtin', command: '/tmp/openclaude/rg', args: [] })
})

test('materializes an embedded target rg as an executable', () => {
  const root = mkdtempSync(join(tmpdir(), 'openclaude-packaged-rg-test-'))
  try {
    const embedded = join(root, 'embedded-rg')
    writeFileSync(embedded, 'target-ripgrep')
    const executable = materializePackagedRipgrep(embedded, join(root, 'cache'))
    expect(executable).not.toBeNull()
    expect(readFileSync(executable!, 'utf8')).toBe('target-ripgrep')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('uses builtin @vscode/ripgrep path when the package resolves', () => {
  const config = resolveRipgrepConfig({
    userWantsSystemRipgrep: false,
    bundledMode: false,
    builtinCommand: MOCK_BUILTIN_PATH,
    systemExecutablePath: '/usr/bin/rg',
    processExecPath: '/fake/bun',
  })

  expect(config).toMatchObject({
    mode: 'builtin',
    command: MOCK_BUILTIN_PATH,
    args: [],
  })
})

test('honors USE_BUILTIN_RIPGREP=0 by selecting system rg even when builtin is available', () => {
  const config = resolveRipgrepConfig({
    userWantsSystemRipgrep: true,
    bundledMode: false,
    builtinCommand: MOCK_BUILTIN_PATH,
    systemExecutablePath: '/usr/bin/rg',
    processExecPath: '/fake/bun',
  })

  expect(config).toMatchObject({
    mode: 'system',
    command: 'rg',
    args: [],
  })
})

test('keeps embedded mode for Bun-compiled standalone executables', () => {
  const config = resolveRipgrepConfig({
    userWantsSystemRipgrep: false,
    bundledMode: true,
    builtinCommand: null,
    systemExecutablePath: '/usr/bin/rg',
    processExecPath: '/opt/openclaude/bin/openclaude',
  })

  expect(config).toMatchObject({
    mode: 'embedded',
    command: '/opt/openclaude/bin/openclaude',
    args: ['--no-config'],
    argv0: 'rg',
  })
})

test('falls through to system rg as a last resort even when not on PATH', () => {
  const config = resolveRipgrepConfig({
    userWantsSystemRipgrep: false,
    bundledMode: false,
    builtinCommand: null,
    systemExecutablePath: 'rg',
    processExecPath: '/fake/bun',
  })

  expect(config).toMatchObject({
    mode: 'system',
    command: 'rg',
    args: [],
  })
})

test('wrapRipgrepUnavailableError explains missing packaged fallback', () => {
  const error = wrapRipgrepUnavailableError(
    { code: 'ENOENT', message: 'spawn rg ENOENT' },
    { mode: 'builtin', command: 'C:\\fake\\node_modules\\@vscode\\ripgrep\\bin\\rg.exe', args: [] },
    'win32',
  )

  expect(error.name).toBe('RipgrepUnavailableError')
  expect(error.code).toBe('ENOENT')
  expect(error.message).toContain('packaged ripgrep fallback')
  expect(error.message).toContain('winget install BurntSushi.ripgrep.MSVC')
})

test('wrapRipgrepUnavailableError explains missing system ripgrep', () => {
  const error = wrapRipgrepUnavailableError(
    { code: 'ENOENT', message: 'spawn rg ENOENT' },
    { mode: 'system', command: 'rg', args: [] },
    'linux',
  )

  expect(error.message).toContain('system ripgrep binary was not found on PATH')
  expect(error.message).toContain('apt install ripgrep')
})
