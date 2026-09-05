import { afterEach, beforeEach, expect, test } from 'bun:test'
import { SandboxRuntimeConfigSchema } from '@anthropic-ai/sandbox-runtime'
import {
  getUpstreamProxySandboxNetwork,
  registerUpstreamProxyEnvFn,
  subprocessEnv,
} from './subprocessEnv.js'

let priorRemote: string | undefined
let priorEnabled: string | undefined
beforeEach(() => {
  priorRemote = process.env.CLAUDE_CODE_REMOTE
  priorEnabled = process.env.CCR_UPSTREAM_PROXY_ENABLED
  process.env.CLAUDE_CODE_REMOTE = '1'
  process.env.CCR_UPSTREAM_PROXY_ENABLED = '1'
})
afterEach(() => {
  registerUpstreamProxyEnvFn(() => ({}))
  if (priorRemote === undefined) delete process.env.CLAUDE_CODE_REMOTE
  else process.env.CLAUDE_CODE_REMOTE = priorRemote
  if (priorEnabled === undefined) delete process.env.CCR_UPSTREAM_PROXY_ENABLED
  else process.env.CCR_UPSTREAM_PROXY_ENABLED = priorEnabled
})

test('sandbox HTTP and SOCKS use the same hosted relay as Bash env', () => {
  registerUpstreamProxyEnvFn(() => ({
    HTTPS_PROXY: 'http://127.0.0.1:23456', SSL_CERT_FILE: '/tmp/test-ca.pem',
  }))
  expect(getUpstreamProxySandboxNetwork()).toEqual({
    httpProxyPort: 23456,
    socksProxyPort: undefined,
    parentProxy: { http: 'http://127.0.0.1:23456', https: 'http://127.0.0.1:23456', noProxy: '' },
  })
  expect(subprocessEnv().HTTPS_PROXY).toBe('http://127.0.0.1:23456')
  expect(subprocessEnv().SSL_CERT_FILE).toBe('/tmp/test-ca.pem')
  const config = SandboxRuntimeConfigSchema.parse({
    network: {
      allowedDomains: ['github.com'], deniedDomains: [],
      httpProxyPort: 8888, socksProxyPort: 9999,
      ...getUpstreamProxySandboxNetwork(),
    },
    filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
  })
  expect(config.network.httpProxyPort).toBe(23456)
  expect(config.network.socksProxyPort).toBeUndefined()
  expect(config.network.allowedDomains).toEqual(['github.com'])
  expect(config.network.parentProxy?.https).toBe('http://127.0.0.1:23456')
})

test('local and non-proxy Remote paths do not override sandbox settings', () => {
  registerUpstreamProxyEnvFn(() => { throw new Error('must not read hosted relay') })
  delete process.env.CLAUDE_CODE_REMOTE
  expect(getUpstreamProxySandboxNetwork()).toBeUndefined()
  process.env.CLAUDE_CODE_REMOTE = '1'
  delete process.env.CCR_UPSTREAM_PROXY_ENABLED
  expect(getUpstreamProxySandboxNetwork()).toBeUndefined()
})

test('hosted sandbox fails closed if its initialized relay is unavailable', () => {
  registerUpstreamProxyEnvFn(() => ({}))
  expect(() => getUpstreamProxySandboxNetwork()).toThrow('unavailable')
})

test('only the registered loopback listener can own sandbox network', () => {
  for (const endpoint of [
    'https://127.0.0.1:23456', 'http://example.test:23456', 'http://127.0.0.1',
    'http://user:password@127.0.0.1:23456', 'http://127.0.0.1:23456/path',
    'http://127.0.0.1:23456/?x=1', 'http://127.0.0.1:23456/#fragment',
  ]) {
    registerUpstreamProxyEnvFn(() => ({ HTTPS_PROXY: endpoint, SSL_CERT_FILE: '/tmp/test-ca.pem' }))
    expect(() => getUpstreamProxySandboxNetwork()).toThrow('local listener')
  }
})
