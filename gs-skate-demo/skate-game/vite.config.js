import { resolve } from 'path';
import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { normalizePath } from 'vite';
import fs from 'fs';

// Minimal polyfill injected into Spark's worker blob.
// Chrome returns r.url === "" for data: URL fetch responses, so
// WebAssembly.instantiateStreaming fails silently on them.
// This makes any non-HTTP(S) source fall back to WebAssembly.instantiate.
const WASM_POLYFILL = `(function(){
  var _ois=WebAssembly.instantiateStreaming;
  WebAssembly.instantiateStreaming=async function(s,i){
    var r=await(s instanceof Promise?s:Promise.resolve(s));
    var u=r.url||'';
    if(!u.startsWith('http://')&&!u.startsWith('https://')){
      try{var b=await r.clone().arrayBuffer();return WebAssembly.instantiate(b,i);}catch(e){}
    }
    return _ois.call(WebAssembly,r,i);
  };
})();\n`;

export default defineConfig({
  plugins: [
    // Inject the WASM polyfill into Spark's inline worker blob so that
    // WebAssembly.instantiateStreaming works correctly inside the worker context.
    {
      name: 'patch-spark-worker-wasm',
      transform(code, id) {
        if (!id.includes('@sparkjsdev') || !code.includes('jsContent')) return null;
        const p = JSON.stringify(WASM_POLYFILL);
        return code
          // Blob path
          .replace(
            'new Blob([jsContent], { type: "text/javascript;charset=utf-8" })',
            `new Blob([${p}, jsContent], { type: "text/javascript;charset=utf-8" })`,
          )
          // data: URL fallback path
          .replace(
            '"data:text/javascript;charset=utf-8," + encodeURIComponent(jsContent)',
            `"data:text/javascript;charset=utf-8," + encodeURIComponent(${p} + jsContent)`,
          );
      },
    },
    // POST /api/gen-collision — server-side Node.js voxelizer fallback.
    // Used by arena-loader when WebGPU is unavailable or produces no solid blocks.
    // Accepts { plyUrl, seedX, seedY, seedZ, voxelFloor, opacityThreshold } as JSON.
    // Returns an SSE stream → { type:'done', url: '/fps/scene.collision.glb' }
    // Result is cached alongside the PLY so repeated loads are instant.
    {
      name: 'splat-collision',
      configureServer(server) {
        server.middlewares.use('/api/gen-collision', async (req, res) => {
          if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }

          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          let body;
          try { body = JSON.parse(Buffer.concat(chunks).toString()); }
          catch { res.statusCode = 400; res.end('Bad JSON'); return; }

          const { plyUrl, seedX, seedY, seedZ, voxelFloor, opacityThreshold } = body;

          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          const send = (obj) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };

          const publicRoot = resolve(__dirname, 'public');
          const linkPath   = resolve(publicRoot, (plyUrl || '').replace(/^\//, ''));
          let realInput;
          try { realInput = fs.realpathSync(linkPath); }
          catch (e) { send({ type: 'error', text: `Cannot resolve ${plyUrl}: ${e.message}` }); res.end(); return; }

          const relNoExt = (plyUrl || '').replace(/^\//, '').replace(/\.ply$/i, '');
          const outDir   = resolve(publicRoot, relNoExt.split('/').slice(0, -1).join('/'));
          const baseName = relNoExt.split('/').pop();
          const glbOut   = resolve(outDir, `${baseName}.collision.glb`);
          const glbUrl   = `/${relNoExt}.collision.glb`;

          if (fs.existsSync(glbOut)) { send({ type: 'done', url: glbUrl, cached: true }); res.end(); return; }
          fs.mkdirSync(outDir, { recursive: true });

          const seed     = [seedX, seedY, seedZ].map(v => Number(v).toFixed(4)).join(',');
          const voxSize  = parseFloat(voxelFloor)      || 0.3;
          const opThresh = parseFloat(opacityThreshold) || 0.3;

          send({ type: 'log', text: `Running Node.js voxelizer (voxel=${voxSize}m)…` });
          try {
            const { voxelizePly } = await import('../collision-tool/scripts/ply-voxelizer.mjs');
            await voxelizePly(realInput, seed, voxSize, glbOut, (t) => send({ type: 'log', text: t }), opThresh);
            send({ type: 'done', url: glbUrl });
          } catch (e) {
            send({ type: 'error', text: `Voxelizer failed: ${e.message}` });
          }
          res.end();
        });
      },
    },

    // GET /__find-ply?game=fps  →  { plyPath: '/fps/scene.ply', name: 'scene.ply' }
    // Scans public/<game>/ for the first .ply file so arena-loader can auto-discover it.
    {
      name: 'ply-finder',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (!req.url?.startsWith('/__find-ply')) { next(); return; }
          const game = new URL(req.url, 'http://x').searchParams.get('game') || '';
          const dir  = resolve(__dirname, 'public', game);
          let found  = null;
          try {
            const plys = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.ply'));
            // Prefer 'uploaded.ply' (written by the collision mapper) over the default scene file
            found = ['uploaded.ply', 'scene.ply'].find(f => plys.includes(f)) ?? plys[0] ?? null;
          } catch {}
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(found
            ? { plyPath: `/${game}/${found}`, name: found }
            : { plyPath: null, name: null }));
        });
      },
    },
    // Decodes Spark's inline WASM data: URLs that Node can't handle at >1 KB
    {
      name: 'serve-inline-wasm',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const url = req.url || '';
          const marker = '/data:application/wasm;base64,';
          const idx = url.indexOf(marker);
          if (idx === -1) { next(); return; }
          try {
            const base64 = url.slice(idx + marker.length);
            const buffer = Buffer.from(decodeURIComponent(base64), 'base64');
            res.setHeader('Content-Type', 'application/wasm');
            res.setHeader('Cache-Control', 'max-age=86400');
            res.end(buffer);
          } catch (e) {
            console.error('[serve-inline-wasm]', e.message);
            next();
          }
        });
      },
    },
    // Required for SharedArrayBuffer used by Spark multi-threaded renderer
    {
      name: 'cross-origin-isolation',
      configureServer(server) {
        server.middlewares.use((_req, res, next) => {
          res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
          res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
          next();
        });
      },
    },
    viteStaticCopy({
      targets: [
        {
          src: normalizePath(resolve(__dirname, './node_modules/three/examples/jsm/libs/basis/basis_transcoder.*')),
          dest: 'lib',
        },
        {
          src: normalizePath(resolve(__dirname, './node_modules/three/examples/jsm/libs/draco/gltf/')),
          dest: 'lib/draco',
        },
      ],
    }),
  ],
  base: './',   // relative paths so the build works in any subfolder
  build: {
    rollupOptions: {
      input: {
        racing: resolve(__dirname, 'racing/index.html'),
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5174,
  },
  optimizeDeps: {
    exclude: ['@sparkjsdev/spark'],
  },
});
