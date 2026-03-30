import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: { port: 5174 },
  resolve: {
    alias: {
      // Allow importing from ../../dist/browser/index.mjs
    },
  },
  // Allow Vite to resolve files outside the project root (the SDK dist)
  server: {
    port: 5174,
    fs: {
      allow: [
        path.resolve(__dirname, '../..'),
      ],
    },
  },
})
