import { spawnSync } from 'node:child_process'

const result = spawnSync(process.execPath, ['--smol', 'run', 'scripts/build.ts', '--cli-only', '--outdir', 'dist/darb'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    OPENCLAUDE_PRODUCT_NAME: 'Darb',
    OPENCLAUDE_DESKTOP_DEEP_LINK_SCHEME: 'darb',
    OPENCLAUDE_CODE_DEEP_LINK_SCHEME: 'darb-cli',
    OPENCLAUDE_CODE_HANDLER_BUNDLE_IDENTIFIER: 'ru.darbmind.darb.desktop.code-url-handler',
    SOURCE_DATE_EPOCH: process.env.SOURCE_DATE_EPOCH || spawnSync(
      'git', ['show', '-s', '--format=%ct', 'HEAD'], { encoding: 'utf8' },
    ).stdout.trim(),
  },
})
if (result.error) throw result.error
process.exitCode = result.status ?? 1
