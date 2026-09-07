/**
 * Branded type for system prompt arrays.
 *
 * This module is intentionally dependency-free so it can be imported
 * from anywhere without risking circular initialization issues.
 */

export type SystemPrompt = readonly string[] & {
  readonly __brand: 'SystemPrompt'
}

export function asSystemPrompt(value: readonly string[]): SystemPrompt {
  return value as SystemPrompt
}

/** Preserve SDK sections/cache boundaries; an explicit empty prompt is an override. */
export function selectSystemPromptSections(
  custom: string | string[] | undefined,
  fallback: string[],
): string[] {
  return typeof custom === 'string' ? [custom] : custom ?? fallback
}
