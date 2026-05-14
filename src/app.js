import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';
import compression from 'compression';
import logger from './utils/logger.js';
import aiRoutes from './routes/aiRoutes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Cache TTLs (in seconds)
const ONE_YEAR_S  = 31_536_000;   // images, favicon — content-addressed in practice
const ONE_HOUR_S  = 3_600;        // CSS / JS — revalidated via ETag on miss
const NO_CACHE    = 0;            // HTML — always revalidate so deploys propagate

/**
 * Returns the ideal max-age for a given URL path.
 * HTML → 0 (must-revalidate)
 * Images / favicon → 1 year + immutable
 * Everything else (CSS, JS) → 1 hour (ETag revalidation on miss)
 */
function resolveMaxAge(urlPath) {
    if (urlPath.endsWith('.html') || urlPath === '/') return NO_CACHE;
    if (/\.(png|jpe?g|gif|webp|svg|ico|avif)$/i.test(urlPath)) return ONE_YEAR_S;
    return ONE_HOUR_S;
}

const app = express();

// Gzip / Brotli compression for text assets
app.use(compression());

app.use(cors());
app.use(express.json({ limit: '80mb' }));
app.use(express.urlencoded({ extended: true, limit: '80mb' }));

// ── Static asset serving with CDN-style cache tiers ──────────────────────────
//
//  Images & icons  → Cache-Control: public, max-age=31536000, immutable
//                    (browsers keep them for 1 year; ETag still present for
//                     manual busts or hard-refreshes)
//
//  CSS / JS        → Cache-Control: public, max-age=3600
//                    (1-hour TTL; browser revalidates via ETag — 304 on hit)
//
//  HTML            → Cache-Control: no-cache
//                    (forces revalidation every request so new deploys are
//                     picked up immediately without a hard-refresh)
//
app.use((req, res, next) => {
    const maxAge = resolveMaxAge(req.path);
    if (maxAge === NO_CACHE) {
        res.setHeader('Cache-Control', 'no-cache');
    } else if (/\.(png|jpe?g|gif|webp|svg|ico|avif)$/i.test(req.path)) {
        res.setHeader('Cache-Control', `public, max-age=${maxAge}, immutable`);
    } else {
        res.setHeader('Cache-Control', `public, max-age=${maxAge}`);
    }
    next();
}, express.static(PUBLIC_DIR, {
    etag: true,          // ETag header for conditional GET (304 Not Modified)
    lastModified: true,  // Last-Modified header for HTTP/1.0 clients
    maxAge: 0,           // Let the middleware above own Cache-Control
}));

// Request logging middleware
app.use((req, res, next) => {
    logger.info(`${req.method} ${req.url}`);
    next();
});
// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        service: 'viverse-ai-agent-server'
    });
});

// Chrome DevTools well-known probe — suppress CSP console noise in Chrome 136+
app.get('/.well-known/appspecific/com.chrome.devtools.json', (req, res) => {
    res.json({});
});

// AI Routes
app.use('/api/ai', aiRoutes);

export default app;
