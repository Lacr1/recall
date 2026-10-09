import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        // The engine runs in its own utilityProcess, so it is a separate entry.
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          engine: resolve(__dirname, 'src/engine/index.ts')
        }
      }
    }
  },
  preload: {},
  renderer: {
    plugins: [react()]
  }
})
