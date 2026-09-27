import type { DarbDefaultModel } from '../../utils/model/darbCatalog.js'

const deepSeek = 'claude-darb-alibaba-deepseek-v4-pro'
const searchExecutor = 'claude-darb-alibaba-qwen3-8-max'

// Native DeepSeek retrieval returned unrelated sources for preserved RU/EN
// queries. The isolated Qwen search executor was qualified on the same gateway.
// This changes only the search helper, never the main conversation model. The
// caller supplies an authenticated default catalog; custom/frozen hosts do not
// enter this path, and the normal transport still authorizes each request.
export function darbSearchExecutor(
  mainModel: string,
  catalog: readonly DarbDefaultModel[] | undefined,
): string | undefined {
  const canonical = mainModel.replace(/\[1m\]$/, '')
  if (canonical !== deepSeek || !catalog?.some(row => row.id === canonical)) {
    return undefined
  }
  const executor = catalog.find(row => row.id === searchExecutor)
  if (!executor?.native_parameters?.thinking_types.includes('disabled')) {
    throw new Error('Darb web search is unavailable: its search executor is missing from the authenticated model catalog.')
  }
  return executor.id
}
