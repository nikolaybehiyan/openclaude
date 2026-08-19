import { afterEach, describe, expect, test } from 'bun:test'
import { verifyDesignProjectIdentity } from './projectIdentity.js'

const previousCustomOAuthURL = process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL

afterEach(() => {
  if (previousCustomOAuthURL === undefined) {
    delete process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL
  } else {
    process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL = previousCustomOAuthURL
  }
})

describe('ClaudeDesign durable-grant project identity', () => {
  test('accepts only a canonical first-party project URL and known sharing scope', () => {
    process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL = 'https://ai.darbmind.ru'
    expect(
      verifyDesignProjectIdentity('project-1', [
        {
          type: 'text',
          text: JSON.stringify({
            name: 'Acme Design',
            url: 'https://ai.darbmind.ru/design/p/project-1',
            sharing: { scope: 'org' },
          }),
        },
      ]),
    ).toEqual({
      name: 'Acme Design',
      sharingLabel: 'visible to your whole organization',
      url: 'https://ai.darbmind.ru/design/p/project-1',
    })
  })

  test('fails closed for cross-origin, ambiguous-name, and unknown-scope metadata', () => {
    process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL = 'https://ai.darbmind.ru'
    for (const project of [
      {
        name: 'Acme Design',
        url: 'https://attacker.example/design/p/project-1',
        sharing: { scope: 'org' },
      },
      {
        name: 'Acme — Design',
        url: 'https://ai.darbmind.ru/design/p/project-1',
        sharing: { scope: 'org' },
      },
      {
        name: 'Acme Design',
        url: 'https://ai.darbmind.ru/design/p/project-1',
        sharing: { scope: 'world' },
      },
    ]) {
      expect(
        verifyDesignProjectIdentity('project-1', [
          { type: 'text', text: JSON.stringify(project) },
        ]),
      ).toBeNull()
    }
  })
})
