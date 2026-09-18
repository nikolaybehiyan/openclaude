import { useSyncExternalStore } from 'react'
import { darbCatalogSession } from '../utils/model/darbCatalog.js'

export function useDarbCatalogRevision(): void {
  useSyncExternalStore(darbCatalogSession.subscribe, darbCatalogSession.getRevision, darbCatalogSession.getRevision)
}
