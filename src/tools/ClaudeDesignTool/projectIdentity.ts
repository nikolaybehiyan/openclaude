import { getOauthConfig } from '../../constants/oauth.js'
import type { DesignMcpContent } from '../../services/design/types.js'

export type VerifiedDesignProjectIdentity = {
  name: string
  sharingLabel: string
  url: string
}

const SHARING_LABELS: Record<string, string> = {
  invited: 'private: invited members only',
  org: 'visible to your whole organization',
  public: 'PUBLIC',
}

const INVISIBLE_OR_CONTROL =
  /[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\u2026\u2800\u3164\uFE00-\uFE0E\uFEFF\uFFF9-\uFFFB\uFFA0]/
const TAG_OR_MUSICAL_CONTROL =
  /\uDB40[\uDC20-\uDC7F\uDD00-\uDDEF]|\uD834[\uDD73-\uDD7A]/
const QUOTE_OR_DASH =
  /["\u201C\u201D\u201E\u201F\uFF02\u2033\u2036\u02BA\u02DD\u02EE\u05F4\u3003\u301D-\u301F\u275D\u275E\u2014\u2015]/
const STRAY_JOINER_OR_VARIATION =
  /(?:^|\s)[\u200C\u200D\uFE0F]|[\u200C\u200D](?=\s|$)|[\u200C\u200D][\u200C\u200D]|(?:^|[^\p{Emoji}])\uFE0F/u

function parseRecord(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function truncateName(value: string): string {
  const characters = Array.from(value)
  return characters.length <= 60
    ? value
    : `${characters.slice(0, 60).join('').trimEnd()}…`
}

/**
 * Verify the exact fields rendered in 2.1.221's durable-grant approval card.
 * Untrusted project metadata never reaches the permission UI unless its name,
 * sharing scope, and canonical first-party URL all pass this boundary.
 */
export function verifyDesignProjectIdentity(
  projectId: string,
  content: DesignMcpContent[],
): VerifiedDesignProjectIdentity | null {
  for (const block of content) {
    if (block.type !== 'text' || typeof block.text !== 'string') continue
    const project = parseRecord(block.text)
    if (!project) continue

    if (typeof project.name !== 'string') return null
    const name = project.name.replace(/\s+/g, ' ').trim()
    if (
      name.length === 0 ||
      name.includes('://') ||
      INVISIBLE_OR_CONTROL.test(name) ||
      TAG_OR_MUSICAL_CONTROL.test(name) ||
      QUOTE_OR_DASH.test(name) ||
      STRAY_JOINER_OR_VARIATION.test(name)
    ) {
      return null
    }

    const sharing = project.sharing
    if (!sharing || typeof sharing !== 'object' || Array.isArray(sharing)) {
      return null
    }
    const scope = (sharing as Record<string, unknown>).scope
    if (typeof scope !== 'string' || !(scope in SHARING_LABELS)) return null
    if (typeof project.url !== 'string') return null

    let url: URL
    try {
      url = new URL(project.url)
    } catch {
      return null
    }
    const expectedOrigin = new URL(getOauthConfig().CLAUDE_AI_ORIGIN).origin
    if (
      url.protocol !== 'https:' ||
      url.origin !== expectedOrigin ||
      !url.pathname.endsWith(`/p/${projectId}`) ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== '' ||
      project.url.length > 200 ||
      /\s/.test(project.url) ||
      INVISIBLE_OR_CONTROL.test(project.url) ||
      TAG_OR_MUSICAL_CONTROL.test(project.url) ||
      QUOTE_OR_DASH.test(project.url) ||
      /[\u200C\u200D\uFE0F]/.test(project.url)
    ) {
      return null
    }

    return {
      name: truncateName(name),
      sharingLabel: SHARING_LABELS[scope]!,
      url: project.url,
    }
  }
  return null
}
