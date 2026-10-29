import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), basicSsl()],
  server: {
    host: true,
    port: 5173,
    https: {},
    proxy: {
      // Proxy WebSocket signaling through Vite so everything stays on the same HTTPS origin.
      // This avoids mixed-content blocking (HTTPS page → ws:// backend) on iOS Safari.
      '/ws': {
        target: 'http://localhost:8000',
        ws: true,
      },
    },
  },
})
