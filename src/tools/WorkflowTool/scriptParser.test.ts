import { expect, test } from 'bun:test'
import { MAX_WORKFLOW_SCRIPT_LENGTH, parseWorkflowScript } from './scriptParser.js'

const metadata = "export const meta = {name:'review', description:'Review changes'};"
test('metadata is the first statement, comments allowed, body retained', () => {
  expect(parseWorkflowScript(`// hello\n${metadata}\nreturn await agent('review')`)).toEqual({
    meta: {name: 'review', description: 'Review changes', title: undefined, whenToUse: undefined, phases: undefined},
    scriptBody: "return await agent('review')",
  })
  for (const before of ["'use strict';", ';', 'let x=1;']) expect(parseWorkflowScript(before + metadata)).toHaveProperty('error')
})
test('metadata never executes calls, getters, spreads or prototype pollution', () => {
  for (const property of ["name:run()", "get name(){return 'x'}", "...injected", "['name']:'x'",
    "name:`${run()}`", "__proto__:{}", "nested:{constructor:'x'}", 'nested:[,1]']) {
    expect(parseWorkflowScript(`export const meta = {description:'d',${property}}`)).toHaveProperty('error')
  }
})
test('metadata optional phases normalize without inventing requirements', () => {
  expect(parseWorkflowScript("export const meta={name:'n',description:'d',title:'',whenToUse:'',phases:[null,{}, {title:'',detail:3,model:'m'}]};return 0")).toEqual({
    meta: {name: 'n', description: 'd', title: undefined, whenToUse: '', phases: [{title: '', detail: undefined, model: 'm'}]}, scriptBody: 'return 0',
  })
})
test('oversized and TypeScript scripts are rejected at parse time', () => {
  expect(parseWorkflowScript(' '.repeat(MAX_WORKFLOW_SCRIPT_LENGTH + 1))).toEqual({error: `Script exceeds ${MAX_WORKFLOW_SCRIPT_LENGTH} bytes`})
  expect(parseWorkflowScript(metadata + '\nconst x: number = 1')).toHaveProperty('error')
})
