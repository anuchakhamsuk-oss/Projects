'use strict';
/**
 * The only place the Scrape Creators API key is read or sent.
 *
 * Everything else in this app — the server, the normalizer, the page — works
 * with data that has already passed through here, so there is exactly one file
 * to audit for key handling. The key is read from the environment at call time
 * and attached as `x-api-key`; it is never returned, never logged, and never
 * put in an error.
 */

const CONFIG_DEFAULTS = {
  baseUrl: 'https://api.scrapecreators.com',
  tiktokSearchPath: '/v1/tiktok/search/keyword',
  timeoutMs: 20000,
};

function readConfig(env = process.env){
  return {
    baseUrl: (env.SCRAPE_CREATORS_BASE_URL || CONFIG_DEFAULTS.baseUrl).replace(/\/+$/, ''),
    tiktokSearchPath: env.SCRAPE_CREATORS_TIKTOK_SEARCH_PATH || CONFIG_DEFAULTS.tiktokSearchPath,
    timeoutMs: Number(env.VIRAL_RADAR_TIMEOUT_MS) > 0 ? Number(env.VIRAL_RADAR_TIMEOUT_MS) : CONFIG_DEFAULTS.timeoutMs,
  };
}

function hasApiKey(env = process.env){
  return typeof env.SCRAPE_CREATORS_API_KEY === 'string' && env.SCRAPE_CREATORS_API_KEY.trim().length > 0;
}

/**
 * Replace the key with a marker anywhere it appears in text headed for a log.
 * Cheap insurance: an upstream error message could echo back what was sent, and
 * this runs on the way to the console either way.
 */
function redact(text, env = process.env){
  const key = env.SCRAPE_CREATORS_API_KEY;
  let out = typeof text === 'string' ? text : String(text);
  if(key && key.length >= 4) out = out.split(key).join('[REDACTED]');
  // Also mask a key that arrived formatted as a header line.
  out = out.replace(/(x-api-key\s*[:=]\s*)\S+/gi, '$1[REDACTED]');
  return out;
}

/** Thrown for anything the caller should turn into an HTTP response. */
class UpstreamError extends Error {
  constructor(code, message, status){
    super(message);
    this.name = 'UpstreamError';
    this.code = code;
    this.status = status || null;
  }
}

/**
 * Query the provider's TikTok keyword search.
 *
 * `params` uses the provider's own parameter names — mapping our API's names to
 * theirs happens in the server, so this file stays a thin transport.
 * `fetchImpl` is injectable purely so the tests can run without a network or a
 * real key.
 */
async function searchTikTok(params, opts = {}){
  const env = opts.env || process.env;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const config = readConfig(env);

  const key = env.SCRAPE_CREATORS_API_KEY;
  if(!key || !key.trim()){
    throw new UpstreamError('missing_api_key', 'SCRAPE_CREATORS_API_KEY is not set on the server');
  }

  const url = new URL(config.baseUrl + config.tiktokSearchPath);
  for(const [name, value] of Object.entries(params)){
    if(value === undefined || value === null || value === '') continue;
    url.searchParams.set(name, String(value));
  }

  let res;
  try{
    res = await fetchImpl(url.toString(), {
      method: 'GET',
      headers: { 'x-api-key': key, accept: 'application/json' },
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  }catch(err){
    const aborted = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new UpstreamError(
      aborted ? 'upstream_timeout' : 'upstream_unreachable',
      aborted ? 'The provider did not respond in time' : 'Could not reach the provider',
    );
  }

  if(!res.ok){
    // The upstream body is deliberately dropped rather than forwarded: it can
    // echo the request (key included) and is not ours to expose to the page.
    const code =
      res.status === 401 || res.status === 403 ? 'upstream_auth_failed' :
      res.status === 429 ? 'upstream_rate_limited' :
      res.status >= 500 ? 'upstream_unavailable' : 'upstream_rejected';
    const message =
      code === 'upstream_auth_failed' ? 'The provider rejected the API key' :
      code === 'upstream_rate_limited' ? 'Rate limited by the provider' :
      code === 'upstream_unavailable' ? 'The provider is unavailable' :
      'The provider rejected the request';
    throw new UpstreamError(code, message, res.status);
  }

  try{
    return await res.json();
  }catch(err){
    throw new UpstreamError('upstream_bad_json', 'The provider returned a response that is not JSON');
  }
}

module.exports = { searchTikTok, readConfig, hasApiKey, redact, UpstreamError, CONFIG_DEFAULTS };
