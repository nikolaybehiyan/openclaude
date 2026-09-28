import * as React from 'react';
import { Box, Text, useTheme, type TextProps } from '../../ink.js';
import { DARB_SYMBOL } from '../../constants/figures.js';
import { getTheme, type Theme } from '../../utils/theme.js';
import { interpolateColor, parseRGB, toRGBColor } from './utils.js';
const ERROR_RED = {r: 171, g: 43, b: 63};
type Props = {
  frame: number;
  messageColor: keyof Theme;
  stalledIntensity?: number;
  reducedMotion?: boolean;
  time?: number;
};

export function SpinnerGlyph({frame, messageColor, stalledIntensity = 0, reducedMotion = false}: Props) {
  const [themeName] = useTheme();
  const theme = getTheme(themeName);
  const base = parseRGB(theme[messageColor] || '');
  // Preserve the stalled/error colour signal; only the normal mark pulses.
  const pulse = (1 - Math.cos(frame * 2 * Math.PI / 14)) / 2;
  let color: TextProps['color'] = messageColor;
  let dimColor = false;
  if (!reducedMotion && stalledIntensity > 0) {
    color = base ? toRGBColor(interpolateColor(base, ERROR_RED, stalledIntensity)) : stalledIntensity > .5 ? 'error' : messageColor;
  } else if (!reducedMotion) {
    color = base ? toRGBColor(interpolateColor(base, {r: 242, g: 164, b: 124}, pulse * .7)) : messageColor;
    dimColor = !base && pulse < .35;
  }
  return <Box flexWrap="wrap" height={1} width={2}><Text color={color} dimColor={dimColor}>{DARB_SYMBOL}</Text></Box>;
}
