import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Root } from './Root.tsx'
import { takeToken } from './token.ts'
import './styles.css'

// Read the token once, before anything renders: takeToken also removes it from the address bar.
const token = takeToken()

const container = document.getElementById('root')
if (container) {
  createRoot(container).render(
    <StrictMode>
      <Root initialToken={token} />
    </StrictMode>
  )
}
