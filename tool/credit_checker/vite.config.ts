import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { identifyPlugin } from './server/identifyPlugin.ts';

export default defineConfig({
  plugins: [react(), tailwindcss(), identifyPlugin()],
});
