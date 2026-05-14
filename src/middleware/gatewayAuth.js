/**
 * gatewayAuth.js – middleware that verifies x-viverse-api-key against the
 * capability-gateway and injects verified identity headers.
 *
 * Verified headers injected (trusted by downstream handlers):
 *   x-viverse-verified      "1"
 *   x-viverse-service-id    e.g. "viverse-ai-agent"
 *   x-viverse-tenant-id     e.g. "tenant-123"  (empty string = platform-wide)
 *   x-viverse-capabilities  JSON array string, e.g. '["llm_generate","web_search"]'
 *
 * Usage:
 *   import { requireGatewayToken, optionalGatewayToken } from './middleware/gatewayAuth.js';
 *
 *   // Hard-require a valid token:
 *   router.post('/secure', requireGatewayToken, handler);
 *
 *   // Attach claims if present, but don't block unauthenticated requests:
 *   router.post('/public', optionalGatewayToken, handler);
 */

import fetch from 'node-fetch';
import logger from '../utils/logger.js';

const GATEWAY_VERIFY_URL =
  process.env.CAPABILITY_GATEWAY_URL
    ? `${process.env.CAPABILITY_GATEWAY_URL.replace(/\/$/, '')}/auth/verify`
    : 'http://127.0.0.1:4000/auth/verify';

/**
 * Call the gateway's /auth/verify endpoint and return the claims object,
 * or null if the token is invalid/missing.
 */
async function verifyWithGateway(apiKey) {
  if (!apiKey) return null;
  try {
    const res = await fetch(GATEWAY_VERIFY_URL, {
      method: 'POST',
      headers: { 'x-viverse-api-key': apiKey },
      // Short timeout — this is on the hot path.
      signal: AbortSignal.timeout(3000),
    });
    const body = await res.json();
    if (body.valid === true) return body;
    logger.warn(`[gatewayAuth] token rejected: ${body.reason}`);
    return null;
  } catch (err) {
    logger.error(`[gatewayAuth] gateway unreachable: ${err.message}`);
    return null;
  }
}

/**
 * requireGatewayToken – 401 if missing or invalid token.
 */
export async function requireGatewayToken(req, res, next) {
  const apiKey = extractKey(req);
  const claims = await verifyWithGateway(apiKey);
  if (!claims) {
    return res.status(401).json({ error: 'Invalid or missing x-viverse-api-key' });
  }
  attachHeaders(req, claims);
  next();
}

/**
 * optionalGatewayToken – injects claims if present, passes through otherwise.
 */
export async function optionalGatewayToken(req, res, next) {
  const apiKey = extractKey(req);
  if (apiKey) {
    const claims = await verifyWithGateway(apiKey);
    if (claims) attachHeaders(req, claims);
  }
  next();
}

function extractKey(req) {
  const header = req.headers['x-viverse-api-key'];
  if (header) return header;
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

function attachHeaders(req, claims) {
  req.headers['x-viverse-verified']     = '1';
  req.headers['x-viverse-service-id']   = claims.serviceId  || '';
  req.headers['x-viverse-tenant-id']    = claims.tenantId   || '';
  req.headers['x-viverse-capabilities'] = JSON.stringify(claims.capabilities || []);
}
