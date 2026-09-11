import type { DesignMcpTool } from '../../services/design/types.js'

type ArrayRule =
  | 'string'
  | { fields: Set<string>; required: Set<string> }

type OperationSchema = {
  top: Set<string>
  arrays?: Record<string, ArrayRule>
  scalarEnums?: Record<
    string,
    Set<string> | { accepts: Set<string>; serverNormalizes: true }
  >
}

export const KNOWN_OPERATIONS: Record<
  string,
  { readOnly: boolean; destructive: boolean }
> = {
  list_design_systems: { readOnly: true, destructive: false },
  get_claude_design_prompt: { readOnly: true, destructive: false },
  list_projects: { readOnly: true, destructive: false },
  get_project: { readOnly: true, destructive: false },
  list_files: { readOnly: true, destructive: false },
  read_file: { readOnly: true, destructive: false },
  get_conversation: { readOnly: true, destructive: false },
  list_members: { readOnly: true, destructive: false },
  render_preview: { readOnly: false, destructive: false },
  create_project: { readOnly: false, destructive: false },
  put_conversation: { readOnly: false, destructive: false },
  finalize_plan: { readOnly: false, destructive: false },
  write_files: { readOnly: false, destructive: false },
  copy_files: { readOnly: false, destructive: false },
  create_support_js: { readOnly: false, destructive: false },
  add_member: { readOnly: false, destructive: false },
  delete_files: { readOnly: false, destructive: true },
  remove_member: { readOnly: false, destructive: true },
  update_member_role: { readOnly: false, destructive: true },
  update_sharing: { readOnly: false, destructive: true },
}

const writeSchemas: Record<string, OperationSchema> = {
  create_project: { top: new Set(['name', 'design_system_id']) },
  put_conversation: {
    top: new Set(['project_id', 'title', 'messages']),
    arrays: {
      messages: {
        fields: new Set(['role', 'content']),
        required: new Set(['role', 'content']),
      },
    },
  },
  finalize_plan: {
    top: new Set(['project_id', 'writes', 'deletes', 'scope']),
    arrays: { writes: 'string', deletes: 'string' },
    scalarEnums: { scope: new Set(['paths', 'project']) },
  },
  write_files: {
    top: new Set(['project_id', 'plan_token', 'files']),
    arrays: {
      files: {
        fields: new Set(['path', 'data', 'local_path', 'encoding', 'if_match']),
        required: new Set(['path']),
      },
    },
  },
  delete_files: {
    top: new Set(['project_id', 'plan_token', 'paths', 'files']),
    arrays: {
      paths: 'string',
      files: {
        fields: new Set(['path', 'if_match']),
        required: new Set(['path']),
      },
    },
  },
  copy_files: {
    top: new Set(['project_id', 'plan_token', 'files']),
    arrays: {
      files: {
        fields: new Set(['src', 'dest', 'src_project_id', 'if_match']),
        required: new Set(['src', 'dest']),
      },
    },
  },
  render_preview: {
    top: new Set(['project_id', 'path', 'render', 'validators']),
    arrays: { validators: 'string' },
  },
  create_support_js: {
    top: new Set(['project_id', 'plan_token', 'path', 'if_match']),
  },
  add_member: {
    top: new Set(['project_id', 'account_uuid', 'email', 'role']),
    scalarEnums: {
      role: {
        accepts: new Set(['viewer', 'commenter', 'editor']),
        serverNormalizes: true,
      },
    },
  },
  update_member_role: {
    top: new Set(['project_id', 'account_uuid', 'role']),
    scalarEnums: {
      role: {
        accepts: new Set(['viewer', 'commenter', 'editor']),
        serverNormalizes: true,
      },
    },
  },
  remove_member: { top: new Set(['project_id', 'account_uuid']) },
  update_sharing: {
    top: new Set(['project_id', 'scope', 'link_permission']),
    scalarEnums: {
      scope: {
        accepts: new Set(['invited', 'org']),
        serverNormalizes: true,
      },
      link_permission: {
        accepts: new Set(['view', 'comment', 'edit']),
        serverNormalizes: true,
      },
    },
  },
}

const readSchemas: Record<string, OperationSchema> = {
  list: { top: new Set(['full']) },
  list_design_systems: { top: new Set() },
  get_claude_design_prompt: {
    top: new Set(['design_system_id', 'project_id']),
  },
  list_projects: { top: new Set() },
  get_project: { top: new Set(['project_id']) },
  list_files: { top: new Set(['project_id', 'path']) },
  read_file: { top: new Set(['project_id', 'path']) },
  get_conversation: { top: new Set(['project_id', 'chat_id']) },
  list_members: { top: new Set(['project_id']) },
}

const discovered = new Map<
  string,
  { readOnly: boolean; destructive: boolean }
>()

export function installDesignCatalog(tools: DesignMcpTool[]): DesignMcpTool[] {
  discovered.clear()
  const accepted: DesignMcpTool[] = []
  for (const tool of tools) {
    if (!tool || typeof tool.name !== 'string') continue
    const known = KNOWN_OPERATIONS[tool.name]
    let readOnly = tool.annotations?.readOnlyHint ?? known?.readOnly ?? false
    let destructive =
      tool.annotations?.destructiveHint ?? known?.destructive ?? true
    if (known) {
      readOnly = readOnly && known.readOnly
      destructive = destructive || known.destructive
    }
    discovered.set(tool.name, { readOnly, destructive })
    accepted.push({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema ?? {},
      annotations: { readOnlyHint: readOnly, destructiveHint: destructive },
    })
  }
  return accepted
}

export function operationMetadata(operation: string) {
  return discovered.get(operation) ?? KNOWN_OPERATIONS[operation]
}

export function resetDesignCatalogForTests(): void {
  discovered.clear()
}

function bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

export function validateDesignOperation(
  operation: string,
  args: Record<string, unknown>,
): string | null {
  const schema = writeSchemas[operation] ?? readSchemas[operation]
  if (!schema) {
    const metadata = discovered.get(operation)
    if (metadata?.readOnly) return null
    if (metadata) {
      return `ClaudeDesign ${operation}: the server reports this operation as write-capable, and this client version can't validate its arguments (it needs a WRITE_OP_SCHEMAS entry). Update Darb to use it.`
    }
    return `ClaudeDesign ${operation}: unrecognized operation. If the server added it recently, call {operation: "list"} first — a read-only operation becomes callable after discovery; a write-tier operation needs a WRITE_OP_SCHEMAS entry in this client.`
  }
  const label = `ClaudeDesign ${operation}`
  if (
    operation === 'finalize_plan' &&
    args.scope === 'project' &&
    (args.writes !== undefined || args.deletes !== undefined)
  ) {
    return `${label}: scope "project" takes no writes/deletes — a project-scoped plan covers every path in the project.`
  }
  for (const [key, value] of Object.entries(args)) {
    if (!schema.top.has(key)) {
      const suggestion = [...schema.top].find(
        candidate => candidate.toLowerCase() === key.toLowerCase(),
      )
      return `${label}: unrecognized argument '${key.slice(0, 60)}'${suggestion ? ` (did you mean '${suggestion}'?)` : ''}. ${schema.top.size ? `Allowed: ${[...schema.top].join(', ')}.` : 'This operation takes no arguments.'}`
    }
    if (!(key in (schema.arrays ?? {})) && value && typeof value === 'object') {
      return `${label}.${key}: must be a scalar (string/bool/number), not ${Array.isArray(value) ? 'an array' : 'an object'}.`
    }
    const limit = key === 'plan_token' ? 65_536 : 4_096
    if (typeof value === 'string' && bytes(value) > limit) {
      return `${label}.${key}: too long (${bytes(value)} bytes; capped at ${limit}).`
    }
    const enumRule = schema.scalarEnums?.[key]
    if (enumRule) {
      const accepted =
        enumRule instanceof Set ? enumRule : enumRule.accepts
      const normalized =
        !(enumRule instanceof Set) && typeof value === 'string'
          ? value.trim().toLowerCase()
          : value
      if (typeof normalized !== 'string' || !accepted.has(normalized)) {
        return `${label}.${key}: must be one of ${[...accepted].map(item => `"${item}"`).join(', ')}${enumRule instanceof Set ? '' : ' (case-insensitive)'}.`
      }
      if (
        !(enumRule instanceof Set) &&
        typeof value === 'string' &&
        value.length > normalized.length + 2
      ) {
        return `${label}.${key}: excess whitespace around the value.`
      }
    }
  }
  for (const [key, rule] of Object.entries(schema.arrays ?? {})) {
    const value = args[key]
    if (value === undefined) continue
    if (!Array.isArray(value)) return `${label}.${key}: must be an array.`
    for (let index = 0; index < value.length; index += 1) {
      const item = value[index]
      if (rule === 'string') {
        if (typeof item !== 'string') {
          return `${label}.${key}[${index}]: must be a string.`
        }
        if (bytes(item) > 4_096) {
          return `${label}.${key}[${index}]: too long (${bytes(item)} bytes; capped at 4096).`
        }
        continue
      }
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return `${label}.${key}[${index}]: must be an object with keys from {${[...rule.fields].join(', ')}}.`
      }
      const object = item as Record<string, unknown>
      for (const required of rule.required) {
        if (typeof object[required] !== 'string') {
          return `${label}.${key}[${index}]: missing required field '${required}'.`
        }
      }
      for (const [field, fieldValue] of Object.entries(object)) {
        if (!rule.fields.has(field)) {
          const suggestion = [...rule.fields].find(
            candidate => candidate.toLowerCase() === field.toLowerCase(),
          )
          return `${label}.${key}[${index}]: unrecognized field '${field.slice(0, 60)}'${suggestion ? ` (did you mean '${suggestion}'?)` : field === 'content' ? " (did you mean 'data'? designmcp's write_files reads 'data', not 'content')" : ''}. Allowed: ${[...rule.fields].join(', ')}.`
        }
        if (typeof fieldValue !== 'string') {
          return `${label}.${key}[${index}].${field}: must be a string (got ${Array.isArray(fieldValue) ? 'array' : typeof fieldValue}).`
        }
        if (field !== 'data' && field !== 'content' && bytes(fieldValue) > 4_096) {
          return `${label}.${key}[${index}].${field}: too long (${bytes(fieldValue)} bytes; non-body fields are capped at 4096).`
        }
      }
    }
  }
  return null
}
