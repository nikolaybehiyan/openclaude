import { expect, test } from 'bun:test'

import { isBundledBunRuntime } from './bundledMode.js'

test('detects a compiled Bun executable without embedded asset files', () => {
  expect(
    isBundledBunRuntime({
      embeddedFiles: [],
      main: '/$bunfs/root/openclaude',
    }),
  ).toBe(true)
})

test('detects a compiled Bun executable with embedded asset files', () => {
  expect(
    isBundledBunRuntime({
      embeddedFiles: [new Blob(['asset'])],
      main: '/$bunfs/root/openclaude',
    }),
  ).toBe(true)
})

test('does not classify an ordinary Bun source invocation as bundled', () => {
  expect(
    isBundledBunRuntime({
      embeddedFiles: [],
      main: '/workspace/openclaude/src/entrypoints/cli.ts',
    }),
  ).toBe(false)
})
