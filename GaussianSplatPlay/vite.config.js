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
    // Vite's import-analysis rewrites that to a relative path, producing a URL like
    // /node_modules/@sparkjsdev/spark/dist/data:application/wasm;base64,...
    // which is too long for Node.js to parse (431). Two-part fix:
    //   1. package.json "dev" uses `node --max-http-header-size=1048576` so Node.js
    //      can parse the long URL at all.
    //   2. This middleware intercepts the mangled request, decodes the embedded
    //      base64 directly from the URL path, and returns the raw WASM bytes.
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
          src: normalizePath(resolve(__dirname, './node_modules/@polygon-streaming/web-player-threejs/dist/service-worker.js')),
          dest: ''
        },
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
    {
      name: 'models-scanner',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url === '/__models') {
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
              for (const { dir, prefix } of dirs) {
                scanDir(dir, prefix, files);
              }
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(files));
            } catch (e) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: e.message }));
            }
            return;
          }
          next();
        });
      }
    },
    {
      name: 'restart-plugin',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url === '/__restart_server') {
            res.statusCode = 200;
            res.end('ok');
            setTimeout(() => {
              server.restart();
            }, 100);
            return;
          }
          next();
        });
      }
    },
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
    // ── splat-transform collision mesh generation ───────────────────────────
    // POST /api/gen-collision — runs `splat-transform -K` on a server-side PLY,
    // streams stdout/stderr as SSE, writes .collision.glb next to the .sog output
    // in public/ so Vite serves it automatically.
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

          const send = (obj) => {
            if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
          };

          // Resolve PLY path, following symlinks
          const publicRoot = resolve(__dirname, 'public');
          const linkPath   = resolve(publicRoot, plyUrl.replace(/^\//, ''));
          let realPly;
          try { realPly = fs.realpathSync(linkPath); }
          catch (e) { send({ type: 'error', text: `Cannot resolve ${plyUrl}: ${e.message}` }); res.end(); return; }

          // Output .sog + .collision.glb to public/ so Vite serves them
          const relNoExt   = plyUrl.replace(/^\//, '').replace(/\.ply$/i, '');
          const outDir     = resolve(publicRoot, relNoExt.split('/').slice(0, -1).join('/'));
          const baseName   = relNoExt.split('/').pop();
          const sogOut     = resolve(outDir, `${baseName}.sog`);
          const glbOut     = resolve(outDir, `${baseName}.collision.glb`);
          const glbUrl     = `/${relNoExt}.collision.glb`;

          const forceRegen = force === true || force === '1';
          if (!forceRegen && fs.existsSync(glbOut)) {
            send({ type: 'done', url: glbUrl, cached: true });
            res.end(); return;
          }
          if (forceRegen && fs.existsSync(glbOut)) {
            try { fs.unlinkSync(glbOut); } catch {}
          }

          fs.mkdirSync(outDir, { recursive: true });

          const seed = [seedX, seedY, seedZ].map(v => Number(v).toFixed(4)).join(',');
          const args = [
            realPly,
            '--seed-pos',    seed,
            '--voxel-params', `${voxelFloor || 0.05},${voxelWall || 0.1}`,
            '--voxel-carve',  `${carveH     || 1.6 },${carveR    || 0.2 }`,
            '-K',
            sogOut,
          ];

          send({ type: 'log', text: `splat-transform ${args.slice(1).join(' ')}` });

          const bin = process.env.SPLAT_TRANSFORM_BIN || 'splat-transform';
          const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

          const relay = (d) =>
            d.toString().split('\n').filter(l => l.trim())
              .forEach(l => send({ type: 'log', text: l }));
          proc.stdout.on('data', relay);
          proc.stderr.on('data', relay);

          const runFallback = async () => {
            send({ type: 'log', text: 'splat-transform unavailable — using built-in Node.js voxelizer…' });
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
          };

          proc.on('error', async (err) => {
            // Binary not found or incompatible — fall back to Node.js voxelizer
            await runFallback();
          });

          proc.on('close', async (code) => {
            if (code === 0 && fs.existsSync(glbOut)) {
              send({ type: 'done', url: glbUrl });
              res.end();
            } else {
              // Non-zero exit (e.g. macOS version mismatch) — try fallback
              send({ type: 'log', text: `splat-transform exited ${code}` });
              await runFallback();
            }
          });
        });
      }
    },
    // ── Splat upload + collision generation pipeline ────────────────────────
    // POST /api/process-splat?seedPos=x,y,z&voxelParams=…&voxelCarve=…
    //   Body: raw PLY bytes (application/octet-stream)
    //   Response: SSE stream → { type:'log'|'done'|'error', ... }
    //   On done: { type:'done', jobId } — use jobId to fetch the collision GLB
    //
    // GET /api/collision-mesh/:jobId
    //   Streams the generated .collision.glb
    //
    // Temp files live in os.tmpdir()/fps-splat-<jobId>/ and are cleaned up
    // after 10 minutes.
    {
      name: 'process-splat',
      configureServer(server) {
        // In-memory job store: jobId → { status, glbPath, tmpDir, createdAt }
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

        // POST /api/process-splat
        server.middlewares.use('/api/process-splat', async (req, res) => {
          if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }

          cleanupOldJobs();

          const jobId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
          const tmpDir = resolve(tmpdir(), `fps-splat-${jobId}`);
          fs.mkdirSync(tmpDir, { recursive: true });

          const plyPath = resolve(tmpDir, 'scene.ply');
          const sogPath = resolve(tmpDir, 'scene.sog');
          const glbPath = resolve(tmpDir, 'scene.collision.glb');

          // Persistent output: public/splats/collisions/<jobId>.collision.glb
          // Vite serves this at /splats/collisions/<jobId>.collision.glb
          const persistDir = resolve(__dirname, 'public', 'splats', 'collisions');
          fs.mkdirSync(persistDir, { recursive: true });
          const persistGlb = resolve(persistDir, `${jobId}.collision.glb`);
          const persistUrl = `/splats/collisions/${jobId}.collision.glb`;

          const markDone = () => {
            try { fs.copyFileSync(glbPath, persistGlb); } catch {}
            jobs.get(jobId).status = 'done';
            jobs.get(jobId).glbPath = persistGlb;
            send({ type: 'done', jobId, url: persistUrl });
            res.end();
          };

          jobs.set(jobId, { status: 'uploading', glbPath, tmpDir, createdAt: Date.now() });

          // Set up SSE
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');

          const send = (obj) => {
            if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
          };

          // Parse query params for splat-transform flags
          const qIdx = req.url.indexOf('?');
          const qs = qIdx === -1 ? {} : Object.fromEntries(new URLSearchParams(req.url.slice(qIdx + 1)));
          const seedPos         = qs.seedPos         || '0,1,0';
          const voxelParams     = qs.voxelParams     || '0.1,0.15';
          const voxelCarve      = qs.voxelCarve      || '1.6,0.5';
          const opacityThreshUP = parseFloat(qs.opacityThreshold) || 0.2;

          // Stream PLY bytes directly to disk
          try {
            send({ type: 'log', text: `Receiving PLY…` });
            const writeStream = fs.createWriteStream(plyPath);
            req.pipe(writeStream);
            await new Promise((resolve, reject) => {
              writeStream.on('finish', resolve);
              writeStream.on('error', reject);
            });
          } catch (e) {
            send({ type: 'error', text: `Upload failed: ${e.message}` });
            res.end(); return;
          }

          const plySize = fs.statSync(plyPath).size;
          send({ type: 'log', text: `PLY received (${(plySize / 1e6).toFixed(1)} MB). Running splat-transform…` });
          jobs.get(jobId).status = 'processing';

          const bin = process.env.SPLAT_TRANSFORM_BIN || 'splat-transform';
          const args = [
            plyPath,
            '--seed-pos',    seedPos,
            '--voxel-params', voxelParams,
            '--voxel-carve',  voxelCarve,
            '-K',
            sogPath,
          ];
          send({ type: 'log', text: `${bin} ${args.slice(1).join(' ')}` });

          const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
          const relay = (d) =>
            d.toString().split('\n').filter(l => l.trim())
              .forEach(l => send({ type: 'log', text: l }));
          proc.stdout.on('data', relay);
          proc.stderr.on('data', relay);

          const runFallbackUpload = async () => {
            send({ type: 'log', text: 'splat-transform unavailable — using built-in Node.js voxelizer…' });
            try {
              const { voxelizePly } = await import('./scripts/ply-voxelizer.mjs');
              const voxelSize = parseFloat(voxelParams.split(',')[0]) || 0.1;
              await voxelizePly(plyPath, seedPos, voxelSize, glbPath, (t) => send({ type: 'log', text: t }), opacityThreshUP);
              markDone();
            } catch (e) {
              jobs.get(jobId).status = 'error';
              send({ type: 'error', text: `Voxelizer failed: ${e.message}` });
              res.end();
            }
          };

          proc.on('error', async () => {
            await runFallbackUpload();
          });

          proc.on('close', async (code) => {
            if (code === 0 && fs.existsSync(glbPath)) {
              markDone();
            } else {
              send({ type: 'log', text: `splat-transform exited ${code}` });
              await runFallbackUpload();
            }
          });
        });

        // GET /api/collision-mesh/:jobId
        // connect strips the mount prefix, so req.url is "/<jobId>" inside the handler
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
    // ── Capture upload endpoint ─────────────────────────────────────────────
    // Browser POSTs frames here; server saves them and auto-runs the pipeline.
    {
      name: 'capture-upload',
      configureServer(server) {
        server.middlewares.use('/upload-capture', async (req, res) => {
          if (req.method !== 'POST') {
            res.statusCode = 405; res.end('Method Not Allowed'); return;
          }

          // Collect raw body
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));

          const { name, transforms, frames } = body;
          const baseDir    = resolve(__dirname, 'test-Lichtfeld');
          const captureDir = resolve(baseDir, name);
          const imagesDir  = resolve(captureDir, 'images');

          fs.mkdirSync(imagesDir, { recursive: true });

          // Write each JPEG frame
          for (const { index, data } of frames) {
            const fname = `frame_${String(index).padStart(4,'0')}.jpg`;
            fs.writeFileSync(resolve(imagesDir, fname), Buffer.from(data, 'base64'));
          }

          // Write transforms.json
          fs.writeFileSync(resolve(captureDir, 'transforms.json'), JSON.stringify(transforms, null, 2));

          console.log(`[capture] Saved ${frames.length} frames → ${captureDir}`);

          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, path: captureDir }));

          // Auto-run convert + train in background
          const python = 'python';
          const convertScript = resolve(__dirname, 'scripts', 'convert-colmap.py');
          const trainScript   = resolve(__dirname, 'scripts', 'train-splat.py');

          console.log('[capture] Running convert-colmap…');
          const convertProc = spawn(python, [convertScript, captureDir], { stdio: 'inherit' });
          convertProc.on('close', (code) => {
            if (code !== 0) { console.error('[capture] convert-colmap failed'); return; }

            // Rename transforms.json so LichtFeld loads COLMAP (with scaffold points)
            // instead of Nerfstudio (which has no point cloud initialization).
            const tfPath = resolve(captureDir, 'transforms.json');
            const bakPath = resolve(captureDir, 'transforms.json.bak');
            if (fs.existsSync(tfPath) && !fs.existsSync(bakPath)) {
              fs.renameSync(tfPath, bakPath);
              console.log('[capture] Moved transforms.json -> .bak (forcing COLMAP format)');
            }

            console.log('[capture] Running train-splat…');
            spawn(python, [trainScript, captureDir], { stdio: 'inherit' });
          });
        });
      }
    },
  ],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        hub: resolve(__dirname, 'hub.html'),
        library: resolve(__dirname, 'library.html'),
        play: resolve(__dirname, 'play.html'),
        tileTest: resolve(__dirname, 'tile-test.html'),
        splat: resolve(__dirname, 'splat.html'),
      },
    },
  },
  server: {
    host: '127.0.0.1',
    open: '/hub.html',
    port: 8080,
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
  // Spark ships its WASM as inline `data:application/wasm;base64,...` URLs.
  // Vite's dep pre-bundler rewrites those into `/node_modules/.vite/deps/data:…`
  // paths, which makes the dev server choke with a 431 (URL too long) and
  // SplatMesh fails with "BufferSource argument is empty". Excluding Spark
  // from optimizeDeps leaves the package alone, and the WASM loads fine.
  optimizeDeps: {
    exclude: ['@sparkjsdev/spark'],
  },
});
