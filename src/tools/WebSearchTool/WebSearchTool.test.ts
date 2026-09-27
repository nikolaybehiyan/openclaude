import { describe, expect, test } from 'bun:test'
import type { ProviderOutput } from './providers/types.js'
import type { BetaContentBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { __test } from './WebSearchTool.js'

const { buildEmptyAdapterResultHint, formatProviderOutputWithEmptyHint } = __test

describe('native search domain constraints', () => {
  const response = [
    { type: 'text', text: 'Provider preamble about excluded sources' },
    { type: 'server_tool_use', id: 'search1', name: 'web_search', input: { query: 'weather' } },
    { type: 'web_search_tool_result', tool_use_id: 'search1', content: [
      { type: 'web_search_result', title: 'Forecast', url: 'https://weather.example.com/today', encrypted_content: '' },
      { type: 'web_search_result', title: 'Unrelated', url: 'https://other.example.org/', encrypted_content: '' },
      { type: 'web_search_result', title: 'Lookalike', url: 'https://notexample.com/', encrypted_content: '' },
    ] },
    { type: 'text', text: 'Unsupported provider summary based on unrelated results' },
  ] as BetaContentBlock[]

  test('keeps allowed subdomains and drops excluded sources and their generated summaries', () => {
    const out = __test.makeOutputFromSearchResponse(response, {query:'weather', allowed_domains:['example.com']}, 1)
    expect(out.results).toEqual([
      { tool_use_id:'search1', content:[{title:'Forecast',url:'https://weather.example.com/today'}] },
      expect.stringContaining('provider summary were discarded'),
    ])
    expect(JSON.stringify(out)).not.toContain('Provider preamble')
    expect(JSON.stringify(out)).not.toContain('Unsupported provider summary')
    expect(JSON.stringify(out)).not.toContain('notexample.com')
  })

  test('reports no matching sources when the provider ignores the entire allowlist', () => {
    const out = __test.makeOutputFromSearchResponse(response, {query:'weather', allowed_domains:['unmatched.test']}, 1)
    expect(out.results[0]).toEqual({tool_use_id:'search1',content:[]})
    expect(out.results[1]).toContain('no sources matching the requested filters')
    expect(JSON.stringify(out)).not.toContain('https://')
  })

  test('enforces blocked domains on compatible providers', () => {
    const out = __test.makeOutputFromSearchResponse(response, {query:'weather', blocked_domains:['example.com']}, 1)
    expect(out.results[0]).toEqual({tool_use_id:'search1',content:[
      {title:'Unrelated',url:'https://other.example.org/'},
      {title:'Lookalike',url:'https://notexample.com/'},
    ]})
  })

  test('preserves native summaries and links when no constraint is violated', () => {
    const out = __test.makeOutputFromSearchResponse(response, {query:'weather'}, 1)
    expect(out.results[0]).toBe('Provider preamble about excluded sources')
    expect(out.results[1]).toMatchObject({tool_use_id:'search1',content:expect.any(Array)})
    expect(out.results[2]).toBe('Unsupported provider summary based on unrelated results')
    expect(out.query).toBe('weather')
    expect(out.durationSeconds).toBe(1)
  })

  test('preserves server search errors', () => {
    const out = __test.makeOutputFromSearchResponse([
      {type:'web_search_tool_result',tool_use_id:'search1',content:{type:'web_search_tool_result_error',error_code:'too_many_requests'}},
    ] as BetaContentBlock[], {query:'weather',allowed_domains:['example.com']}, 1)
    expect(out.results).toEqual(['Web search error: too_many_requests'])
  })
})

describe('buildEmptyAdapterResultHint', () => {
  test('names the active provider and the failing backend', () => {
    const msg = buildEmptyAdapterResultHint('minimax', 'duckduckgo')
    expect(msg).toContain('minimax')
    expect(msg).toContain('duckduckgo')
  })

  test('includes the actionable env-var list so the user can pick one', () => {
    const msg = buildEmptyAdapterResultHint('moonshot', 'duckduckgo')
    for (const key of [
      'FIRECRAWL_API_KEY',
      'TAVILY_API_KEY',
      'EXA_API_KEY',
      'JINA_API_KEY',
      'BING_API_KEY',
      'MOJEEK_API_KEY',
      'LINKUP_API_KEY',
      'YOU_API_KEY',
    ]) {
      expect(msg).toContain(key)
    }
  })

  test('mentions the native-provider escape hatch', () => {
    const msg = buildEmptyAdapterResultHint('nvidia-nim', 'duckduckgo')
    expect(msg).toMatch(/Anthropic/)
    expect(msg).toMatch(/Vertex/)
    expect(msg).toMatch(/Foundry/)
  })
})

describe('formatProviderOutputWithEmptyHint', () => {
  test('replaces the empty placeholder with a diagnostic when 0 hits', () => {
    const po: ProviderOutput = {
      hits: [],
      providerName: 'duckduckgo',
      durationSeconds: 0.42,
    }
    const out = formatProviderOutputWithEmptyHint(po, 'cat facts', 'minimax')
    expect(out.results.length).toBe(1)
    expect(out.results[0]).toMatch(/^No results from "duckduckgo"/)
    expect(out.durationSeconds).toBe(0.42)
    expect(out.query).toBe('cat facts')
  })

  test('does not mutate the result when hits are present', () => {
    const po: ProviderOutput = {
      hits: [
        {
          title: 'Cats',
          url: 'https://example.com/cats',
          description: 'About cats.',
        },
      ],
      providerName: 'duckduckgo',
      durationSeconds: 1.2,
    }
    const out = formatProviderOutputWithEmptyHint(po, 'cat facts', 'minimax')
    // hits-present case is delegated to the unmodified formatProviderOutput
    // path, so the snippet block + tool_use_id are preserved.
    expect(out.results.length).toBe(2)
    expect(typeof out.results[0]).toBe('string')
    expect(out.results[0]).toContain('Cats')
    expect(out.results[0]).toContain('https://example.com/cats')
  })
})
