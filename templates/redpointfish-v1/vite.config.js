import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const appId = env.VITE_VIVERSE_CLIENT_ID || env.VITE_VIVERSE_APP_ID || 'YOUR_APP_ID';
  
  return {
    plugins: [react()],
    base: './',
    define: {
      'import.meta.env.VITE_VIVERSE_CLIENT_ID': JSON.stringify(appId)
    }
  }
})
