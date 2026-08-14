export function resolveGrowthBookFeatureValue<T>({
  feature,
  remoteValues,
  diskValues,
  sdkValue,
}: {
  feature: string
  remoteValues: ReadonlyMap<string, unknown>
  diskValues: Record<string, unknown> | undefined
  sdkValue: () => T
}): T {
  // Once a complete remote-eval payload has been processed it is
  // authoritative, including feature removals. Do not resurrect a removed
  // feature from the previous process's disk snapshot.
  if (remoteValues.size > 0) {
    return remoteValues.has(feature)
      ? (remoteValues.get(feature) as T)
      : sdkValue()
  }

  // init() can time out or fail while a complete client-scoped snapshot is
  // already present on disk. The blocking reader must use that snapshot just
  // like the synchronous reader does; treating the SDK's empty payload as the
  // default can accidentally trip fail-closed circuit breakers for the whole
  // process.
  if (diskValues && Object.prototype.hasOwnProperty.call(diskValues, feature)) {
    return diskValues[feature] as T
  }

  return sdkValue()
}
