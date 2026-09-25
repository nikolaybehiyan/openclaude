import React, {useEffect, useRef, useState} from 'react'
import chalk from 'chalk'
import {Box, Text, useAnimationFrame, useTheme} from '../../ink.js'
import {useAppState} from '../../state/AppState.js'
import type {AppState} from '../../state/AppStateStore.js'
import {useSettings} from '../../hooks/useSettings.js'
import {formatDuration} from '../../utils/format.js'
import {getTheme} from '../../utils/theme.js'
import {interpolateColor, parseRGB, toRGBColor} from '../Spinner/utils.js'

// 2.1.226 W$l: elapsed label, permission-color pulse (20 frames / 4 seconds).
export function GoalIndicator({withSeparator = false}: {withSeparator?: boolean}) {
  const setAt = useAppState((state: AppState) => state.activeGoal?.setAt)
  const [theme] = useTheme()
  const settings = useSettings()
  const pulse = setAt !== undefined && chalk.level >= 3 && !settings.prefersReducedMotion
  const [ref, animationTime] = useAnimationFrame(pulse ? 200 : null)
  const [,tick] = useState(0)
  const clock = useRef<{setAt: number; started: number} | null>(null)
  if (setAt !== undefined && clock.current?.setAt !== setAt) {
    clock.current = {setAt, started: performance.now() - Math.max(0,Date.now() - setAt)}
  }
  const elapsed = setAt === undefined ? 0 : Math.max(0,performance.now() - clock.current!.started)
  useEffect(() => {
    if (setAt === undefined || pulse) return
    const step = elapsed < 60000 ? 1000 : 60000
    const timer = setTimeout(() => tick(value => value + 1), step - elapsed % step)
    return () => clearTimeout(timer)
  }, [setAt, pulse, elapsed])
  if (setAt === undefined) return null
  const base = parseRGB(getTheme(theme).permission)
  const phase = Math.floor(animationTime / 200) % 20
  const intensity = 0.18 * (0.5 - 0.5 * Math.cos(2 * Math.PI * phase / 20))
  const color = pulse && base ? toRGBColor(interpolateColor(base,{r:0,g:0,b:0},intensity)) : 'permission'
  return <Box flexShrink={0} ref={ref}>
    {withSeparator && <Text dimColor> · </Text>}
    <Text color={color}><Text aria-hidden>◎ </Text>/goal active{elapsed >= 1000 ? ` (${formatDuration(elapsed,{mostSignificantOnly:true})})` : ''}</Text>
  </Box>
}
