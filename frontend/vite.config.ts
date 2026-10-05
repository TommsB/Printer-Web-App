import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// In dev, /api is proxied to the FastAPI backend so cookies stay same-origin
// (works from a phone via the LAN IP too: host: true).
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    proxy: { '/api': 'http://localhost:8000' },
  },
})
