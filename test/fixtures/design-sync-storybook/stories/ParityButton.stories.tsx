import React from 'react'
import { ParityButton } from '@parity/design-sync-fixture'

export default {
  title: 'Controls/ParityButton',
  component: ParityButton,
  args: { label: 'STORYBOOK_PRIMARY_PASS' },
}

export const Primary = {}
export const Disabled = {
  args: { label: 'STORYBOOK_DISABLED_PASS', disabled: true },
}
// A story-local closure must survive compiling the entire story module.
const customLabel = 'STORYBOOK_CUSTOM_PASS'
export const CustomRender = {
  render: () => <ParityButton label={customLabel} />,
}
