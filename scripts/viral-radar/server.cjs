'use strict';
/**
 * Viral Radar — a local proxy and the page that uses it.
 *
 *   SCRAPE_CREATORS_API_KEY=... node scripts/viral-radar/server.cjs
 *
 * The page is served from here so it can call /api/viral-radar/search on its own
 * origin: no CORS, and no reason for the browser to ever hold the API key or
 * address the provider itself.
 *
 * Bound to 127.0.0.1 on purpose. This proxy has no authentication, so anything
 * that can reach it can spend the account's quota; keeping it on the loopback
 * interface is what stands in for a login.
 *
 * Zero dependencies — node:http, global fetch and node:test are all already
 * present on the Node version this repo uses.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { searchTikTok, readConfig, hasApiKey, redact, UpstreamError } = require('./scrape-creators.cjs');
const { loadFieldMap, normalizeSearchResponse } = require('./normalize.cjs');

const HOST = '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');

const DEFAULT_PERIODS = ['24h', '7d', '30d', '90d', '180d', 'all'];
const DEFAULT_SORTS = ['relevance', 'likes', 'date'];
const MAX_QUERY_LEN = 100;
const MAX_CURSOR_LEN = 512;

function listFromEnv(value, fallback){
  if(!value) return fallback;
  const parts = String(value).split(',').map(s => s.trim()).filter(Boolean);
  return parts.length ? parts : fallback;
}

function settings(env = process.env){
  return {
    port: Number(env.VIRAL_RADAR_PORT) > 0 ? Number(env.VIRAL_RADAR_PORT) : 8787,
    maxResults: Number(env.VIRAL_RADAR_MAX_RESULTS) > 0 ? Math.min(Number(env.VIRAL_RADAR_MAX_RESULTS), 100) : 50,
    periods: listFromEnv(env.VIRAL_RADAR_PERIODS, DEFAULT_PERIODS),
    sorts: listFromEnv(env.VIRAL_RADAR_SORTS, DEFAULT_SORTS),
  };
}

class BadRequest extends Error {
  constructor(message){ super(message); this.name = 'BadRequest'; }
}

/**
 * Validate before anything is sent upstream, so a malformed request costs no
 * quota. Everything is allowlisted rather than sanitised: unknown values are
 * rejected instead of being passed through and hoped for.
 */
function validateSearchInput(searchParams, cfg){
  const query = (searchParams.get('query') || '').trim();
  if(!query) throw new BadRequest('query is required');
  if(query.length > MAX_QUERY_LEN) throw new BadRequest(`query must be ${MAX_QUERY_LEN} characters or fewer`);

  const period = (searchParams.get('period') || '').trim();
  if(period && !cfg.periods.includes(period)){
    throw new BadRequest(`period must be one of: ${cfg.periods.join(', ')}`);
  }

  const sort = (searchParams.get('sort') || '').trim();
  if(sort && !cfg.sorts.includes(sort)){
    throw new BadRequest(`sort must be one of: ${cfg.sorts.join(', ')}`);
  }

  const region = (searchParams.get('region') || '').trim();
  if(region && !/^[A-Za-z]{2}$/.test(region)){
    throw new BadRequest('region must be a two-letter country code');
  }

  const cursor = (searchParams.get('cursor') || '').trim();
  if(cursor.length > MAX_CURSOR_LEN) throw new BadRequest('cursor is too long');
  // Checked by code point rather than a regex: writing a control-character
  // class puts literal NUL bytes in this file, which makes every text tool
  // treat the source as binary.
  if(Array.from(cursor).some(ch => ch.charCodeAt(0) < 32)) throw new BadRequest('cursor contains control characters');

  const limitRaw = (searchParams.get('limit') || '').trim();
  let limit = cfg.maxResults;
  if(limitRaw){
    const n = Number(limitRaw);
    if(!Number.isInteger(n) || n < 1) throw new BadRequest('limit must be a positive integer');
    limit = Math.min(n, cfg.maxResults);
  }

  return { query, period, sort, region: region.toUpperCase(), cursor, limit };
}

/**
 * Our parameter names -> the provider's. This mapping is the whole reason the
 * page is not coupled to the provider: rename a parameter upstream and only
 * this object changes.
 */
function toUpstreamParams(input){
  return {
    query: input.query,
    date_posted: input.period || undefined,
    sort_by: input.sort || undefined,
    region: input.region || undefined,
    cursor: input.cursor || undefined,
  };
}

function sendJson(res, status, payload){
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

const ERROR_STATUS = {
  missing_api_key: 500,
  upstream_auth_failed: 502,
  upstream_rate_limited: 429,
  upstream_unavailable: 502,
  upstream_rejected: 502,
  upstream_timeout: 504,
  upstream_unreachable: 502,
  upstream_bad_json: 502,
};

/**
 * The search handler, separated from the HTTP plumbing so tests can drive it
 * directly with an injected fetch.
 */
async function handleSearch(searchParams, opts = {}){
  const env = opts.env || process.env;
  const cfg = settings(env);
  const input = validateSearchInput(searchParams, cfg);

  const body = await searchTikTok(toUpstreamParams(input), { env, fetchImpl: opts.fetchImpl });

  const fieldMap = opts.fieldMap || loadFieldMap(env);
  const normalized = normalizeSearchResponse(body, { fieldMap, limit: input.limit });

  // Built field by field from normalized data. The upstream body is never
  // spread in, so nothing unexpected — and nothing secret — can ride along.
  return {
    query: { query: input.query, period: input.period || null, sort: input.sort || null, region: input.region || null },
    count: normalized.items.length,
    items: normalized.items,
    nextCursor: normalized.nextCursor,
  };
}

const CONTENT_TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

function serveStatic(req, res, urlPath){
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);
  // Containment check: a crafted path must not escape the public directory.
  if(!filePath.startsWith(PUBLIC_DIR + path.sep)){
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if(err){ res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream',
      'cache-control': 'no-store',
      // Thumbnails come from the provider's CDN, so images are allowed from
      // https; scripts and styles stay local to this page.
      'content-security-policy': "default-src 'self'; img-src https: data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'",
    });
    res.end(data);
  });
}

function createServer(opts = {}){
  const env = opts.env || process.env;
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${HOST}`);

    if(url.pathname === '/api/viral-radar/search'){
      if(req.method !== 'GET'){ sendJson(res, 405, { error: { code: 'method_not_allowed', message: 'Use GET' } }); return; }
      try{
        const payload = await handleSearch(url.searchParams, { env, fetchImpl: opts.fetchImpl });
        sendJson(res, 200, payload);
      }catch(err){
        if(err instanceof BadRequest){
          sendJson(res, 400, { error: { code: 'invalid_request', message: err.message } });
          return;
        }
        if(err instanceof UpstreamError){
          // Logged locally with the key scrubbed; the client sees only our code.
          console.error('[viral-radar] upstream:', redact(`${err.code} ${err.message}`, env));
          sendJson(res, ERROR_STATUS[err.code] || 502, { error: { code: err.code, message: err.message } });
          return;
        }
        console.error('[viral-radar] unexpected:', redact(err && err.stack ? err.stack : String(err), env));
        sendJson(res, 500, { error: { code: 'internal_error', message: 'Something went wrong on the proxy' } });
      }
      return;
    }

    if(req.method === 'GET' && !url.pathname.startsWith('/api/')){
      serveStatic(req, res, url.pathname);
      return;
    }
    sendJson(res, 404, { error: { code: 'not_found', message: 'No such endpoint' } });
  });
}

if(require.main === module){
  const cfg = settings();
  const scCfg = readConfig();
  const server = createServer();
  server.listen(cfg.port, HOST, () => {
    console.log(`[viral-radar] http://${HOST}:${cfg.port}`);
    // Presence only — the value itself is never printed.
    console.log(`[viral-radar] API key: ${hasApiKey() ? 'loaded from SCRAPE_CREATORS_API_KEY' : 'MISSING — searches will fail until it is set'}`);
    console.log(`[viral-radar] upstream: ${scCfg.baseUrl}${scCfg.tiktokSearchPath}`);
  });
}

module.exports = { createServer, handleSearch, validateSearchInput, toUpstreamParams, settings, BadRequest };
