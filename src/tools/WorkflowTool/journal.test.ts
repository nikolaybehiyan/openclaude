import { expect, test } from 'bun:test'
import { indexWorkflowJournal, workflowInvocationKey, type WorkflowJournalRecord } from './journal.js'

test('unfinished attempts stay retryable while falsy completed results stay cached', () => {
  const records: WorkflowJournalRecord[] = [
    {type: 'started', key: 'unfinished', agentId: 'a1'},
    {type: 'started', key: 'unfinished', agentId: 'a2'},
  ]
  for (const [index, result] of [false, 0, '', [], {}].entries()) records.push({type: 'result', key: String(index), agentId: 'completed', result})
  const state = indexWorkflowJournal(records)
  expect(state.started.get('unfinished')?.length).toBe(2)
  expect(state.results.has('unfinished')).toBe(false)
  for (const [index, result] of [false, 0, '', [], {}].entries()) expect(state.results.get(String(index))?.result).toEqual(result)
})
test('last committed completion replaces an earlier result for the same invocation', () => {
  const state = indexWorkflowJournal([{type: 'result', key: 'k', agentId: 'a', result: 1}, {type: 'result', key: 'k', agentId: 'b', result: 2}])
  expect(state.results.get('k')?.result).toBe(2)
})
test('v2 identity pins prompt, call site and execution options, not labels', () => {
  const baseline = workflowInvocationKey('review', {model: 'glm', schema: {b: 1, a: 2}, effort: 'xhigh'}, 'call-1')
  expect(workflowInvocationKey('review', {schema: {a: 2, b: 1}, effort: 'xhigh', model: 'glm', label: 'new title'}, 'call-1')).toBe(baseline)
  for (const [prompt, options, site] of [['other', {model: 'glm'}, 'call-1'], ['review', {model: 'qwen'}, 'call-1'],
    ['review', {model: 'glm', effort: 'high'}, 'call-1'], ['review', {model: 'glm'}, 'call-2']] as const) {
    expect(workflowInvocationKey(prompt, options, site)).not.toBe(baseline)
  }
})
