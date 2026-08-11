import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'

// The version feedback rows are stamped with. Read from package.json at build time and
// substituted as a literal, so the client ships the string alone rather than importing
// package.json (which would bundle the whole dependency list to get one field).
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  server: {
    host: true,
  },
})
