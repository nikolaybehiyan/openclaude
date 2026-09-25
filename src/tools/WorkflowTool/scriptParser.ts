import { parse, type Node } from 'acorn'

// Claude Code 2.1.226 metadata contract. Parsing never evaluates the script.
// The upstream string-length limit is preserved here; file readers must also
// enforce the byte limit before decoding a file.
export const MAX_WORKFLOW_SCRIPT_LENGTH = 524288
export type WorkflowPhase = { title: string; detail?: string; model?: string }
export type WorkflowMeta = { name: string; description: string; title?: string; whenToUse?: string; phases?: WorkflowPhase[] }
type AST = Node & Record<string, any>
const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype'])

function literal(node: AST): unknown {
  switch (node.type) {
    case 'Literal': return node.value
    case 'ArrayExpression': return node.elements.map((element: AST | null) => {
      if (element === null) throw Error('sparse arrays not allowed')
      if (element.type === 'SpreadElement') throw Error('spread not allowed in meta')
      return literal(element)
    })
    case 'ObjectExpression': {
      const result: Record<string, unknown> = Object.create(null)
      for (const property of node.properties as AST[]) {
        if (property.type !== 'Property') throw Error('only plain properties allowed in meta')
        if (property.computed) throw Error('computed keys not allowed in meta')
        if (property.method || property.kind !== 'init') throw Error('methods/accessors not allowed in meta')
        const key = property.key as AST
        if (key.type !== 'Identifier' && key.type !== 'Literal') throw Error(`unsupported key type in meta: ${key.type}`)
        const name = key.type === 'Identifier' ? key.name : String(key.value)
        if (forbiddenKeys.has(name)) throw Error(`reserved key name not allowed in meta: ${name}`)
        result[name] = literal(property.value)
      }
      return result
    }
    case 'TemplateLiteral':
      if (node.expressions.length) throw Error('template interpolation not allowed in meta')
      return node.quasis.map((part: AST) => part.value.cooked ?? '').join('')
    case 'UnaryExpression':
      if (node.operator === '-' && node.argument.type === 'Literal' && typeof node.argument.value === 'number') return -node.argument.value
      throw Error('only negative-number unary allowed in meta')
    default: throw Error(`non-literal node type in meta: ${node.type}`)
  }
}

function phases(value: unknown): WorkflowPhase[] | undefined {
  if (!Array.isArray(value)) return undefined
  const result: WorkflowPhase[] = []
  for (const item of value) {
    if (item && typeof item === 'object' && typeof item.title === 'string') {
      result.push({ title: item.title,
        detail: typeof item.detail === 'string' ? item.detail : undefined,
        model: typeof item.model === 'string' ? item.model : undefined })
    }
  }
  return result.length ? result : undefined
}

function parseError(error: unknown, script: string): string {
  const message = error instanceof Error ? error.message : String(error)
  const help = 'Workflow scripts must be plain JavaScript — common causes are TypeScript syntax (type annotations, interfaces, generics) and broken string quoting or escaping.'
  const loc = (error as {loc?: {line?: unknown; column?: unknown}})?.loc
  const line = typeof loc?.line === 'number' && typeof loc.column === 'number' ? script.split('\n')[loc.line - 1] : undefined
  if (line === undefined) return `Script parse error: ${message}. ${help}`
  const column = Math.max(0, Math.min(loc!.column as number, line.length))
  const start = Math.max(0, Math.min(column - 40, line.length - 80))
  return `Script parse error: ${message}\n\n${line.slice(start, start + 80)}\n${' '.repeat(column - start)}^\n\n${help}`
}

export function parseWorkflowScript(script: string): {meta: WorkflowMeta; scriptBody: string} | {error: string} {
  if (script.length > MAX_WORKFLOW_SCRIPT_LENGTH) return {error: `Script exceeds ${MAX_WORKFLOW_SCRIPT_LENGTH} bytes`}
  let ast: AST
  try {
    ast = parse(script, {ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true}) as AST
  } catch (error) { return {error: parseError(error, script)} }
  const first = ast.body[0] as AST | undefined
  const declaration = first?.declaration as AST | undefined
  const variable = declaration?.declarations?.[0] as AST | undefined
  if (first?.type !== 'ExportNamedDeclaration' || declaration?.type !== 'VariableDeclaration' ||
      declaration.kind !== 'const' || declaration.declarations.length !== 1 || variable?.id.type !== 'Identifier' ||
      variable.id.name !== 'meta' || variable.init?.type !== 'ObjectExpression') {
    return {error: '`export const meta = { name, description, phases }` must be the FIRST statement in the script'}
  }
  let meta: Record<string, unknown>
  try { meta = literal(variable.init) as Record<string, unknown> }
  catch (error) { return {error: `meta must be a pure literal: ${error instanceof Error ? error.message : String(error)}`} }
  if (typeof meta.name !== 'string' || !meta.name.length) return {error: 'meta.name must be a non-empty string'}
  if (typeof meta.description !== 'string' || !meta.description.length) return {error: 'meta.description must be a non-empty string'}
  return {meta: {name: meta.name, description: meta.description,
    title: typeof meta.title === 'string' && meta.title.length ? meta.title : undefined,
    whenToUse: typeof meta.whenToUse === 'string' ? meta.whenToUse : undefined, phases: phases(meta.phases)},
    scriptBody: script.slice(first.end).replace(/^[;\s]*\n/, '').trimStart()}
}
