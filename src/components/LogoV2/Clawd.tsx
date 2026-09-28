import * as React from 'react';
import { Box, Text } from '../../ink.js';
import { DARB_SYMBOL } from '../../constants/figures.js';

// Keep the existing header component API and footprint across compact/full modes.
export type ClawdPose = 'default' | 'arms-up' | 'look-left' | 'look-right';
export function Clawd({pose = 'default'}: {pose?: ClawdPose} = {}) {
  return <Box width={9} height={3} alignItems="center" justifyContent="center">
    <Text color={pose === 'default' ? 'claude' : 'claudeShimmer'}>{DARB_SYMBOL}</Text>
  </Box>;
}
