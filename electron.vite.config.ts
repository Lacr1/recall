import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        // The engine and voice run in their own utilityProcesses, so they are separate entries.
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          engine: resolve(__dirname, 'src/engine/index.ts'),
          voice: resolve(__dirname, 'src/voice/index.ts')
        }
      }
    }
  },
  // The voice popup is a second window with its own preload and page (plan 12 §5.1).
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          popup: resolve(__dirname, 'src/preload/popup.ts')
        }
      }
    }
  },
  renderer: {
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          popup: resolve(__dirname, 'src/renderer/popup.html')
        }
      }
    }
  }
})
