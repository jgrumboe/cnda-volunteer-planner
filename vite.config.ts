import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The plan lives in localStorage, which is scoped to the ORIGIN — port included.
// Both ports are pinned so dev and preview always resolve to the same origin;
// otherwise Vite's defaults (5173 dev, 4173 preview) would each hold their own
// separate, empty plan and look like data loss.
// strictPort makes a port clash fail loudly instead of silently shifting to 5179.
const PORT = 5178

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE_PATH ?? '/cnda-volunteer-planner/',
  server: { port: PORT, strictPort: true },
  preview: { port: PORT, strictPort: true },
})
