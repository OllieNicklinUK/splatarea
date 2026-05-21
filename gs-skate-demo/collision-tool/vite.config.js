import { resolve } from 'path';
import { tmpdir } from 'os';
import { defineConfig } from 'vite';
import fs from 'fs';

// ── superspl.at URL helper ─────────────────────────────────────────────────────
// Returns the scene ID if the URL is a superspl.at viewer link, else null.
function _superSplatId(url) {
  try {
    const u = new URL(url);
    if ((u.hostname === 'superspl.at' || u.hostname === 'www.superspl.at') && u.searchParams.has('id')) {
      return u.searchParams.get('id');
    }
  } catch {}
  return null;
}

// Standard Gaussian splat PLY property order (must match what Spark/GS loaders expect)
const PLY_PROPS = [
  'x','y','z',
  'nx','ny','nz',
  'f_dc_0','f_dc_1','f_dc_2',
  'opacity',
  'scale_0','scale_1','scale_2',
  'rot_0','rot_1','rot_2','rot_3',
];

// Fetches a superspl.at scene via @playcanvas/splat-transform and writes a
// full-fidelity binary PLY (all Gaussian parameters) to outputPlyPath.
// The resulting file is both renderable by the Spark splat viewer AND
// parseable by the voxelizer (which only reads x/y/z/opacity).
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

  // Build column map — present columns get their data, absent ones (e.g. nx/ny/nz) get zeros
  const colMap = new Map(dt.columns.map(c => [c.name, c.data]));
  const activeProps = PLY_PROPS.filter(p => colMap.has(p) || ['nx','ny','nz'].includes(p));

  const headerLines = [
    'ply',
    'format binary_little_endian 1.0',
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
      const val = colMap.has(p) ? colMap.get(p)[i] : 0;
      buf.writeFloatLE(val, offset);
      offset += 4;
    }
  }
  fs.writeFileSync(outputPlyPath, buf);
  send({ type: 'log', text: `PLY written (${(buf.length / 1e6).toFixed(1)} MB, ${count.toLocaleString()} vertices, ${activeProps.length} props each).` });
}

export default defineConfig({
  plugins: [
    // ── COEP/COOP headers — required for SharedArrayBuffer in the splat sorter ──
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

    // ── process-splat: accept raw PLY bytes, voxelize server-side, return GLB ──
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
          // GLB lives only in tmpDir — served via /api/collision-mesh/:jobId.
          // Nothing is written to public/collisions so files don't accumulate.
          const glbUrl  = `/api/collision-mesh/${jobId}`;

          jobs.set(jobId, { status: 'uploading', glbPath, tmpDir, createdAt: Date.now() });

          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          const send = (obj) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };

          const qIdx = req.url.indexOf('?');
          const qs   = qIdx === -1 ? {} : Object.fromEntries(new URLSearchParams(req.url.slice(qIdx + 1)));
          const seedPos    = qs.seedPos  || '0,1,0';
          const voxelSz    = parseFloat(qs.voxelSize)        || 0.10;
          const opThresh   = parseFloat(qs.opacityThreshold) || 0.20;
          const remoteUrl  = qs.url || null;

          if (remoteUrl) {
            // ── Remote URL mode ───────────────────────────────────────────────
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
                send({ type: 'error', text: 'Unsupported URL. Provide a direct .ply link or a superspl.at viewer URL (https://superspl.at/s?id=…).' });
                res.end(); return;
              }
            } catch (e) {
              send({ type: 'error', text: `Fetch failed: ${e.message}` });
              res.end(); return;
            }
          } else {
            // ── Upload mode ───────────────────────────────────────────────────
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
            const voxMod = await import('./scripts/ply-voxelizer.mjs');
            const voxFn  = voxMod.voxelizePlyQuality;
            const { plyFloorY, splatOffsetX, splatOffsetY, splatOffsetZ } =
              await voxFn(plyPath, seedPos, voxelSz, glbPath, (t) => send({ type: 'log', text: t }), opThresh);
            // Mirror to splat-arena racing folder.
            // PLY: hard-link (zero extra bytes — same filesystem on macOS/Linux).
            //      Falls back to copy only if link fails (e.g. cross-device).
            // GLB: small copy (typically 1–20 MB).
            let racingReady = false;
            try {
              const arenaDir = resolve(__dirname, '../skate-game/public/racing');
              fs.mkdirSync(arenaDir, { recursive: true });
              const destPly = resolve(arenaDir, 'uploaded.ply');
              const destGlb = resolve(arenaDir, 'uploaded.collision.glb');
              try { fs.unlinkSync(destPly); } catch {}
              try { fs.linkSync(plyPath, destPly); }
              catch { fs.copyFileSync(plyPath, destPly); }
              fs.copyFileSync(glbPath, destGlb);
              racingReady = true;
              send({ type: 'log', text: '→ Linked to racing folder (no extra disk usage).' });
            } catch (e) {
              send({ type: 'log', text: `Note: racing folder write failed: ${e.message}` });
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
  ],

  server: {
    host: '127.0.0.1',
    port: 3030,
    open: '/',
  },
});
