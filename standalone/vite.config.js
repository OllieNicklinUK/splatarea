import { resolve } from 'path';
import { tmpdir } from 'os';
import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { normalizePath } from 'vite';
import fs from 'fs';

export default defineConfig({
  plugins: [
    // ── Spark WASM middleware ────────────────────────────────────────────────
    // Spark ships its WASM as an inline `data:application/wasm;base64,...` URL.
    // Vite's import-analysis rewrites it to a mangled path that exceeds Node's
    // URL length limit (431). This middleware intercepts that request and
    // decodes the base64 directly from the URL, returning raw WASM bytes.
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

    // ── COEP / COOP headers ─────────────────────────────────────────────────
    // Required for WebGPU SharedArrayBuffer. Must also be set on your
    // production server — see PLAY_README.md deployment section.
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

    // ── Server collision fallback: URL-based PLY ─────────────────────────────
    // POST /api/gen-collision — tries splat-transform binary, falls back to
    // the pure Node.js voxelizer in scripts/ply-voxelizer.mjs.
    // Only used when the client-side WebGPU path fails.
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

          const { plyUrl, seedX, seedY, seedZ, voxelFloor, voxelWall, opacityThreshold } = body;

          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          const send = (obj) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };

          const publicRoot = resolve(__dirname, 'public');
          const linkPath   = resolve(publicRoot, plyUrl.replace(/^\//, ''));
          let realPly;
          try { realPly = fs.realpathSync(linkPath); }
          catch (e) { send({ type: 'error', text: `Cannot resolve ${plyUrl}: ${e.message}` }); res.end(); return; }

          const relNoExt = plyUrl.replace(/^\//, '').replace(/\.ply$/i, '');
          const outDir   = resolve(publicRoot, relNoExt.split('/').slice(0, -1).join('/'));
          const baseName = relNoExt.split('/').pop();
          const glbOut   = resolve(outDir, `${baseName}.collision.glb`);
          const glbUrl   = `/${relNoExt}.collision.glb`;

          if (fs.existsSync(glbOut)) { send({ type: 'done', url: glbUrl, cached: true }); res.end(); return; }
          fs.mkdirSync(outDir, { recursive: true });

          const seed = [seedX, seedY, seedZ].map(v => Number(v).toFixed(4)).join(',');
          send({ type: 'log', text: 'Falling back to Node.js voxelizer…' });
          try {
            const { voxelizePly } = await import('./scripts/ply-voxelizer.mjs');
            const voxelSize = parseFloat(voxelFloor) || 0.1;
            const opThresh  = parseFloat(opacityThreshold) || 0.2;
            await voxelizePly(realPly, seed, voxelSize, glbOut, (t) => send({ type: 'log', text: t }), opThresh);
            send({ type: 'done', url: glbUrl });
          } catch (e) {
            send({ type: 'error', text: `Voxelizer failed: ${e.message}` });
          }
          res.end();
        });
      },
    },

    // ── Server collision fallback: uploaded PLY buffer ───────────────────────
    // POST /api/process-splat — accepts raw PLY bytes, voxelizes server-side,
    // returns SSE stream → { type:'done', jobId } then GET /api/collision-mesh/:jobId
    {
      name: 'process-splat',
      configureServer(server) {
        const jobs = new Map();

        function cleanupOldJobs() {
          const TTL = 10 * 60 * 1000;
          const now = Date.now();
          for (const [id, job] of jobs) {
            if (now - job.createdAt > TTL) {
              try { fs.rmSync(job.tmpDir, { recursive: true, force: true }); } catch {}
              jobs.delete(id);
            }
          }
        }

        server.middlewares.use('/api/process-splat', async (req, res) => {
          if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
          cleanupOldJobs();

          const jobId  = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
          const tmpDir = resolve(tmpdir(), `fps-splat-${jobId}`);
          fs.mkdirSync(tmpDir, { recursive: true });

          const plyPath  = resolve(tmpDir, 'scene.ply');
          const glbPath  = resolve(tmpDir, 'scene.collision.glb');
          const persistDir = resolve(__dirname, 'public', 'splats', 'collisions');
          fs.mkdirSync(persistDir, { recursive: true });
          const persistGlb = resolve(persistDir, `${jobId}.collision.glb`);
          const persistUrl = `/splats/collisions/${jobId}.collision.glb`;

          jobs.set(jobId, { status: 'uploading', glbPath, tmpDir, createdAt: Date.now() });

          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          const send = (obj) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };

          const qIdx = req.url.indexOf('?');
          const qs   = qIdx === -1 ? {} : Object.fromEntries(new URLSearchParams(req.url.slice(qIdx + 1)));
          const seedPos     = qs.seedPos     || '0,1,0';
          const voxelParams = qs.voxelParams || '0.1,0.15';
          const opThreshUP  = parseFloat(qs.opacityThreshold) || 0.2;

          const markDone = () => {
            try { fs.copyFileSync(glbPath, persistGlb); } catch {}
            jobs.get(jobId).status = 'done';
            jobs.get(jobId).glbPath = persistGlb;
            send({ type: 'done', jobId, url: persistUrl });
            res.end();
          };

          try {
            send({ type: 'log', text: 'Receiving PLY…' });
            const ws = fs.createWriteStream(plyPath);
            req.pipe(ws);
            await new Promise((resolve, reject) => { ws.on('finish', resolve); ws.on('error', reject); });
          } catch (e) {
            send({ type: 'error', text: `Upload failed: ${e.message}` });
            res.end(); return;
          }

          const plySize = fs.statSync(plyPath).size;
          send({ type: 'log', text: `PLY received (${(plySize / 1e6).toFixed(1)} MB). Running voxelizer…` });
          jobs.get(jobId).status = 'processing';

          try {
            const { voxelizePly } = await import('./scripts/ply-voxelizer.mjs');
            const voxelSize = parseFloat(voxelParams.split(',')[0]) || 0.1;
            await voxelizePly(plyPath, seedPos, voxelSize, glbPath, (t) => send({ type: 'log', text: t }), opThreshUP);
            markDone();
          } catch (e) {
            jobs.get(jobId).status = 'error';
            send({ type: 'error', text: `Voxelizer failed: ${e.message}` });
            res.end();
          }
        });

        server.middlewares.use('/api/collision-mesh/', (req, res) => {
          const jobId = req.url.replace(/^\/+/, '').split('?')[0];
          const job   = jobs.get(jobId);
          if (!job || job.status !== 'done' || !fs.existsSync(job.glbPath)) {
            res.statusCode = 404; res.end('Not found'); return;
          }
          res.setHeader('Content-Type', 'model/gltf-binary');
          res.setHeader('Cache-Control', 'max-age=3600');
          fs.createReadStream(job.glbPath).pipe(res);
        });
      },
    },

    viteStaticCopy({
      targets: [
        {
          src: normalizePath(resolve(__dirname, './node_modules/three/examples/jsm/libs/draco/gltf/')),
          dest: 'lib/draco',
        },
      ],
    }),
  ],

  build: {
    rollupOptions: {
      input: {
        play: resolve(__dirname, 'play.html'),
      },
    },
  },

  server: {
    host: '127.0.0.1',
    open: '/play.html',
    port: 8080,
  },

  optimizeDeps: {
    // Spark ships WASM as inline base64 — exclude from Vite pre-bundling
    // or the URL gets mangled and the WASM middleware can't intercept it.
    exclude: ['@sparkjsdev/spark'],
  },
});
