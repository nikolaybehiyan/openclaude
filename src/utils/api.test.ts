import { expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { getEmptyToolPermissionContext, type Tool, type Tools } from '../Tool.js'
import { SkillTool } from '../tools/SkillTool/SkillTool.js'
import { splitSysPromptPrefix, toolToAPISchema } from './api.js'
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '../constants/prompts.js'
import { asSystemPrompt, selectSystemPromptSections } from './systemPromptType.js'

test('SDK multipart system prompt reaches API blocks without nested arrays or boundary text', () => {
  const sections = ['COWORK_STATIC', SYSTEM_PROMPT_DYNAMIC_BOUNDARY, 'DEVICE_DYNAMIC']
  const prompt = asSystemPrompt([...selectSystemPromptSections(sections, ['CODE_DEFAULT']), 'PROJECT'])
  const blocks = splitSysPromptPrefix(prompt)
  expect(blocks.every(block => typeof block.text === 'string')).toBe(true)
  const text = blocks.map(block => block.text).join('\n\n')
  expect(text).toContain('COWORK_STATIC')
  expect(text).toContain('DEVICE_DYNAMIC')
  expect(text).toContain('PROJECT')
  expect(text).not.toContain('CODE_DEFAULT')
  expect(text).not.toContain(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
  expect(text.indexOf('COWORK_STATIC')).toBeLessThan(text.indexOf('DEVICE_DYNAMIC'))
  expect(text.indexOf('DEVICE_DYNAMIC')).toBeLessThan(text.indexOf('PROJECT'))
})

test('toolToAPISchema preserves provider-specific schema keywords in input_schema', async () => {
  const schema = await toolToAPISchema(
    {
      name: 'WebFetch',
      inputSchema: z.strictObject({}),
      inputJSONSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            format: 'uri',
            description: 'Public HTTP or HTTPS URL',
          },
          metadata: {
            type: 'object',
            propertyNames: {
              pattern: '^[a-z]+$',
            },
            properties: {
              callback: {
                type: 'string',
                format: 'uri-reference',
              },
            },
          },
        },
      },
      prompt: async () => 'Fetch a URL',
    } as unknown as Tool,
    {
      getToolPermissionContext: async () => getEmptyToolPermissionContext(),
      tools: [] as unknown as Tools,
      agents: [],
    },
  )

  expect(schema).toMatchObject({
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          format: 'uri',
          description: 'Public HTTP or HTTPS URL',
        },
        metadata: {
          type: 'object',
          propertyNames: {
            pattern: '^[a-z]+$',
          },
          properties: {
            callback: {
              type: 'string',
              format: 'uri-reference',
            },
          },
        },
      },
    },
  })
})

test('toolToAPISchema keeps MCP Apps metadata internal', async () => {
  const schema = await toolToAPISchema(
    {
      name: 'mcp__test__show_widget',
      inputSchema: z.strictObject({}),
      inputJSONSchema: { type: 'object', properties: {} },
      _meta: { ui: { resourceUri: 'ui://test/widget.html' } },
      prompt: async () => 'Show a widget',
    } as unknown as Tool,
    {
      getToolPermissionContext: async () => getEmptyToolPermissionContext(),
      tools: [] as unknown as Tools,
      agents: [],
    },
  )

  expect((schema as Record<string, unknown>)._meta).toBeUndefined()
})

test('toolToAPISchema keeps skill required for SkillTool', async () => {
  const schema = await toolToAPISchema(SkillTool, {
    getToolPermissionContext: async () => getEmptyToolPermissionContext(),
    tools: [] as unknown as Tools,
    agents: [],
  })

  expect((schema as { input_schema: unknown }).input_schema).toMatchObject({
    type: 'object',
    required: ['skill'],
  })
})

test('toolToAPISchema removes extra required keys not in properties (MCP schema sanitization)', async () => {
  const schema = await toolToAPISchema(
    {
      name: 'mcp__test__create_object',
      inputSchema: z.strictObject({}),
      inputJSONSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
        required: ['name', 'attributes'],
      },
      prompt: async () => 'Create an object',
    } as unknown as Tool,
    {
      getToolPermissionContext: async () => getEmptyToolPermissionContext(),
      tools: [] as unknown as Tools,
      agents: [],
    },
  )

  const inputSchema = (schema as { input_schema: { required?: string[] } }).input_schema
  expect(inputSchema.required).toEqual(['name'])
})
