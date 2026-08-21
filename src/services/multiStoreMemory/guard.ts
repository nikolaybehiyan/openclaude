import { extname, normalize, relative, resolve, sep } from 'path'
import { scanForSecrets } from '../teamMemorySync/secretScanner.js'
import {
  getMemoryStoreMountDir,
  getMemoryStoresConfig,
  hasConfiguredMemoryStores,
  isPathInsideMemoryStore,
} from './config.js'

const MAX_FILE_BYTES = 102_400
const ALLOWED_EXTENSIONS = new Set(['.md', '.txt', '.json', '.jsonl'])

function isEligibleMemoryPath(relativePath: string): boolean {
  const normalized = relativePath.split(sep).join('/')
  const segments = normalized.split('/')
  return (
    normalized.length > 0 &&
    !normalized.startsWith('../') &&
    segments.every(
      segment =>
        segment.length > 0 &&
        segment !== '.' &&
        segment !== '..' &&
        !segment.startsWith('.'),
    ) &&
    ALLOWED_EXTENSIONS.has(extname(segments.at(-1) ?? '').toLowerCase())
  )
}

export function checkMultiStoreMemoryWrite(
  filePath: string,
  content: string,
): string | null {
  if (!hasConfiguredMemoryStores()) return null
  const config = getMemoryStoresConfig()
  if (!config.active) return null
  if (config.error) {
    return 'Claude Tag memory is unavailable because its store configuration is invalid.'
  }

  const matching = config.stores
    .filter(store => isPathInsideMemoryStore(filePath, store))
    .sort(
      (left, right) =>
        getMemoryStoreMountDir(right).length -
        getMemoryStoreMountDir(left).length,
    )[0]

  const autoRoot = config.stores[0]
    ? getMemoryStoreMountDir({ ...config.stores[0], scope: 'user' })
    : null
  const candidate = normalize(resolve(filePath))
  if (!matching) {
    if (
      autoRoot &&
      (candidate === normalize(resolve(autoRoot)) ||
        candidate.startsWith(normalize(resolve(autoRoot)) + sep))
    ) {
      return 'This path is outside the Claude Tag memory stores configured for this session.'
    }
    return null
  }
  if (matching.mode === 'ro') {
    return `Memory store ${matching.mount} is read-only in this session.`
  }
  const mountDir = getMemoryStoreMountDir(matching)
  if (!isEligibleMemoryPath(relative(mountDir, candidate))) {
    return 'Memory files must be non-hidden .md, .txt, .json, or .jsonl files.'
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
    return `Memory files cannot exceed ${MAX_FILE_BYTES} bytes.`
  }
  if (scanForSecrets(content).length > 0) {
    return 'Content contains a potential secret and cannot be written to Claude Tag memory.'
  }
  return null
}
