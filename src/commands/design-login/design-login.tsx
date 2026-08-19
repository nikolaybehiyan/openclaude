import * as React from 'react'
import { useEffect, useState } from 'react'
import TextInput from '../../components/TextInput.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { Box, Link, Text } from '../../ink.js'
import {
  beginDesignOAuth,
  completeDesignOAuth,
  type PendingDesignOAuth,
} from '../../services/design/auth.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { openBrowser } from '../../utils/browser.js'

type LoginState =
  | { kind: 'starting' }
  | { kind: 'waiting'; pending: PendingDesignOAuth }
  | { kind: 'submitting'; pending: PendingDesignOAuth }
  | { kind: 'error'; message: string; pending?: PendingDesignOAuth }

function DesignLogin({
  onDone,
}: {
  onDone: LocalJSXCommandOnDone
}): React.ReactNode {
  const [state, setState] = useState<LoginState>({ kind: 'starting' })
  const [code, setCode] = useState('')
  const [cursorOffset, setCursorOffset] = useState(0)
  const terminal = useTerminalSize()

  useEffect(() => {
    let active = true
    void beginDesignOAuth()
      .then(async pending => {
        await openBrowser(pending.authorizationURL)
        if (active) setState({ kind: 'waiting', pending })
      })
      .catch(error => {
        if (active) {
          setState({
            kind: 'error',
            message: error instanceof Error ? error.message : 'Login failed',
          })
        }
      })
    return () => {
      active = false
    }
  }, [])

  const submit = async (value: string, pending: PendingDesignOAuth) => {
    setState({ kind: 'submitting', pending })
    try {
      await completeDesignOAuth(pending, value)
      onDone(
        'Design-system access authorized. /design-sync can now reach your claude.ai/design projects.',
      )
    } catch (error) {
      setState({
        kind: 'error',
        pending,
        message: error instanceof Error ? error.message : 'Login failed',
      })
    }
  }

  return (
    <Dialog title="Authorize Claude Design" onCancel={() => onDone()}>
      <Box flexDirection="column" gap={1}>
        {state.kind === 'starting' && <Text>Preparing authorization…</Text>}
        {(state.kind === 'waiting' || state.kind === 'submitting') && (
          <>
            <Text>
              Authorize design-system access (read and write your
              organization&apos;s claude.ai/design projects) with your claude.ai
              account. This is separate from this session&apos;s authentication and
              changes nothing else.
            </Text>
            <Link url={state.pending.authorizationURL}>
              {state.pending.authorizationURL}
            </Link>
            {state.kind === 'waiting' ? (
              <Box>
                <Text>Paste code here if prompted &gt; </Text>
                <TextInput
                  value={code}
                  onChange={setCode}
                  onSubmit={value => void submit(value, state.pending)}
                  columns={Math.max(40, terminal.columns - 34)}
                  cursorOffset={cursorOffset}
                  onChangeCursorOffset={setCursorOffset}
                  focus
                  showCursor
                />
              </Box>
            ) : (
              <Text>Completing authorization…</Text>
            )}
          </>
        )}
        {state.kind === 'error' && (
          <>
            <Text color="error">{state.message}</Text>
            {state.pending && (
              <Box>
                <Text>Paste the full code again &gt; </Text>
                <TextInput
                  value={code}
                  onChange={setCode}
                  onSubmit={value => void submit(value, state.pending!)}
                  columns={Math.max(40, terminal.columns - 30)}
                  cursorOffset={cursorOffset}
                  onChangeCursorOffset={setCursorOffset}
                  focus
                  showCursor
                />
              </Box>
            )}
          </>
        )}
      </Box>
    </Dialog>
  )
}

export async function call(
  onDone: LocalJSXCommandOnDone,
): Promise<React.ReactNode> {
  return <DesignLogin onDone={onDone} />
}
