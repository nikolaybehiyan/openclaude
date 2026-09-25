import { parse, type Node } from 'acorn'
import { ancestor, full } from 'acorn-walk'
import { Script } from 'node:vm'

// Reserved by the 2.1.226 compiler. This module prepares a script; it does not
// run it or provide a sandbox. Execution requires the complete host/VM membrane
// and the runtime OS sandbox. WORKFLOW_SCRIPTS stays off until both qualify.
const prefix = '__wRg$'
type AST = Node & Record<string, any>

export function rewriteWorkflowAsync(script: string): string {
  const opening = "(async () => {'use strict';\n"
  const ending = '\n})()'
  const wrapped = opening + script + ending
  const ast = parse(wrapped, {ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true})
  full(ast, node => {
    const current = node as AST
    if (current.name?.startsWith(prefix)) throw SyntaxError(`Identifier '${current.name}' is reserved.`)
    if (current.type === 'WithStatement') throw SyntaxError("'with' statements are not supported in workflow scripts.")
    if (current.type === 'ImportExpression') throw SyntaxError('import() is not available in workflow scripts.')
  })
  const edits: [number, string][] = []
  const wrap = (node: Node | null | undefined, helper = prefix, awaitResult = false) => {
    if (node) edits.push([node.start, ` ${awaitResult ? 'await ' : ''}${helper}((`], [node.end, '))'])
  }
  function enclosingFunction(parents: Node[]): AST | undefined {
    return parents.slice(0, -1).reverse().find(node => ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) as AST | undefined
  }
  ancestor(ast, {
    VariableDeclaration(node) {
      if ((node as AST).kind === 'await using') throw SyntaxError("'await using' declarations are not supported in workflow scripts.")
    },
    AwaitExpression: node => wrap(node.argument),
    ArrowFunctionExpression: node => { if (node.async && node.expression) wrap(node.body) },
    ForOfStatement: node => { if (node.await) wrap(node.right, prefix + 'a') },
    ReturnStatement(node, _state, parents) {
      const fn = enclosingFunction(parents)
      if (fn?.async) wrap(node.argument, prefix, fn.generator)
    },
    YieldExpression(node, _state, parents) {
      const fn = enclosingFunction(parents)
      if (fn?.async && fn.generator) wrap(node.argument, node.delegate ? prefix + 'a' : prefix)
    },
  })
  let result = wrapped
  // Stable sorting preserves nesting order for nodes with coincident offsets.
  for (const [offset, value] of edits.sort((a, b) => b[0] - a[0])) result = result.slice(0, offset) + value + result.slice(offset)
  return result.slice(opening.length, -ending.length)
}

export function compileWorkflowScript(script: string): {ok: true; vmScript: Script} | {ok: false; error: string} {
  try {
    // Compile-only syntax validation: never invokes the returned function.
    Function(`async function _check() {'use strict';\n${script}\n}`)
    const body = rewriteWorkflowAsync(script)
    // Async iterator steps and yielded values must pass through the context's
    // Promise resolution path just like explicit await / async returns.
    const adapter = `${prefix}it => ({[Symbol.asyncIterator]() {
      const asyncMethod = ${prefix}it[Symbol.asyncIterator];
      if (asyncMethod != null && typeof asyncMethod !== 'function') throw new TypeError('@@asyncIterator is not a function');
      const iterator = asyncMethod != null ? asyncMethod.call(${prefix}it) : ${prefix}it[Symbol.iterator]();
      if (iterator === null || (typeof iterator !== 'object' && typeof iterator !== 'function')) throw new TypeError('Iterator is not an object');
      const next = iterator.next;
      if (typeof next !== 'function') throw new TypeError('Iterator.next is not a function');
      const close = iterator.return, raise = iterator.throw;
      const step = value => ${prefix}(value).then(value => {
        if (value === null || (typeof value !== 'object' && typeof value !== 'function')) throw new TypeError('Iterator result is not an object');
        const done = value.done;
        return ${prefix}(value.value).then(value => ({value, done}));
      });
      return {next: value => step(next.call(iterator, value)),
        return: value => step(typeof close === 'function' ? close.call(iterator, value) : {value, done: true}),
        throw: error => typeof raise === 'function' ? step(raise.call(iterator, error)) :
          ${prefix}(typeof close === 'function' ? close.call(iterator) : undefined).then(() => {throw new TypeError('The iterator does not provide a throw method')})};
    }})`
    const code = `((${prefix} => ((${prefix}a) => async () => {'use strict';\n${body}\n})(${adapter}))(Promise.resolve.bind(Promise)))()`
    return {ok: true, vmScript: new Script(code, {filename: 'workflow.js', importModuleDynamically: () => {throw Error('import() is not available in workflow scripts.')}})}
  } catch (error) { return {ok: false, error: `SyntaxError: ${error instanceof Error ? error.message : String(error)}`} }
}
