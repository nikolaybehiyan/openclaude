import React from 'react'
import './styles.css'
export function ParityButton({ label = 'DESIGN_SYNC_COMPONENT_PASS', disabled = false }) {
  return React.createElement('button', { className: 'parity-button', disabled }, label)
}
