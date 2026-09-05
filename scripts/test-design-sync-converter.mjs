#!/usr/bin/env node
// Local integration only: no credentials, remote projects, Docker or deployment.
// Dependencies are supplied separately so converter npm packages do not change
// the product lockfile. Keep the disposable result for an IAB render check.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const dependencies = process.argv[2] && resolve(process.argv[2])
if (!dependencies) throw new Error('Usage: node scripts/test-design-sync-converter.mjs <node_modules with esbuild, ts-morph, react, react-dom, @types/react>')
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const assets = join(repo, 'src/skills/bundled/design-sync')
const manifest = JSON.parse(await readFile(join(assets, 'claude-code-2.1.221.manifest.json'), 'utf8'))
const workspace = await mkdtemp(join(tmpdir(), 'design-sync-fixture-'))
await cp(join(repo, 'test/fixtures/design-sync-react'), workspace, { recursive: true })
const scripts = join(workspace, '.ds-sync')
for (const [path, evidence] of Object.entries(manifest.assets)) {
  const text = await readFile(join(assets, path.endsWith('.mjs') ? `${path}.txt` : path), 'utf8')
  assert.equal(createHash('sha256').update(text).digest('hex'), evidence.sha256)
  if (path === 'SKILL.md') continue
  await mkdir(dirname(join(scripts, path)), { recursive: true })
  await writeFile(join(scripts, path), text)
}
await symlink(dependencies, join(scripts, 'node_modules'), 'dir')
await symlink(dependencies, join(workspace, 'node_modules'), 'dir')

for (const path of Object.keys(manifest.assets).filter(path => path.endsWith('.mjs'))) {
  const checked = spawnSync(process.execPath, ['--check', join(scripts, path)], { encoding: 'utf8' })
  assert.equal(checked.status, 0, `${path} has invalid syntax: ${checked.stderr}`)
}

function run(script, args = []) {
  const result = spawnSync(process.execPath, [join(scripts, script), ...args], {
    cwd: workspace, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024,
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.error) throw result.error
  assert.equal(result.status, 0, `${script} failed (workspace ${workspace})`)
}
const buildArgs = ['--config', '.design-sync/config.json', '--node-modules', dependencies,
  '--entry', './dist/index.js', '--out', './ds-bundle']
run('package-build.mjs', buildArgs)
// Structural checks only. Actual browser rendering is verified separately in IAB.
run('package-validate.mjs', ['ds-bundle', '--no-render-check'])
const output = join(workspace, 'ds-bundle')
const bundle = await readFile(join(output, '_ds_bundle.js'), 'utf8')
const header = JSON.parse(/^\/\* @ds-bundle: (.*) \*\//.exec(bundle)[1])
assert.equal(header.namespace, 'ParityFixture')
assert.ok(bundle.includes('DESIGN_SYNC_COMPONENT_PASS'))
assert.ok((await readFile(join(output, 'styles.css'), 'utf8')).includes('@import'))
const meta = JSON.parse(await readFile(join(output, '.ds-build-meta.json'), 'utf8'))
assert.equal(meta.componentCount, 1)
assert.equal(meta.shape, 'package')
const anchor = join(workspace, 'last-upload-anchor.json')
await cp(join(output, '_ds_sync.json'), anchor)
run('lib/remote-diff.mjs', ['--local', output, '--remote', anchor])
let diff = JSON.parse(await readFile(join(output, '.sync-diff.json'), 'utf8'))
assert.equal(diff.upload.any, false, 'Same compiled content must not re-upload')
assert.deepEqual(diff.unchanged, ['ParityButton'])

// A source change must not silently disappear from the upload partition.
const entry = join(workspace, 'dist/index.js')
await writeFile(entry, (await readFile(entry, 'utf8')).replace('DESIGN_SYNC_COMPONENT_PASS', 'DESIGN_SYNC_COMPONENT_UPDATED'))
run('package-build.mjs', buildArgs)
run('lib/remote-diff.mjs', ['--local', output, '--remote', anchor])
diff = JSON.parse(await readFile(join(output, '.sync-diff.json'), 'utf8'))
assert.equal(diff.upload.any, true)
assert.equal(diff.upload.bundle, true)
run('package-validate.mjs', ['ds-bundle', '--no-render-check'])

// Exercise the separate Storybook adapter using a minimal prebuilt index
// fixture. This does not install/run the Storybook app or grade against it.
await cp(join(repo, 'test/fixtures/design-sync-storybook'), workspace, { recursive: true })
const storyBuildArgs = ['--config', '.design-sync/storybook-config.json',
  '--node-modules', dependencies, '--inputs', workspace,
  '--entry', './dist/index.js', '--out', './storybook-bundle']
run('package-build.mjs', storyBuildArgs)
run('package-validate.mjs', ['storybook-bundle', '--no-render-check'])
const storyOutput = join(workspace, 'storybook-bundle')
const storyMeta = JSON.parse(await readFile(join(storyOutput, '.ds-build-meta.json'), 'utf8'))
assert.equal(storyMeta.shape, 'storybook')
assert.equal(storyMeta.componentCount, 1)
const storyMap = JSON.parse(await readFile(join(storyOutput, '.stories-map.json'), 'utf8'))
assert.equal(storyMap.components.length, 1)
const storyComponent = storyMap.components[0]
assert.deepEqual(storyComponent.stories.map(story => [story.exportKey, story.emitted]), [
  ['Primary', 'Primary'], ['Disabled', 'Disabled'], ['CustomRender', 'CustomRender'],
])
assert.ok((await readFile(join(storyOutput, '_vendor/preview-decorators.js'), 'utf8'))
  .includes('STORYBOOK_PROVIDER_PASS'))
const storyAnchor = join(workspace, 'last-storybook-upload-anchor.json')
await cp(join(storyOutput, '_ds_sync.json'), storyAnchor)
run('lib/remote-diff.mjs', ['--local', storyOutput, '--remote', storyAnchor])
assert.equal(JSON.parse(await readFile(join(storyOutput, '.sync-diff.json'), 'utf8')).upload.any, false)
const storyFile = join(workspace, 'stories/ParityButton.stories.tsx')
await writeFile(storyFile, (await readFile(storyFile, 'utf8'))
  .replace('STORYBOOK_CUSTOM_PASS', 'STORYBOOK_CUSTOM_UPDATED'))
run('package-build.mjs', storyBuildArgs)
run('package-validate.mjs', ['storybook-bundle', '--no-render-check'])
run('lib/remote-diff.mjs', ['--local', storyOutput, '--remote', storyAnchor])
const storyDiff = JSON.parse(await readFile(join(storyOutput, '.sync-diff.json'), 'utf8'))
assert.deepEqual(storyDiff.changed, ['ParityButton'], 'Story source edits must invalidate verification')
assert.deepEqual(storyDiff.upload.components, ['ParityButton'])
assert.equal(storyDiff.upload.any, true)
process.stdout.write(`${JSON.stringify({
  result: 'LOCAL_CONVERTER_STRUCTURAL_PASS', workspace, output, storyOutput,
  checked: ['26-asset provenance', 'real React dist bundle', 'CSS import closure', 'component metadata', 'no-change diff', 'changed bundle diff', 'Storybook index adapter', 'three story export pairings', 'preview decorators', 'story source edit invalidates verification'],
  visualVerification: 'NOT_RUN: open the generated component in IAB',
  storybookReferenceGrading: 'NOT_RUN: fixture index only; no reference Storybook app',
}, null, 2)}\n`)
