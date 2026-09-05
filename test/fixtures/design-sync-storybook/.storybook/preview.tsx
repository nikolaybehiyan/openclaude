import React from 'react'

export const decorators = [
  (Story: React.ComponentType) => (
    <section data-parity-provider="STORYBOOK_PROVIDER_PASS"><Story /></section>
  ),
]
