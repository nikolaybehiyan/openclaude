import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from '../../services/analytics/index.js';
import { useAppState, useSetAppState } from '../../state/AppState.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
import { type EffortValue, getDisplayedEffortLevel, getEffortEnvOverride, getEffortValueDescription, isEffortLevel, isOpenAIEffortLevel, modelUsesOpenAIEffort, openAIEffortToStandard, toPersistableEffort } from '../../utils/effort.js';
import { EffortPicker } from '../../components/EffortPicker.js';
import { updateSettingsForSource } from '../../utils/settings/settings.js';
import { Box, Text } from '../../ink.js';
import { Select } from '../../components/CustomSelect/index.js';
import { darbSelectedThinking, isDarbCustomInference, requireDarbModel } from '../../utils/model/darbModels.js';
import { darbCanSelectEffort, darbEffortOptions, darbThinkingWithEffort } from '../../utils/model/darbModelControls.js';
import { selectDarbConnection } from '../../utils/model/darbSelection.js';
import { resolveAppliedEffort } from '../../utils/effort.js';
const COMMON_HELP_ARGS = ['help', '-h', '--help'];
type EffortCommandResult = {
  message: string;
  effortUpdate?: {
    value: EffortValue | undefined;
  };
};
function setEffortValue(effortValue: EffortValue): EffortCommandResult {
  const persistable = toPersistableEffort(effortValue);
  if (persistable !== undefined) {
    const result = updateSettingsForSource('userSettings', {
      effortLevel: persistable
    });
    if (result.error) {
      return {
        message: `Failed to set effort level: ${result.error.message}`
      };
    }
  }
  logEvent('tengu_effort_command', {
    effort: effortValue as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  });

  // Env var wins at resolveAppliedEffort time. Only flag it when it actually
  // conflicts — if env matches what the user just asked for, the outcome is
  // the same, so "Set effort to X" is true and the note is noise.
  const envOverride = getEffortEnvOverride();
  if (envOverride !== undefined && envOverride !== effortValue) {
    const envRaw = process.env.CLAUDE_CODE_EFFORT_LEVEL;
    if (persistable === undefined) {
      return {
        message: `Not applied: CLAUDE_CODE_EFFORT_LEVEL=${envRaw} overrides effort this session, and ${effortValue} is session-only (nothing saved)`,
        effortUpdate: {
          value: effortValue
        }
      };
    }
    return {
      message: `CLAUDE_CODE_EFFORT_LEVEL=${envRaw} overrides this session — clear it and ${effortValue} takes over`,
      effortUpdate: {
        value: effortValue
      }
    };
  }
  const description = getEffortValueDescription(effortValue);
  const suffix = persistable !== undefined ? '' : ' (this session only)';
  return {
    message: `Set effort level to ${effortValue}${suffix}: ${description}`,
    effortUpdate: {
      value: effortValue
    }
  };
}
export function showCurrentEffort(appStateEffort: EffortValue | undefined, model: string): EffortCommandResult {
  const envOverride = getEffortEnvOverride();
  const effectiveValue = envOverride === null ? undefined : envOverride ?? appStateEffort;
  if (effectiveValue === undefined) {
    const level = getDisplayedEffortLevel(model, appStateEffort);
    return {
      message: `Effort level: auto (currently ${level})`
    };
  }
  const description = getEffortValueDescription(effectiveValue);
  return {
    message: `Current effort level: ${effectiveValue} (${description})`
  };
}
function unsetEffortLevel(): EffortCommandResult {
  const result = updateSettingsForSource('userSettings', {
    effortLevel: undefined
  });
  if (result.error) {
    return {
      message: `Failed to set effort level: ${result.error.message}`
    };
  }
  logEvent('tengu_effort_command', {
    effort: 'auto' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  });
  // env=auto/unset (null) matches what /effort auto asks for, so only warn
  // when env is pinning a specific level that will keep overriding.
  const envOverride = getEffortEnvOverride();
  if (envOverride !== undefined && envOverride !== null) {
    const envRaw = process.env.CLAUDE_CODE_EFFORT_LEVEL;
    return {
      message: `Cleared effort from settings, but CLAUDE_CODE_EFFORT_LEVEL=${envRaw} still controls this session`,
      effortUpdate: {
        value: undefined
      }
    };
  }
  return {
    message: 'Effort level set to auto',
    effortUpdate: {
      value: undefined
    }
  };
}
export function executeEffort(args: string): EffortCommandResult {
  const normalized = args.toLowerCase();
  if (normalized === 'auto' || normalized === 'unset') {
    return unsetEffortLevel();
  }
  if (isEffortLevel(normalized)) {
    return setEffortValue(normalized);
  }
  if (isOpenAIEffortLevel(normalized)) {
    // Provider-specific aliases are normalized at the provider boundary.
    return setEffortValue(openAIEffortToStandard(normalized));
  }
  return {
    message: `Invalid argument: ${args}. Valid options are: low, medium, high, max, xhigh, auto`
  };
}
function ShowCurrentEffort(t0) {
  const {
    onDone
  } = t0;
  const effortValue = useAppState(_temp);
  const model = useMainLoopModel();
  const {
    message
  } = showCurrentEffort(effortValue, model);
  onDone(message);
  return null;
}
function _temp(s) {
  return s.effortValue;
}
function ApplyEffortAndClose(t0) {
  const $ = _c(6);
  const {
    result,
    onDone
  } = t0;
  const setAppState = useSetAppState();
  const {
    effortUpdate,
    message
  } = result;
  let t1;
  let t2;
  if ($[0] !== effortUpdate || $[1] !== message || $[2] !== onDone || $[3] !== setAppState) {
    t1 = () => {
      if (effortUpdate) {
        setAppState(prev => ({
          ...prev,
          effortValue: effortUpdate.value
        }));
      }
      onDone(message);
    };
    t2 = [setAppState, effortUpdate, message, onDone];
    $[0] = effortUpdate;
    $[1] = message;
    $[2] = onDone;
    $[3] = setAppState;
    $[4] = t1;
    $[5] = t2;
  } else {
    t1 = $[4];
    t2 = $[5];
  }
  React.useEffect(t1, t2);
  return null;
}
export async function call(onDone: LocalJSXCommandOnDone, _context: unknown, args?: string): Promise<React.ReactNode> {
  args = args?.trim() || '';
  if (isDarbCustomInference()) return <DarbEffortCommand args={args} onDone={onDone} />;
  if (COMMON_HELP_ARGS.includes(args)) {
    onDone('Usage: /effort [low|medium|high|xhigh|max|auto]\n\nEffort levels:\n- low: Quick, straightforward implementation\n- medium: Balanced approach with standard testing\n- high: Comprehensive implementation with extensive testing\n- xhigh: Extra-high reasoning for complex coding and agentic tasks\n- max: Maximum capability with deepest reasoning (this session only)\n- auto: Use the default effort level for your model');
    return;
  }
  if (args === 'current' || args === 'status') {
    return <ShowCurrentEffort onDone={onDone} />;
  }
  if (!args) {
    return <EffortPickerWrapper onDone={onDone} />;
  }
  const result = executeEffort(args);
  return <ApplyEffortAndClose result={result} onDone={onDone} />;
}

function DarbEffortCommand({ args, onDone }: { args: string; onDone: LocalJSXCommandOnDone }) {
  const model = useMainLoopModel();
  const setAppState = useSetAppState();
  const [error, setError] = React.useState<string>();
  const [saving, setSaving] = React.useState(false);
  const started = React.useRef(false), pending = React.useRef(false);
  const row = requireDarbModel(model);
  const selected = darbSelectedThinking(model);
  async function apply(value: string) {
    if (pending.current) return;
    pending.current = true; setSaving(true); setError(undefined);
    const effort = value === 'auto' || value === 'unset' ? undefined : value;
    try {
      if (effort !== undefined && !darbCanSelectEffort(row, effort)) throw new Error('Unavailable effort');
      await selectDarbConnection(model, darbThinkingWithEffort(selected, effort));
      // The authoritative per-model state now supplies the value; no global
      // Claude settings or optimistic AppState update can bleed to model B.
      setAppState(prev => ({ ...prev, effortValue: undefined }));
      const env = getEffortEnvOverride();
      onDone(`Saved effort for ${model}: ${effort ?? 'auto (not requested)'}.${env !== undefined ? ' CLAUDE_CODE_EFFORT_LEVEL still overrides this session.' : ''}`);
    } catch { setError('Could not confirm the effort preference. Check the exact allowed value and run /model refresh before retrying.'); }
    finally { pending.current = false; setSaving(false); }
  }
  React.useEffect(() => {
    if (started.current || !args) return;
    started.current = true;
    if (COMMON_HELP_ARGS.includes(args)) onDone('Usage: /effort [exact owner value|auto|current]. Auto omits the effort request. Values are model-specific; no automatic high level is selected.');
    else if (args === 'current' || args === 'status') {
      try { onDone(`Effort for ${model}: ${resolveAppliedEffort(model, undefined) ?? 'auto (not requested)'}`); }
      catch { onDone('Saved effort is unavailable; refresh the selector or explicitly reset it.'); }
    } else void apply(args);
  }, [args]);
  const options = [{ value: 'auto', label: 'Auto (omit effort request)' }, ...darbEffortOptions(row).map(value => ({ value, label: value }))];
  return <Box flexDirection="column"><Text bold>Effort — {model}</Text>
    {!args || error ? <Select options={options} defaultValue={selected?.effort ?? 'auto'} defaultFocusValue={selected?.effort ?? 'auto'} visibleOptionCount={10}
      onChange={value => { void apply(value); }} onCancel={() => onDone('Cancelled')} /> : null}
    {saving ? <Text dimColor>Saving…</Text> : null}{error ? <Text color="error">{error}</Text> : null}
  </Box>;
}

function EffortPickerWrapper({ onDone }: { onDone: LocalJSXCommandOnDone }) {
  const setAppState = useSetAppState();
  const model = useMainLoopModel();
  const usesOpenAIEffort = modelUsesOpenAIEffort(model);

  function handleSelect(effort: EffortValue | undefined) {
    const persistable = toPersistableEffort(effort);
    if (persistable !== undefined) {
      updateSettingsForSource('userSettings', {
        effortLevel: persistable
      });
    }
    logEvent('tengu_effort_command', {
      effort: (effort ?? 'auto') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    });
    setAppState(prev => ({
      ...prev,
      effortValue: effort
    }));
    const description = effort ? getEffortValueDescription(effort) : 'Use default effort level for your model';
    const suffix = persistable !== undefined ? '' : ' (this session only)';
    onDone(`Set effort level to ${effort ?? 'auto'}${suffix}: ${description}`);
  }

  function handleCancel() {
    onDone('Cancelled');
  }

  return <EffortPicker onSelect={handleSelect} onCancel={handleCancel} />;
}
