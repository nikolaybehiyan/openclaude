import { expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import React from 'react'
import { createRoot } from '../../ink/root.js'
import instances from '../../ink/instances.js'
import type { DOMElement, DOMNode } from '../../ink/dom.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { SpinnerGlyph } from './SpinnerGlyph.js'
import { Clawd } from '../LogoV2/Clawd.js'

function elements(node: DOMNode): DOMElement[] {
  return node.nodeName === '#text' ? [] : [node, ...node.childNodes.flatMap(elements)]
}
function text(node: DOMNode): string {
  return node.nodeName === '#text' ? node.nodeValue : node.childNodes.map(text).join('')
}

test('terminal Darb mark keeps its shape and cell footprint through highlights, stalls and reduced motion', async () => {
  const stdout = Object.assign(new PassThrough(), {columns: 80, rows: 24, isTTY: true})
  const stdin = Object.assign(new PassThrough(), {isTTY: true, setRawMode() {}, ref() {}, unref() {}})
  stdout.resume()
  const root = await createRoot({stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, patchConsole: false})
  async function render(node: React.ReactNode) {
    root.render(node)
    await Bun.sleep(30)
    const tree = (instances.get(stdout as unknown as NodeJS.WriteStream) as unknown as {rootNode: DOMElement}).rootNode
    expect(text(tree)).toBe('⬡')
    const nodes = elements(tree)
    const glyph = nodes.find(n => n.nodeName === 'ink-text')!
    const box = nodes.find(n => n.nodeName === 'ink-box')!
    return {color: glyph.textStyles?.color, width: box.yogaNode!.getComputedWidth(), height: box.yogaNode!.getComputedHeight()}
  }
  try {
    expect(stringWidth('⬡')).toBe(1)
    const frames = []
    for (const frame of [0, 3, 7, 10, 14]) frames.push(await render(<SpinnerGlyph frame={frame} messageColor="claude" />))
    expect(new Set(frames.map(f => f.color)).size).toBeGreaterThan(1)
    expect(frames[0]).toEqual(frames[4])
    for (const f of frames) expect([f.width, f.height]).toEqual([2, 1])
    const reduced = await render(<SpinnerGlyph frame={0} messageColor="claude" reducedMotion />)
    expect(await render(<SpinnerGlyph frame={7} messageColor="claude" reducedMotion time={5000} />)).toEqual(reduced)
    expect((await render(<SpinnerGlyph frame={3} messageColor="claude" stalledIntensity={1} />)).color).toBe('rgb(171,43,63)')
    for (const pose of ['default', 'arms-up', 'look-left', 'look-right'] as const) {
      const logo = await render(<Clawd pose={pose} />)
      expect([logo.width, logo.height]).toEqual([9, 3])
    }
  } finally {
    root.unmount()
    stdin.end()
    stdout.end()
  }
})
