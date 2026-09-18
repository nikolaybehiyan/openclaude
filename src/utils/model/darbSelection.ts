import { saveDarbModelSelection } from '../../services/api/darbModels.js'
import { bindDarbSessionConnection } from '../sessionStorage.js'
import { getDefaultMainLoopModelSetting } from './model.js'
import { isModelAllowed } from './modelAllowlist.js'
import { currentDarbCatalog, darbModelScope, isDarbManagedInference, requireDarbModel, requireDarbModelCandidate } from './darbModels.js'
import { makeDarbDefaultSessionBinding, makeDarbSessionBinding } from './darbSessionBinding.js'
import { validateDarbNativeThinking, type DarbNativeThinking } from './darbModelControls.js'

// All interactive native model/controls entry points share this order:
// validate -> confirmed owner save -> durable session selector -> visible ACK.
// Active requests already captured their controls; this does not cancel them.
export async function selectDarbConnection(model: string | null, thinking?: DarbNativeThinking | null): Promise<void> {
  if (!isDarbManagedInference()) return
  const scope = darbModelScope()
  if (scope && currentDarbCatalog()?.mode === 'default') {
    bindDarbSessionConnection(makeDarbDefaultSessionBinding(scope), true)
    return
  }
  const binding = requireDarbModelCandidate(model ?? getDefaultMainLoopModelSetting())
  if (!scope || !isModelAllowed(binding.id)) throw new Error('Model is not available for this account')
  if (thinking !== undefined) validateDarbNativeThinking(binding, thinking)
  await saveDarbModelSelection(binding.id, thinking)
  if (darbModelScope() !== scope) throw new Error('Darb account changed while saving')
  const saved = requireDarbModel(binding.id)
  const selected = makeDarbSessionBinding(scope, saved)
  const controls = saved.selected_thinking
  bindDarbSessionConnection(controls === undefined ? selected : { ...selected, controls_by_model: [{ model: saved.id, thinking: controls }] }, true)
}
