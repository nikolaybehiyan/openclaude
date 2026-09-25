import {expect, test} from 'bun:test'
import {StructuredIO} from './structuredIO.js'

test('host auth control uses request/response correlation and supports cancellation', async () => {
  const io = new StructuredIO((async function* () {})())
  const out = io.outbound[Symbol.asyncIterator]()
  const controller = new AbortController()
  const pending = io.refreshHostAuthToken(controller.signal)
  const message = (await out.next()).value
  expect(message.type).toBe('control_request')
  expect(message.request).toEqual({subtype: 'host_auth_token_refresh'})
  io.injectControlResponse({type: 'control_response', response: {subtype: 'success', request_id: message.request_id,
    response: {authToken: 'darb-native-inference-v2.fixture'}}})
  expect(await pending).toBe('darb-native-inference-v2.fixture')
  const aborted = io.refreshHostAuthToken(controller.signal)
  const second = (await out.next()).value
  expect(second.request_id).not.toBe(message.request_id)
  const rejection = aborted.then(() => false, () => true)
  controller.abort()
  expect(await rejection).toBe(true)
  expect((await out.next()).value).toMatchObject({type: 'control_cancel_request', request_id: second.request_id})
})
