import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  server: { port: 3000 },
  publicDir: path.resolve('../robotics-ik-handtracking/public'),
});
