import { defineConfig } from 'vite';

export default defineConfig({
    base: './', // Relative paths for VIVERSE
    build: {
        outDir: 'dist',
        rollupOptions: {
            input: 'index.html'
        }
    },
    resolve: {
        alias: {
            'three/addons/': 'three/examples/jsm/'
        }
    }
});
