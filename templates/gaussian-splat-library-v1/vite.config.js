import { resolve } from 'path';
import { tmpdir } from 'os';
import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { normalizePath } from 'vite';
import fs from 'fs';
import { spawn } from 'child_process';

export default defineConfig({
  plugins: [
    // Spark ships its WASM inline as `data:application/wasm;base64,...`.
    // Vite's import-analysis rewrites that to a relative path that is too long
    // for Node.js to parse (431). This middleware decodes it on the fly.
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
    viteStaticCopy({
      targets: [
        {
          src: normalizePath(resolve(__dirname, './node_modules/three/examples/jsm/libs/basis/basis_transcoder.*')),
          dest: 'lib'
        },
        {
          src: normalizePath(resolve(__dirname, './node_modules/three/examples/jsm/libs/draco/gltf/')),
          dest: 'lib/draco'
        }
      ]
    }),
    // ── Splat library (from project-root /public/splats) ────────────────────
    // This template lives at <root>/templates/gaussian-splat-library-v1/ and
    // has its own public/ folder. The user's curated splat collection lives
    // at <root>/public/splats/ — 2 folders up. We expose it via:
    //   GET  /__lib-splats            → JSON listing of .ply/.sog files
    //   GET  /lib-splats/<path>       → streams the file from <root>/public/splats/<path>
    // No copy/symlink needed; reads straight off disk.
    {
      name: 'project-root-splat-library',
      configureServer(server) {
        const rootSplats = resolve(__dirname, '../../public/splats');

        const scan = (baseDir, prefix, out) => {
          if (!fs.existsSync(baseDir)) return;
          for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
            const full = resolve(baseDir, entry.name);
            const url  = `${prefix}/${encodeURIComponent(entry.name)}`;
            if (entry.isDirectory()) {
              scan(full, `${prefix}/${entry.name}`, out);
            } else if (/\.(ply|sog|splat|spz|ksplat)$/i.test(entry.name)) {
              const stat = fs.statSync(full);
              out.push({
                name: entry.name,
                path: url,                          // url-encoded for fetching
                folder: prefix.split('/').pop(),    // "ply" or "sog" etc.
                type: entry.name.split('.').pop().toLowerCase(),
                sizeMB: +(stat.size / (1024 * 1024)).toFixed(1),
              });
            }
          }
        };

        server.middlewares.use((req, res, next) => {
          if (req.url === '/__lib-splats') {
            const list = [];
            try { scan(rootSplats, '/lib-splats', list); }
            catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: e.message })); return; }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(list));
            return;
          }

          if (req.url?.startsWith('/lib-splats/')) {
            // Decode + normalize, then guard against ../ escapes
            const relRaw = decodeURIComponent(req.url.slice('/lib-splats/'.length).split('?')[0]);
            const filePath = resolve(rootSplats, relRaw);
            if (!filePath.startsWith(rootSplats)) {
              res.statusCode = 403; res.end('Forbidden'); return;
            }
            if (!fs.existsSync(filePath)) { res.statusCode = 404; res.end('Not found'); return; }
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Length', fs.statSync(filePath).size);
            fs.createReadStream(filePath).pipe(res);
            return;
          }
          next();
        });
      },
    },
    // Scans public/models and public/splats, returns JSON list of 3D assets.
    {
      name: 'models-scanner',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url !== '/__models') { next(); return; }
          const exts = ['.glb', '.gltf', '.fbx', '.ply', '.obj'];
          const dirs = [
            { dir: resolve(__dirname, 'public/models'), prefix: '/models' },
            { dir: resolve(__dirname, 'public/splats'), prefix: '/splats' }
          ];
          function scanDir(baseDir, prefix, results) {
            if (!fs.existsSync(baseDir)) return;
            const entries = fs.readdirSync(baseDir, { withFileTypes: true });
            for (const entry of entries) {
              const fullPath = resolve(baseDir, entry.name);
              if (entry.isDirectory()) {
                scanDir(fullPath, `${prefix}/${entry.name}`, results);
              } else if (entry.isFile()) {
                const ext = entry.name.substring(entry.name.lastIndexOf('.')).toLowerCase();
                if (exts.includes(ext)) {
                  results.push({
                    name: entry.name.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' '),
                    path: `${prefix}/${entry.name}`,
                    type: entry.name.substring(entry.name.lastIndexOf('.') + 1).toLowerCase(),
                    folder: prefix.split('/').pop()
                  });
                }
              }
            }
          }
          try {
            const files = [];
            for (const { dir, prefix } of dirs) scanDir(dir, prefix, files);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(files));
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e.message }));
          }
        });
      }
    },
    {
      name: 'restart-plugin',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url !== '/__restart_server') { next(); return; }
          res.statusCode = 200;
          res.end('ok');
          setTimeout(() => server.restart(), 100);
        });
      }
    },
    // Required for SharedArrayBuffer used by Spark WASM renderer.
    {
      name: 'cross-origin-isolation',
      configureServer(server) {
        server.middlewares.use((_req, res, next) => {
          res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
          res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
          next();
        });
      }
    },
    // POST /api/gen-collision — runs splat-transform on a server-side PLY,
    // streams progress as SSE, falls back to built-in Node.js voxelizer.
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
          const { plyUrl, seedX, seedY, seedZ, voxelFloor, voxelWall, carveH, carveR, force, opacityThreshold } = body;
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          const send = (obj) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };
          const publicRoot = resolve(__dirname, 'public');
          const linkPath = resolve(publicRoot, plyUrl.replace(/^\//, ''));
          let realPly;
          try { realPly = fs.realpathSync(linkPath); }
          catch (e) { send({ type: 'error', text: `Cannot resolve ${plyUrl}: ${e.message}` }); res.end(); return; }
          const relNoExt = plyUrl.replace(/^\//, '').replace(/\.ply$/i, '');
          const outDir = resolve(publicRoot, relNoExt.split('/').slice(0, -1).join('/'));
          const baseName = relNoExt.split('/').pop();
          const glbOut = resolve(outDir, `${baseName}.collision.glb`);
          const sogOut = resolve(outDir, `${baseName}.sog`);
          const glbUrl = `/${relNoExt}.collision.glb`;
          const forceRegen = force === true || force === '1';
          if (!forceRegen && fs.existsSync(glbOut)) {
            send({ type: 'done', url: glbUrl, cached: true }); res.end(); return;
          }
          if (forceRegen && fs.existsSync(glbOut)) { try { fs.unlinkSync(glbOut); } catch {} }
          fs.mkdirSync(outDir, { recursive: true });
          const seed = [seedX, seedY, seedZ].map(v => Number(v).toFixed(4)).join(',');
          const args = [realPly, '--seed-pos', seed, '--voxel-params', `${voxelFloor || 0.05},${voxelWall || 0.1}`, '--voxel-carve', `${carveH || 1.6},${carveR || 0.2}`, '-K', sogOut];
          send({ type: 'log', text: `splat-transform ${args.slice(1).join(' ')}` });
          const bin = process.env.SPLAT_TRANSFORM_BIN || 'splat-transform';
          const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
          const relay = (d) => d.toString().split('\n').filter(l => l.trim()).forEach(l => send({ type: 'log', text: l }));
          proc.stdout.on('data', relay);
          proc.stderr.on('data', relay);
          const runFallback = async () => {
            send({ type: 'log', text: 'splat-transform unavailable — using built-in Node.js voxelizer…' });
            try {
              const { voxelizePly } = await import('./scripts/ply-voxelizer.mjs');
              const voxelSize = parseFloat(voxelFloor) || 0.1;
              const opThresh = parseFloat(opacityThreshold) || 0.2;
              await voxelizePly(realPly, seed, voxelSize, glbOut, (t) => send({ type: 'log', text: t }), opThresh);
              send({ type: 'done', url: glbUrl });
            } catch (e) { send({ type: 'error', text: `Voxelizer failed: ${e.message}` }); }
            res.end();
          };
          proc.on('error', runFallback);
          proc.on('close', async (code) => {
            if (code === 0 && fs.existsSync(glbOut)) { send({ type: 'done', url: glbUrl }); res.end(); }
            else { send({ type: 'log', text: `splat-transform exited ${code}` }); await runFallback(); }
          });
        });
      }
    },
    // POST /api/process-splat — upload PLY bytes, generate collision mesh, return SSE stream.
    // GET  /api/collision-mesh/:jobId — stream the resulting .collision.glb
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
          const jobId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
          const tmpDir = resolve(tmpdir(), `fps-splat-${jobId}`);
          fs.mkdirSync(tmpDir, { recursive: true });
          const plyPath = resolve(tmpDir, 'scene.ply');
          const sogPath = resolve(tmpDir, 'scene.sog');
          const glbPath = resolve(tmpDir, 'scene.collision.glb');
          const persistDir = resolve(__dirname, 'public', 'splats', 'collisions');
          fs.mkdirSync(persistDir, { recursive: true });
          const persistGlb = resolve(persistDir, `${jobId}.collision.glb`);
          const persistUrl = `/splats/collisions/${jobId}.collision.glb`;
          jobs.set(jobId, { status: 'uploading', glbPath, tmpDir, createdAt: Date.now() });
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          const send = (obj) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };
          const markDone = () => {
            try { fs.copyFileSync(glbPath, persistGlb); } catch {}
            jobs.get(jobId).status = 'done';
            jobs.get(jobId).glbPath = persistGlb;
            send({ type: 'done', jobId, url: persistUrl });
            res.end();
          };
          const qIdx = req.url.indexOf('?');
          const qs = qIdx === -1 ? {} : Object.fromEntries(new URLSearchParams(req.url.slice(qIdx + 1)));
          const seedPos = qs.seedPos || '0,1,0';
          const voxelParams = qs.voxelParams || '0.1,0.15';
          const voxelCarve = qs.voxelCarve || '1.6,0.5';
          const opacityThreshUP = parseFloat(qs.opacityThreshold) || 0.2;
          try {
            send({ type: 'log', text: 'Receiving PLY…' });
            const writeStream = fs.createWriteStream(plyPath);
            req.pipe(writeStream);
            await new Promise((resolve, reject) => { writeStream.on('finish', resolve); writeStream.on('error', reject); });
          } catch (e) { send({ type: 'error', text: `Upload failed: ${e.message}` }); res.end(); return; }
          const plySize = fs.statSync(plyPath).size;
          send({ type: 'log', text: `PLY received (${(plySize / 1e6).toFixed(1)} MB). Running splat-transform…` });
          jobs.get(jobId).status = 'processing';
          const bin = process.env.SPLAT_TRANSFORM_BIN || 'splat-transform';
          const args = [plyPath, '--seed-pos', seedPos, '--voxel-params', voxelParams, '--voxel-carve', voxelCarve, '-K', sogPath];
          send({ type: 'log', text: `${bin} ${args.slice(1).join(' ')}` });
          const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
          const relay = (d) => d.toString().split('\n').filter(l => l.trim()).forEach(l => send({ type: 'log', text: l }));
          proc.stdout.on('data', relay);
          proc.stderr.on('data', relay);
          const runFallbackUpload = async () => {
            send({ type: 'log', text: 'splat-transform unavailable — using built-in Node.js voxelizer…' });
            try {
              const { voxelizePly } = await import('./scripts/ply-voxelizer.mjs');
              const voxelSize = parseFloat(voxelParams.split(',')[0]) || 0.1;
              await voxelizePly(plyPath, seedPos, voxelSize, glbPath, (t) => send({ type: 'log', text: t }), opacityThreshUP);
              markDone();
            } catch (e) { jobs.get(jobId).status = 'error'; send({ type: 'error', text: `Voxelizer failed: ${e.message}` }); res.end(); }
          };
          proc.on('error', runFallbackUpload);
          proc.on('close', async (code) => {
            if (code === 0 && fs.existsSync(glbPath)) markDone();
            else { send({ type: 'log', text: `splat-transform exited ${code}` }); await runFallbackUpload(); }
          });
        });
        server.middlewares.use('/api/collision-mesh/', (req, res) => {
          const jobId = req.url.replace(/^\/+/, '').split('?')[0];
          const job = jobs.get(jobId);
          if (!job || job.status !== 'done' || !fs.existsSync(job.glbPath)) {
            res.statusCode = 404; res.end('Not found'); return;
          }
          res.setHeader('Content-Type', 'model/gltf-binary');
          res.setHeader('Cache-Control', 'max-age=3600');
          fs.createReadStream(job.glbPath).pipe(res);
        });
      }
    },
  ],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        play: resolve(__dirname, 'play.html'),
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/meshy-assets': {
        target: 'https://assets.meshy.ai',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/meshy-assets/, '')
      }
    }
  },
  envPrefix: ['VITE_', 'MESHY_'],
  optimizeDeps: {
    exclude: ['@sparkjsdev/spark'],
  },
});
