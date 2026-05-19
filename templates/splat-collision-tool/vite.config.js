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

// Fetches a superspl.at scene via @playcanvas/splat-transform and writes a
// minimal binary PLY (x,y,z,opacity) to outputPlyPath.
async function _fetchSuperSplat(id, outputPlyPath, send) {
  const { readSog, UrlReadFileSystem } = await import('@playcanvas/splat-transform');
  const baseUrl = `https://d28zzqy0iyovbz.cloudfront.net/${id}/v1/`;
  const fileSystem = new UrlReadFileSystem(baseUrl);

  send({ type: 'log', text: 'Downloading & decoding splat components (this may take a minute)…' });
  const dt = await readSog(fileSystem, 'meta.json');

  const xCol   = dt.columns.find(c => c.name === 'x');
  const yCol   = dt.columns.find(c => c.name === 'y');
  const zCol   = dt.columns.find(c => c.name === 'z');
  const opCol  = dt.columns.find(c => c.name === 'opacity');
  if (!xCol || !yCol || !zCol) throw new Error('DataTable missing x/y/z columns');

  const count = xCol.data.length;
  send({ type: 'log', text: `Decoded ${count.toLocaleString()} Gaussians. Writing PLY…` });

  // Write minimal binary PLY with x,y,z + opacity
  const hasOp = !!opCol;
  const header = [
    'ply',
    'format binary_little_endian 1.0',
    `element vertex ${count}`,
    'property float x',
    'property float y',
    'property float z',
    hasOp ? 'property float opacity' : null,
    'end_header',
  ].filter(Boolean).join('\n') + '\n';

  const floatsPerVertex = hasOp ? 4 : 3;
  const buf = Buffer.allocUnsafe(header.length + count * floatsPerVertex * 4);
  buf.write(header, 0, 'utf8');
  let offset = header.length;
  for (let i = 0; i < count; i++) {
    buf.writeFloatLE(xCol.data[i],  offset);      offset += 4;
    buf.writeFloatLE(yCol.data[i],  offset);      offset += 4;
    buf.writeFloatLE(zCol.data[i],  offset);      offset += 4;
    if (hasOp) { buf.writeFloatLE(opCol.data[i], offset); offset += 4; }
  }
  fs.writeFileSync(outputPlyPath, buf);
  send({ type: 'log', text: `PLY written (${(buf.length / 1e6).toFixed(1)} MB, ${count.toLocaleString()} vertices).` });
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
            const voxMod = await import('../../standalone/scripts/ply-voxelizer.mjs');
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
