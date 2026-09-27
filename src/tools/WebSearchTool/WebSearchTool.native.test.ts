import { afterAll, expect, mock, test } from 'bun:test'

const deepSeek = 'claude-darb-alibaba-deepseek-v4-pro'
const qwen = 'claude-darb-alibaba-qwen3-8-max'
const models = [deepSeek, qwen].map(id => ({id, display_name: id, type: 'model',
  native_parameters: {version: 1, thinking_types: ['disabled', 'enabled'], effort_values: []}}))
const originalModels = await import('../../utils/model/darbModels.js')
mock.module('../../utils/model/darbModels.js', () => ({...originalModels,
  currentDarbCatalog: () => ({mode: 'default', models})}))
const originalProvider = await import('../../utils/model/providers.js')
mock.module('../../utils/model/providers.js', () => ({...originalProvider, getAPIProvider: () => 'firstParty'}))
const originalAPI = await import('../../services/api/claude.js')
let sent: any
mock.module('../../services/api/claude.js', () => ({...originalAPI,
  queryModelWithStreaming: async function* (request: any) {
    sent = request
    yield {type: 'assistant', message: {content: [
      {type: 'web_search_tool_result', tool_use_id: 'search1', content: [
        {type: 'web_search_result', title: 'Official', url: 'https://kubernetes.io/docs/'},
        {type: 'web_search_result', title: 'Excluded', url: 'https://other.example/'},
      ]},
      {type: 'text', text: 'Unfiltered provider summary'},
    ]}}
  },
}))
afterAll(() => mock.restore())
const {WebSearchTool} = await import('./WebSearchTool.js')

test('native tool sends only its search through Qwen, retains filters and leaves the main session unchanged', async () => {
  const context: any = {
    abortController: new AbortController(),
    options: {mainLoopModel: deepSeek, thinkingConfig: {type: 'enabled', budgetTokens: 8192},
      agentDefinitions: {activeAgents: []}},
    getAppState: () => ({toolPermissionContext: {}, effortValue: 'max'}),
  }
  const original = JSON.stringify(context.options)
  const result = await WebSearchTool.call({query: 'Kubernetes HPA', allowed_domains: ['kubernetes.io']}, context, undefined as any, undefined as any)
  expect(sent.options.model).toBe(qwen)
  expect(sent.thinkingConfig).toEqual({type: 'disabled'})
  expect(sent.options.effortValue).toBeUndefined()
  expect(sent.options.extraToolSchemas[0].allowed_domains).toEqual(['kubernetes.io'])
  expect(sent.messages[0].message.content).toContain('Kubernetes HPA')
  expect(JSON.stringify(context.options)).toBe(original)
  expect(JSON.stringify(result.data)).toContain('https://kubernetes.io/docs/')
  expect(JSON.stringify(result.data)).not.toContain('https://other.example/')
  expect(JSON.stringify(result.data)).not.toContain('Unfiltered provider summary')
})
