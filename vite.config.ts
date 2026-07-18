import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

export default defineConfig(({ command }) => ({
  plugins: [react()],
  base: './',
  resolve: {
    alias: command === 'build' ? [{ find: /^\.\/demo-api$/, replacement: fileURLToPath(new URL('./src/demo-api.disabled.ts', import.meta.url)) }] : [],
  },
  server: { port: 5173, strictPort: true },
}))
