import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Frontend dev server on :5173, backend expected on :8787.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  // The pdf.js worker makes the main chunk big by design — raise the warning
  // ceiling so a clean build doesn't print a scary-looking size warning.
  build: { chunkSizeWarningLimit: 1600 },
});
