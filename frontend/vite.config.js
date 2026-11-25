import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
    base: './', // Flask may be mounted at /meeting/, not the domain root.
    publicDir: false,
    esbuild: { jsx: 'automatic' },
    build: {
        target: ['chrome90', 'safari15', 'firefox90'],
        outDir: fileURLToPath(new URL('../static/meeting', import.meta.url)),
        // Keep previously deployed hashed assets usable by open pages.
        emptyOutDir: false,
        manifest: 'manifest.json',
        rollupOptions: {
            input: 'src/main.jsx',
            // motion 的文件带 "use client"（给服务端渲染用），打包时忽略即可。
            onwarn(warning, warn) {
                if (warning.code === 'MODULE_LEVEL_DIRECTIVE') return;
                warn(warning);
            },
        },
    },
});
