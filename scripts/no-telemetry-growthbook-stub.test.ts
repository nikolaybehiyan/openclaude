import { describe, expect, test } from 'bun:test'
import type { BunPlugin } from 'bun'
import { noTelemetryPlugin } from './no-telemetry-plugin'

describe('no-telemetry build profile', () => {
  test('retains the real GrowthBook control-plane module', () => {
    const intercepted: RegExp[] = []
    const build = {
      onLoad(options: { filter: RegExp }) {
        intercepted.push(options.filter)
      },
    }

    noTelemetryPlugin.setup(build as unknown as Parameters<BunPlugin['setup']>[0])

    const growthBookPath = '/repo/src/services/analytics/growthbook.ts'
    expect(intercepted.some(filter => filter.test(growthBookPath))).toBe(false)
  })

  test('continues to stub product telemetry transports', () => {
    const intercepted: RegExp[] = []
    const build = {
      onLoad(options: { filter: RegExp }) {
        intercepted.push(options.filter)
      },
    }

    noTelemetryPlugin.setup(build as unknown as Parameters<BunPlugin['setup']>[0])

    const eventLoggerPath = '/repo/src/services/analytics/firstPartyEventLogger.ts'
    expect(intercepted.some(filter => filter.test(eventLoggerPath))).toBe(true)
  })
})
