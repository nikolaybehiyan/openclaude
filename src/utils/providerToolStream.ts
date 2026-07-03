import { resolveRouteIdFromBaseUrl } from '../integrations/index.js'

export function isZaiToolStreamCapableGLM(model: string): boolean {
  const normalized = model.trim().toLowerCase().split('/').pop() ?? ''

  if (/^glm[-_.]?5(?:$|[-_.])/.test(normalized)) {
    return true
  }

  const glm4Match = normalized.match(/^glm[-_.]?4[-_.](\d+)(?:$|[-_.])/)
  if (!glm4Match) {
    return false
  }

  return Number.parseInt(glm4Match[1]!, 10) >= 6
}

export function shouldEnableProviderToolStream(options: {
  baseUrl?: string
  hasTools: boolean
  model: string
  stream: boolean
}): boolean {
  if (!options.stream || !options.hasTools) {
    return false
  }

  return (
    resolveRouteIdFromBaseUrl(options.baseUrl) === 'zai' &&
    isZaiToolStreamCapableGLM(options.model)
  )
}
