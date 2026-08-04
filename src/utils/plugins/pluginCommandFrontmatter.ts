/** Keep plugin command metadata inside the public SDK command contract. */
export function normalizePluginArgumentHint(
  value: unknown,
): string | undefined {
  return value == null ? undefined : String(value)
}
