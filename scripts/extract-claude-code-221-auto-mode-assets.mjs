#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const EXPECTED_BINARY_SHA256 =
  'b3ce994579aa07c0344869f9520735907a1e9229186d79efc12c6163cb380711'

function decodeTemplateLiteral(source) {
  // These assets are static template literals embedded in the official binary.
  // Decode JavaScript escapes without evaluating executable JavaScript.
  return source
    .replaceAll('${""}', '')
    .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_match, codePoint) =>
      String.fromCodePoint(Number.parseInt(codePoint, 16)),
    )
    .replace(/\\u([0-9a-fA-F]{4})/g, (_match, codePoint) =>
      String.fromCharCode(Number.parseInt(codePoint, 16)),
    )
    .replace(/\\x([0-9a-fA-F]{2})/g, (_match, codePoint) =>
      String.fromCharCode(Number.parseInt(codePoint, 16)),
    )
    .replaceAll('\\`', '`')
    .replaceAll('\\${', '${')
    .replaceAll('\\n', '\n')
    .replaceAll('\\r', '\r')
    .replaceAll('\\t', '\t')
    .replaceAll('\\\\', '\\')
}

function extractBasePrompt(strings) {
  const prefix = 'function Cqo(){return`'
  const start = strings.indexOf(prefix)
  if (start === -1) throw new Error('Claude Code 2.1.221 base prompt not found')
  const bodyStart = start + prefix.length
  const marker = '<permissions_template>'
  const markerStart = strings.indexOf(marker, bodyStart)
  if (markerStart === -1)
    throw new Error('Claude Code 2.1.221 permissions slot not found')
  return decodeTemplateLiteral(
    strings.slice(bodyStart, markerStart + marker.length),
  )
}

function extractPermissionsTemplate(strings) {
  const moduleStart = strings.indexOf('var Thp=te(function')
  if (moduleStart === -1)
    throw new Error('Claude Code 2.1.221 permissions module not found')
  const exportPrefix = '.exports=`'
  const bodyStart = strings.indexOf(exportPrefix, moduleStart)
  if (bodyStart === -1)
    throw new Error('Claude Code 2.1.221 permissions export not found')
  const contentStart = bodyStart + exportPrefix.length
  const contentEnd = strings.indexOf('`});', contentStart)
  if (contentEnd === -1)
    throw new Error('Claude Code 2.1.221 permissions export end not found')
  return decodeTemplateLiteral(strings.slice(contentStart, contentEnd))
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

const stringsPath = process.argv[2]
const binaryPath = process.argv[3]
if (!stringsPath || !binaryPath) {
  throw new Error(
    'Usage: extract-claude-code-221-auto-mode-assets.mjs <strings.txt> <claude-2.1.221-binary>',
  )
}

const binary = await readFile(resolve(binaryPath))
const binaryHash = sha256(binary)
if (binaryHash !== EXPECTED_BINARY_SHA256) {
  throw new Error(
    `Unexpected Claude Code binary sha256: ${binaryHash}; expected ${EXPECTED_BINARY_SHA256}`,
  )
}

const strings = await readFile(resolve(stringsPath), 'utf8')
const basePrompt = extractBasePrompt(strings)
const permissionsTemplate = extractPermissionsTemplate(strings)

if (!basePrompt.endsWith('<permissions_template>')) {
  throw new Error('Extracted base prompt has an invalid permissions slot')
}
for (const tag of [
  'user_allow_rules_to_replace',
  'user_soft_deny_rules_to_replace',
  'user_hard_deny_rules_to_replace',
  'user_environment_to_replace',
]) {
  if (!permissionsTemplate.includes(`<${tag}>`)) {
    throw new Error(`Extracted permissions template is missing <${tag}>`)
  }
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputDirectory = resolve(
  repositoryRoot,
  'src/utils/permissions/yolo-classifier-prompts',
)
await mkdir(outputDirectory, { recursive: true })
await writeFile(resolve(outputDirectory, 'auto_mode_system_prompt.txt'), basePrompt)
await writeFile(
  resolve(outputDirectory, 'permissions_external.txt'),
  permissionsTemplate,
)

const manifest = {
  source: 'Claude Code 2.1.221 official macOS universal binary',
  binary_sha256: binaryHash,
  assets: {
    'auto_mode_system_prompt.txt': sha256(basePrompt),
    'permissions_external.txt': sha256(permissionsTemplate),
  },
}
await writeFile(
  resolve(outputDirectory, 'claude-code-2.1.221.manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
)

process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`)
