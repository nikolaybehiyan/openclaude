import { describe, expect, test } from 'bun:test'
import { applySDKLocalPlugins } from './plugins.js'
import { getInlinePlugins, setInlinePlugins } from '../../bootstrap/state.js'

describe('official SDK local plugins', () => {
  test('normalizes local roots and updates the native inline loader only on change', () => {
    const previous = [...getInlinePlugins()]
    try {
      setInlinePlugins([])
      expect(applySDKLocalPlugins([
        { type: 'local', path: '/tmp/plugin-b' },
        { type: 'local', path: '/tmp/plugin-a' },
        { type: 'local', path: '/tmp/plugin-b' },
      ])).toEqual({
        paths: ['/tmp/plugin-a', '/tmp/plugin-b'],
        changed: true,
      })
      expect(getInlinePlugins()).toEqual(['/tmp/plugin-a', '/tmp/plugin-b'])
      expect(applySDKLocalPlugins([
        { type: 'local', path: '/tmp/plugin-a' },
        { type: 'local', path: '/tmp/plugin-b' },
      ])).toEqual({
        paths: ['/tmp/plugin-a', '/tmp/plugin-b'],
        changed: false,
      })
    } finally {
      setInlinePlugins(previous)
    }
  })

  test('rejects malformed local plugin entries', () => {
    expect(() => applySDKLocalPlugins([
      { type: 'local', path: ' ' },
    ])).toThrow('plugins[0].path must be non-empty')
  })
})
