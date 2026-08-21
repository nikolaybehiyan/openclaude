import { AsyncLocalStorage } from 'async_hooks'

export const CCR_TURN_ID_HEADER = 'X-CCR-Turn-Id'
export const CCR_TURN_ID_MAX_LENGTH = 128

const ccrTurnStorage = new AsyncLocalStorage<{
  id: string | undefined
}>()

export function getCcrTurnId(): string | undefined {
  return ccrTurnStorage.getStore()?.id
}

export function runWithCcrTurnId<T>(
  id: string | undefined,
  fn: () => T,
): T {
  return ccrTurnStorage.run({ id }, fn)
}

export function selectCcrTurnId(
  commands: ReadonlyArray<{ ccrTurnId?: string }>,
): string | undefined {
  const first = commands[0]?.ccrTurnId
  return commands.every(command => command.ccrTurnId === first)
    ? first
    : undefined
}

export function withCurrentCcrTurnHeader(
  init: RequestInit | undefined,
): RequestInit {
  const headers = new Headers(init?.headers)
  headers.delete(CCR_TURN_ID_HEADER)
  const id = getCcrTurnId()
  if (id !== undefined) headers.set(CCR_TURN_ID_HEADER, id)
  return { ...init, headers }
}

export async function* iterateWithCcrTurnId<T>(
  id: string | undefined,
  iterable: AsyncIterable<T>,
): AsyncGenerator<T, void, unknown> {
  const iterator = iterable[Symbol.asyncIterator]()
  while (true) {
    const next = await runWithCcrTurnId(id, () => iterator.next())
    if (next.done) return
    yield next.value
  }
}
