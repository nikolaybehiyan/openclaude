import * as React from 'react';
import { useEffect, useState } from 'react';
import { Box } from '../../ink.js';
import { getInitialSettings } from '../../utils/settings/settings.js';
import { Clawd } from './Clawd.js';

// Click highlights the stationary mark twice. No mascot motion or clipping.
export function AnimatedClawd() {
  const [reducedMotion] = useState(() => getInitialSettings().prefersReducedMotion ?? false);
  const [frame, setFrame] = useState(-1);
  useEffect(() => {
    if (frame < 0) return;
    const timer = setTimeout(() => setFrame(frame >= 5 ? -1 : frame + 1), 180);
    return () => clearTimeout(timer);
  }, [frame]);
  return <Box height={3} onClick={() => {if (!reducedMotion && frame < 0) setFrame(0);}}>
    <Clawd pose={frame >= 0 && frame % 2 === 0 ? 'arms-up' : 'default'} />
  </Box>;
}
