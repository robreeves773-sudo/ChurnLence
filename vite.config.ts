import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Main app build (Ionic React UI + foreground eval loop).
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
});
