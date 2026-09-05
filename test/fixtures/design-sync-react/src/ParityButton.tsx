import React from 'react'
/** A real button used to verify the Design system converter. */
export function ParityButton({ label = 'DESIGN_SYNC_COMPONENT_PASS', disabled = false }: {
  label?: string
  disabled?: boolean
}) {
  return <button className="parity-button" disabled={disabled}>{label}</button>
}
