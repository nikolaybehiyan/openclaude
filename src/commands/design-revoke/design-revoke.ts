import type { LocalCommandResult } from '../../commands.js'
import type { ToolUseContext } from '../../Tool.js'
import { revokeDesignConsent } from '../../services/design/control.js'
import {
  describeDesignAuthFailure,
  resolveDesignAccessToken,
} from '../../services/design/auth.js'

export async function call(
  _args: string,
  context: ToolUseContext,
): Promise<LocalCommandResult> {
  const auth = await resolveDesignAccessToken(context.abortController.signal)
  if (!auth.ok) {
    return {
      type: 'text',
      value: describeDesignAuthFailure(auth, false),
    }
  }
  try {
    await revokeDesignConsent(
      auth.accessToken,
      context.abortController.signal,
    )
    return {
      type: 'text',
      value: 'Design agent access revoked for your Claude Design projects.',
    }
  } catch {
    return {
      type: 'text',
      value:
        "Couldn't revoke Design agent access for your Claude Design projects. Try again, or check your claude.ai login with /login.",
    }
  }
}
