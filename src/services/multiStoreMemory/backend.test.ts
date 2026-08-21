import { afterEach, describe, expect, test } from 'bun:test'
import axios, { type AxiosRequestConfig } from 'axios'
import {
  MemoryConflictError,
  MemoryNotFoundError,
  MemoryServiceBackend,
  MemoryServiceError,
} from './backend.js'
import type { MemoryStoreConfig } from './config.js'

const originalRequest = axios.request
const originalOauthUrl = process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL
const originalSessionToken = process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN

const rwStore: MemoryStoreConfig = {
  path: '/v1/code/memory/partitions/team',
  mode: 'rw',
  scope: 'team',
  mount: 'team',
}

afterEach(() => {
  axios.request = originalRequest
  if (originalOauthUrl === undefined) {
    delete process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL
  } else {
    process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL = originalOauthUrl
  }
  if (originalSessionToken === undefined) {
    delete process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN
  } else {
    process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN = originalSessionToken
  }
})

function setupBackend(): MemoryServiceBackend {
  process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL = 'https://ai.darbmind.ru'
  process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN = 'test-session-token'
  return new MemoryServiceBackend(rwStore)
}

describe('Claude Tag memory service backend', () => {
  test('paginates list requests and keeps session ingress auth', async () => {
    const requests: AxiosRequestConfig[] = []
    axios.request = (async (config: AxiosRequestConfig) => {
      requests.push(config)
      const page = (config.params as Record<string, unknown> | undefined)?.page
      return page
        ? {
            status: 200,
            data: {
              data: [
                {
                  type: 'memory',
                  id: 'mem_B',
                  path: '/b.md',
                  content_sha256: 'sha-b',
                },
              ],
            },
          }
        : {
            status: 200,
            data: {
              data: [
                {
                  type: 'memory_metadata',
                  id: 'mem_A',
                  path: '/a.md',
                  content_sha256: 'sha-a',
                },
              ],
              next_page: 'next',
            },
          }
    }) as typeof axios.request

    const entries = await setupBackend().list()
    expect(entries.map(entry => entry.id)).toEqual(['mem_A', 'mem_B'])
    expect(requests).toHaveLength(2)
    expect(requests[0]?.url).toBe(
      'https://ai.darbmind.ru/v1/code/memory/partitions/team/memories',
    )
    expect(requests[0]?.headers).toMatchObject({
      Authorization: 'Bearer test-session-token',
    })
  })

  test('sends the content SHA precondition on update', async () => {
    let request: AxiosRequestConfig | undefined
    axios.request = (async (config: AxiosRequestConfig) => {
      request = config
      return {
        status: 200,
        data: { id: 'mem_A', content_sha256: 'sha-new' },
      }
    }) as typeof axios.request

    const saved = await setupBackend().update(
      { id: 'mem_A', path: '/a.md', sha256: 'sha-old' },
      'new content',
    )
    expect(saved.sha256).toBe('sha-new')
    expect(request?.data).toEqual({
      content: 'new content',
      precondition: {
        type: 'content_sha256',
        content_sha256: 'sha-old',
      },
    })
  })

  test('rejects local mutation attempts on read-only stores', async () => {
    const backend = setupBackend()
    const readOnly = new MemoryServiceBackend({ ...rwStore, mode: 'ro' })
    expect(backend.mode).toBe('rw')
    await expect(readOnly.create('/a.md', 'content')).rejects.toBeInstanceOf(
      MemoryServiceError,
    )
  })

  test('trusts a create conflict id only when its path matches', async () => {
    axios.request = (async () => ({
      status: 409,
      data: {
        error: {
          conflicting_memory_id: 'mem_A',
          conflicting_path: '/different.md',
        },
      },
    })) as typeof axios.request

    try {
      await setupBackend().create('/target.md', 'content')
      throw new Error('expected conflict')
    } catch (error) {
      expect(error).toBeInstanceOf(MemoryConflictError)
      expect((error as MemoryConflictError).existingId).toBeUndefined()
    }
  })

  test('surfaces conditional delete 404 as a stale basis', async () => {
    axios.request = (async () => ({ status: 404, data: {} })) as typeof axios.request
    await expect(
      setupBackend().delete({ id: 'mem_A', path: '/a.md', sha256: 'old' }),
    ).rejects.toBeInstanceOf(MemoryNotFoundError)
  })

  test('maps proven permanent memory-service rejections to 2.1.221 reasons', async () => {
    axios.request = (async () => ({
      status: 400,
      data: {
        error: {
          type: 'invalid_request_error',
          message: 'content must be at most 102400 bytes',
        },
      },
    })) as typeof axios.request

    try {
      await setupBackend().create('/a.md', 'content')
      throw new Error('expected service error')
    } catch (error) {
      expect(error).toBeInstanceOf(MemoryServiceError)
      expect((error as MemoryServiceError).permanent).toBe(true)
      expect((error as MemoryServiceError).reason).toBe('content_too_large')
    }
  })
})
