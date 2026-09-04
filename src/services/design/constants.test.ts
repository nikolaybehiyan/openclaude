import { describe, expect, test } from 'bun:test'
import { designBaseURL } from './constants.js'

describe('Claude Design base URL', () => {
  test('uses the host-owned internal route only for a hosted Web session', () => {
    expect(
      designBaseURL({
        CLAUDE_CODE_CUSTOM_OAUTH_URL: 'https://ai.darbmind.ru',
        CLAUDE_CODE_DESIGN_API_URL:
          'http://projects-service.projects-service.svc.cluster.local:8080/',
        CLAUDE_CODE_REMOTE: '1',
        CLAUDE_CODE_REMOTE_SESSION_ID: 'cse-web',
      }),
    ).toBe('http://projects-service.projects-service.svc.cluster.local:8080')
  })

  test('keeps the public route outside a hosted Web session', () => {
    expect(
      designBaseURL({
        CLAUDE_CODE_CUSTOM_OAUTH_URL: 'https://ai.darbmind.ru',
        CLAUDE_CODE_DESIGN_API_URL:
          'http://projects-service.projects-service.svc.cluster.local:8080',
      }),
    ).toBe('https://api.anthropic.com')
  })

  test('rejects a hosted route containing credentials or a path', () => {
    const hosted = {
      CLAUDE_CODE_CUSTOM_OAUTH_URL: 'https://ai.darbmind.ru',
      CLAUDE_CODE_REMOTE: '1',
      CLAUDE_CODE_REMOTE_SESSION_ID: 'cse-web',
    }
    expect(
      designBaseURL({
        ...hosted,
        CLAUDE_CODE_DESIGN_API_URL: 'https://user:secret@example.test',
      }),
    ).toBe('https://api.anthropic.com')
    expect(
      designBaseURL({
        ...hosted,
        CLAUDE_CODE_DESIGN_API_URL: 'https://example.test/not-an-origin',
      }),
    ).toBe('https://api.anthropic.com')
  })
})
