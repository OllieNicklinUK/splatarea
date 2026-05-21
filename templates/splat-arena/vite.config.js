import { resolve, relative, sep } from 'path';
import { tmpdir } from 'os';
import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { normalizePath } from 'vite';
import fs from 'fs';

// ── superspl.at URL helper ─────────────────────────────────────────────────────
function _superSplatId(url) {
  try {
    const u = new URL(url);
    if ((u.hostname === 'superspl.at' || u.hostname === 'www.superspl.at') && u.searchParams.has('id')) {
      return u.searchParams.get('id');
    }
  } catch {}
  return null;
}

// Standard Gaussian splat PLY property order
const PLY_PROPS = [
  'x','y','z','nx','ny','nz',
  'f_dc_0','f_dc_1','f_dc_2',
  'opacity',
  'scale_0','scale_1','scale_2',
  'rot_0','rot_1','rot_2','rot_3',
];

async function _fetchSuperSplat(id, outputPlyPath, send) {
  const { readSog, UrlReadFileSystem } = await import('@playcanvas/splat-transform');
  const baseUrl = `https://d28zzqy0iyovbz.cloudfront.net/${id}/v1/`;
  const fileSystem = new UrlReadFileSystem(baseUrl);

  const _origFetch = globalThis.fetch;
  globalThis.fetch = (url, opts = {}) => {
    const urlStr = typeof url === 'string' ? url : url?.href ?? '';
    if (urlStr.includes('cloudfront.net')) {
      opts = { ...opts, headers: { Referer: 'https://superspl.at/', Origin: 'https://superspl.at', ...opts.headers } };
    }
    return _origFetch(url, opts);
  };

  send({ type: 'log', text: 'Downloading & decoding splat components (this may take a minute)…' });
  let dt;
  try {
    dt = await readSog(fileSystem, 'meta.json');
  } finally {
    globalThis.fetch = _origFetch;
  }

  const xCol = dt.columns.find(c => c.name === 'x');
  if (!xCol) throw new Error('DataTable missing x column');
  const count = xCol.data.length;
  send({ type: 'log', text: `Decoded ${count.toLocaleString()} Gaussians. Writing full PLY…` });

  const colMap = new Map(dt.columns.map(c => [c.name, c.data]));
  const activeProps = PLY_PROPS.filter(p => colMap.has(p) || ['nx','ny','nz'].includes(p));

  const headerLines = [
    'ply', 'format binary_little_endian 1.0',
    `element vertex ${count}`,
    ...activeProps.map(p => `property float ${p}`),
    'end_header',
  ];
  const header = headerLines.join('\n') + '\n';
  const floatsPerVertex = activeProps.length;
  const buf = Buffer.allocUnsafe(header.length + count * floatsPerVertex * 4);
  buf.write(header, 0, 'utf8');
  let offset = header.length;
  for (let i = 0; i < count; i++) {
    for (const p of activeProps) {
      buf.writeFloatLE(colMap.has(p) ? colMap.get(p)[i] : 0, offset);
      offset += 4;
    }
  }
  fs.writeFileSync(outputPlyPath, buf);
  send({ type: 'log', text: `PLY written (${(buf.length / 1e6).toFixed(1)} MB, ${count.toLocaleString()} vertices).` });
}

// Minimal polyfill for Spark's inline worker blob — WebAssembly.instantiateStreaming
// fails on data: URLs; fall back to WebAssembly.instantiate.
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
    // ── Patch Spark's inline WASM worker ──────────────────────────────────────
    {
      name: 'patch-spark-worker-wasm',
      transform(code, id) {
        if (!id.includes('@sparkjsdev') || !code.includes('jsContent')) return null;
        const p = JSON.stringify(WASM_POLYFILL);
        return code
          .replace(
            'new Blob([jsContent], { type: "text/javascript;charset=utf-8" })',
            `new Blob([${p}, jsContent], { type: "text/javascript;charset=utf-8" })`,
          )
          .replace(
            '"data:text/javascript;charset=utf-8," + encodeURIComponent(jsContent)',
            `"data:text/javascript;charset=utf-8," + encodeURIComponent(${p} + jsContent)`,
          );
      },
    },

    // ── COEP/COOP headers — required for SharedArrayBuffer ────────────────────
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

    // ── Extra static files from collision-tool/public (alleyway PLY, etc.) ───
    {
      name: 'extra-static-collision-tool',
      configureServer(server) {
        const extraDir = resolve(__dirname, '../splat-collision-tool/public');
        server.middlewares.use((req, res, next) => {
          const urlPath = (req.url || '/').split('?')[0];
          const filePath = resolve(extraDir, urlPath.replace(/^\//, ''));
          if (!filePath.startsWith(extraDir + '/')) { next(); return; }
          fs.stat(filePath, (err, stat) => {
            if (err || !stat.isFile()) { next(); return; }
            const ext = filePath.split('.').pop().toLowerCase();
            const mimes = {
              ply: 'application/octet-stream', glb: 'model/gltf-binary',
              zip: 'application/zip', js: 'text/javascript', html: 'text/html',
              css: 'text/css', png: 'image/png', jpg: 'image/jpeg', wasm: 'application/wasm',
            };
            res.setHeader('Content-Type', mimes[ext] || 'application/octet-stream');
            res.setHeader('Content-Length', stat.size);
            res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
            fs.createReadStream(filePath).pipe(res);
          });
        });
      },
    },

    // ── process-splat: upload/URL → voxelize → GLB (SSE stream) ──────────────
    {
      name: 'process-splat',
      configureServer(server) {
        const jobs = new Map();

        function cleanupOldJobs() {
          const TTL = 15 * 60 * 1000;
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
          const tmpDir = resolve(tmpdir(), `collision-tool-${jobId}`);
          fs.mkdirSync(tmpDir, { recursive: true });

          const plyPath = resolve(tmpDir, 'scene.ply');
          const glbPath = resolve(tmpDir, 'scene.collision.glb');
          const glbUrl  = `/api/collision-mesh/${jobId}`;

          jobs.set(jobId, { status: 'uploading', glbPath, tmpDir, createdAt: Date.now() });

          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          const send = (obj) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };

          const qIdx = req.url.indexOf('?');
          const qs   = qIdx === -1 ? {} : Object.fromEntries(new URLSearchParams(req.url.slice(qIdx + 1)));
          const seedPos   = qs.seedPos  || '0,1,0';
          const voxelSz   = parseFloat(qs.voxelSize)        || 0.10;
          const opThresh  = parseFloat(qs.opacityThreshold) || 0.20;
          const remoteUrl = qs.url || null;
          const mode      = qs.mode || 'quality';

          // ── Voxel zip mode ────────────────────────────────────────────────
          if (mode === 'voxelzip') {
            try {
              send({ type: 'log', text: 'Receiving voxel.zip…' });
              const zipPath = resolve(tmpDir, 'scene.voxel.zip');
              const ws = fs.createWriteStream(zipPath);
              req.pipe(ws);
              await new Promise((ok, fail) => { ws.on('finish', ok); ws.on('error', fail); });
              const zipSize = fs.statSync(zipPath).size;
              send({ type: 'log', text: `Zip received (${(zipSize / 1e6).toFixed(1)} MB). Converting octree → GLB…` });
              jobs.get(jobId).status = 'processing';

              const voxMod = await import('../../standalone/scripts/ply-voxelizer.mjs');
              const result = await voxMod.voxelZipToGlb(
                zipPath, glbPath, (t) => send({ type: 'log', text: t }), seedPos,
              );

              let racingReady = false;
              try {
                for (const gameName of ['racing', 'fps', 'people', 'kart']) {
                  const arenaDir = resolve(__dirname, `public/${gameName}`);
                  fs.mkdirSync(arenaDir, { recursive: true });
                  fs.copyFileSync(glbPath, resolve(arenaDir, 'uploaded.collision.glb'));
                }
                racingReady = true;
                send({ type: 'log', text: '→ Collision mesh copied to game folders.' });
              } catch (e) {
                send({ type: 'log', text: `Note: game folder write failed: ${e.message}` });
              }

              jobs.get(jobId).status = 'done';
              send({ type: 'done', jobId, url: glbUrl, racingReady,
                plyFloorY:    result.plyFloorY    ?? null,
                splatOffsetX: result.splatOffsetX ?? 0,
                splatOffsetY: result.splatOffsetY ?? 0,
                splatOffsetZ: result.splatOffsetZ ?? 0,
              });
            } catch (e) {
              jobs.get(jobId).status = 'error';
              send({ type: 'error', text: `Voxel zip failed: ${e.message}` });
            }
            res.end();
            return;
          }

          if (remoteUrl) {
            // ── Remote URL mode ─────────────────────────────────────────────
            try {
              const sogId = _superSplatId(remoteUrl);
              if (sogId) {
                send({ type: 'log', text: `Detected superspl.at scene ${sogId}. Fetching…` });
                await _fetchSuperSplat(sogId, plyPath, send);
              } else if (/\.ply(\?.*)?$/i.test(remoteUrl)) {
                send({ type: 'log', text: `Fetching PLY from ${remoteUrl}…` });
                const resp = await fetch(remoteUrl);
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const buf = await resp.arrayBuffer();
                fs.writeFileSync(plyPath, Buffer.from(buf));
                send({ type: 'log', text: `PLY downloaded (${(buf.byteLength / 1e6).toFixed(1)} MB).` });
              } else {
                send({ type: 'error', text: 'Unsupported URL. Provide a direct .ply link or a superspl.at viewer URL.' });
                res.end(); return;
              }
            } catch (e) {
              send({ type: 'error', text: `Fetch failed: ${e.message}` });
              res.end(); return;
            }
          } else {
            // ── Upload mode ─────────────────────────────────────────────────
            try {
              send({ type: 'log', text: 'Receiving PLY…' });
              const ws = fs.createWriteStream(plyPath);
              req.pipe(ws);
              await new Promise((ok, fail) => { ws.on('finish', ok); ws.on('error', fail); });
            } catch (e) {
              send({ type: 'error', text: `Upload failed: ${e.message}` });
              res.end(); return;
            }
          }

          const plySize = fs.statSync(plyPath).size;
          send({ type: 'log', text: `PLY ready (${(plySize / 1e6).toFixed(1)} MB). Running quality voxelizer…` });
          jobs.get(jobId).status = 'processing';

          try {
            const voxMod = await import('../../standalone/scripts/ply-voxelizer.mjs');
            const voxFn  = voxMod.voxelizePlyQuality;
            const { plyFloorY, splatOffsetX, splatOffsetY, splatOffsetZ } =
              await voxFn(plyPath, seedPos, voxelSz, glbPath, (t) => send({ type: 'log', text: t }), opThresh);

            let racingReady = false;
            try {
              for (const gameName of ['racing', 'fps', 'people', 'kart']) {
                const arenaDir = resolve(__dirname, `public/${gameName}`);
                fs.mkdirSync(arenaDir, { recursive: true });
                const destPly = resolve(arenaDir, 'uploaded.ply');
                const destGlb = resolve(arenaDir, 'uploaded.collision.glb');
                try { fs.unlinkSync(destPly); } catch {}
                try { fs.linkSync(plyPath, destPly); }
                catch { fs.copyFileSync(plyPath, destPly); }
                fs.copyFileSync(glbPath, destGlb);
              }
              racingReady = true;
              send({ type: 'log', text: '→ Linked to racing/fps/people/kart folders.' });
            } catch (e) {
              send({ type: 'log', text: `Note: game folder write failed: ${e.message}` });
            }

            jobs.get(jobId).status = 'done';
            send({ type: 'done', jobId, url: glbUrl, racingReady,
              plyFloorY:    plyFloorY    ?? null,
              splatOffsetX: splatOffsetX ?? 0,
              splatOffsetY: splatOffsetY ?? 0,
              splatOffsetZ: splatOffsetZ ?? 0,
            });
          } catch (e) {
            jobs.get(jobId).status = 'error';
            send({ type: 'error', text: `Voxelizer failed: ${e.message}` });
          }
          res.end();
        });

        // ── Serve GLB from temp dir ─────────────────────────────────────────
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

    // ── gen-collision: server-side voxelizer for games ────────────────────────
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
            const { voxelizePly } = await import('../../standalone/scripts/ply-voxelizer.mjs');
            await voxelizePly(realInput, seed, voxSize, glbOut, (t) => send({ type: 'log', text: t }), opThresh);
            send({ type: 'done', url: glbUrl });
          } catch (e) {
            send({ type: 'error', text: `Voxelizer failed: ${e.message}` });
          }
          res.end();
        });
      },
    },

    // ── ply-finder: scan public/<game>/ for PLY files ─────────────────────────
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
            found = ['uploaded.ply', 'scene.ply'].find(f => plys.includes(f)) ?? plys[0] ?? null;
          } catch {}
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(found
            ? { plyPath: `/${game}/${found}`, name: found }
            : { plyPath: null, name: null }));
        });
      },
    },

    // ── serve-inline-wasm: decode Spark's data: WASM URLs ────────────────────
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
          dest: 'lib',
        },
        {
          src: normalizePath(resolve(__dirname, './node_modules/three/examples/jsm/libs/draco/gltf/')),
          dest: 'lib/draco',
        },
        // Copy coi-serviceworker.js into each game subdirectory so relative
        // path './coi-serviceworker.js' resolves correctly from every game page.
        ...['fps', 'people', 'flight', 'racing', 'kart'].map((game) => ({
          src:  normalizePath(resolve(__dirname, 'public/coi-serviceworker.js')),
          dest: game,
        })),
      ],
    }),

    // Inject coi-serviceworker script as the very first tag in every HTML page
    // (build-only — dev server already sets COEP/COOP headers via middleware).
    {
      name: 'inject-coi-sw',
      apply: 'build',
      transformIndexHtml: {
        order: 'pre',
        handler(html, ctx) {
          // Compute depth of this HTML relative to the project root so we can
          // reference the service worker with a correct relative path.
          const rel   = relative(resolve(__dirname), ctx.filename);
          const depth = rel.split(sep).length - 1;
          const swPath = (depth > 0 ? '../'.repeat(depth) : './') + 'coi-serviceworker.js';
          return html.replace('<head>', `<head>\n<script src="${swPath}"></script>`);
        },
      },
    },
  ],

  base: './',
  build: {
    outDir:      '../../docs',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main:   resolve(__dirname, 'index.html'),
        fps:    resolve(__dirname, 'fps/index.html'),
        people: resolve(__dirname, 'people/index.html'),
        flight: resolve(__dirname, 'flight/index.html'),
        racing: resolve(__dirname, 'racing/index.html'),
        kart:   resolve(__dirname, 'kart/index.html'),
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 3030,
    fs: { allow: ['..'] },
  },
  optimizeDeps: {
    exclude: ['@sparkjsdev/spark'],
  },
});
