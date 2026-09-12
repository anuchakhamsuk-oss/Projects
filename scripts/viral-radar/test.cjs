'use strict';
/**
 * node --test scripts/viral-radar/test.cjs
 *
 * Runs entirely on fixtures and an injected fetch — no network, and no real API
 * key. The upstream provider is unreachable from the environment this was built
 * in, so "it works against live data" is explicitly NOT what these prove. What
 * they do prove is the part that has to hold regardless of the provider: that
 * the key stays on the server, that bad input never costs quota, and that an
 * upstream failure cannot leak an upstream body.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { normalizeSearchResponse, loadFieldMap, FIELD_MAP } = require('./normalize.cjs');
const { searchTikTok, redact, UpstreamError } = require('./scrape-creators.cjs');
const { handleSearch, validateSearchInput, toUpstreamParams, settings, BadRequest } = require('./server.cjs');

/** A value that appears nowhere else, so finding it anywhere is proof of a leak. */
const SENTINEL_KEY = 'sk_test_SENTINEL_0ff1ce_do_not_leak_4242';
const ENV = { SCRAPE_CREATORS_API_KEY: SENTINEL_KEY };

const FIXTURES = path.join(__dirname, 'fixtures');
const readFixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));

/** Records what it was called with so tests can assert on the upstream request. */
function mockFetch(response){
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    if(typeof response === 'function') return response(url, init);
    return response;
  };
  fn.calls = calls;
  return fn;
}
const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

/* ---------------------------------------------------------------- data model */

test('maps the TikTok-shaped fixture onto the data model', () => {
  const out = normalizeSearchResponse(readFixture('tiktok-search.sample.json'), { fieldMap: FIELD_MAP });

  assert.equal(out.items.length, 2);
  assert.equal(out.nextCursor, 'CURSOR_PAGE_2');

  const first = out.items[0];
  assert.deepEqual(Object.keys(first).sort(), [
    'caption', 'creator', 'durationSec', 'id', 'platform', 'publishedAt', 'stats', 'thumbnailUrl', 'videoUrl',
  ]);
  assert.equal(first.id, '7300000000000000001');
  assert.equal(first.platform, 'tiktok');
  assert.equal(first.creator.handle, 'demo_creator');
  assert.equal(first.creator.name, 'Demo Creator');
  assert.equal(first.caption, 'ทำ automation ด้วย n8n ใน 3 นาที');
  assert.equal(first.thumbnailUrl, 'https://example.invalid/cover1.jpg');
  assert.equal(first.videoUrl, 'https://www.tiktok.com/@demo_creator/video/7300000000000000001');
  assert.deepEqual(first.stats, { views: 128000, likes: 9400, comments: 212, shares: 87 });
  assert.equal(first.publishedAt, new Date(1757000000 * 1000).toISOString());
  assert.equal(first.durationSec, 34, 'milliseconds should be converted to seconds');
});

test('derives a video URL when the row omits one', () => {
  const out = normalizeSearchResponse(readFixture('tiktok-search.sample.json'), { fieldMap: FIELD_MAP });
  assert.equal(out.items[1].videoUrl, 'https://www.tiktok.com/@second_demo/video/7300000000000000002');
});

test('maps a completely different response layout without code changes', () => {
  const out = normalizeSearchResponse(readFixture('tiktok-search.alt-shape.json'), { fieldMap: FIELD_MAP });
  assert.equal(out.items.length, 1);
  assert.equal(out.nextCursor, 'ALT_CURSOR_2');
  const it = out.items[0];
  assert.equal(it.id, 'alt-1');
  assert.equal(it.creator.handle, 'alt_creator');
  assert.equal(it.stats.views, 777);
  assert.equal(it.durationSec, 42, 'a value already in seconds should be left alone');
  assert.equal(it.publishedAt, '2026-09-01T08:30:00.000Z');
});

test('survives junk rows and an unknown wrapper', () => {
  const out = normalizeSearchResponse({ items: [null, {}, { id: 'x' }, 'nope'] }, { fieldMap: FIELD_MAP });
  // {} has neither an id nor a URL, so it is dropped; {id:'x'} is kept.
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].id, 'x');
  assert.equal(out.nextCursor, null);
  assert.deepEqual(normalizeSearchResponse({}, { fieldMap: FIELD_MAP }), { items: [], nextCursor: null });
});

test('a field-map override is merged over the defaults', () => {
  const custom = path.join(FIXTURES, 'field-map.test.json');
  fs.writeFileSync(custom, JSON.stringify({ items: ['weird_bucket'], caption: ['headline'] }));
  try{
    const map = loadFieldMap({ VIRAL_RADAR_FIELD_MAP: custom });
    const out = normalizeSearchResponse(
      { weird_bucket: [{ id: 'z', headline: 'from an overridden path' }] },
      { fieldMap: map },
    );
    assert.equal(out.items[0].caption, 'from an overridden path');
    // Untouched fields keep their defaults.
    assert.deepEqual(map.id, FIELD_MAP.id);
  }finally{
    fs.unlinkSync(custom);
  }
});

/* ------------------------------------------------------------ key containment */

test('the API key is sent upstream as x-api-key', async () => {
  const fetchImpl = mockFetch(jsonResponse({ aweme_list: [] }));
  await searchTikTok({ query: 'x' }, { env: ENV, fetchImpl });
  assert.equal(fetchImpl.calls[0].init.headers['x-api-key'], SENTINEL_KEY);
});

test('the API key never appears in the response sent to the frontend', async () => {
  const fetchImpl = mockFetch(jsonResponse(readFixture('tiktok-search.sample.json')));
  const payload = await handleSearch(new URLSearchParams({ query: 'n8n' }), { env: ENV, fetchImpl });

  const serialized = JSON.stringify(payload);
  assert.ok(!serialized.includes(SENTINEL_KEY), 'API key found in the response payload');
  assert.ok(!/x-api-key/i.test(serialized), 'an x-api-key header name leaked into the response');
  assert.ok(!/authorization/i.test(serialized), 'an authorization header leaked into the response');
  // Sanity: the sentinel really would have been detected had it been present.
  assert.ok(JSON.stringify({ probe: SENTINEL_KEY }).includes(SENTINEL_KEY));
});

test('an upstream body that echoes the key is not forwarded', async () => {
  // Worst case: the provider reflects the request, key included, in its 200 body.
  const hostile = {
    aweme_list: [{ aweme_id: '1', desc: 'ok' }],
    echoed_request: { headers: { 'x-api-key': SENTINEL_KEY } },
    debug_token: SENTINEL_KEY,
  };
  const fetchImpl = mockFetch(jsonResponse(hostile));
  const payload = await handleSearch(new URLSearchParams({ query: 'n8n' }), { env: ENV, fetchImpl });

  const serialized = JSON.stringify(payload);
  assert.ok(!serialized.includes(SENTINEL_KEY), 'key survived from a reflecting upstream body');
  assert.ok(!serialized.includes('echoed_request'), 'unknown upstream fields were passed through');
  assert.equal(payload.items.length, 1);
});

test('an upstream error surfaces a code, never the upstream body', async () => {
  for(const [status, expected] of [[401, 'upstream_auth_failed'], [429, 'upstream_rate_limited'], [500, 'upstream_unavailable']]){
    const body = { message: 'invalid key ' + SENTINEL_KEY, stack: 'secret internals' };
    const fetchImpl = mockFetch(jsonResponse(body, status));
    await assert.rejects(
      () => handleSearch(new URLSearchParams({ query: 'n8n' }), { env: ENV, fetchImpl }),
      (err) => {
        assert.ok(err instanceof UpstreamError);
        assert.equal(err.code, expected);
        const text = JSON.stringify({ code: err.code, message: err.message });
        assert.ok(!text.includes(SENTINEL_KEY), 'key leaked through an error');
        assert.ok(!text.includes('secret internals'), 'upstream body leaked through an error');
        return true;
      },
    );
  }
});

test('redact() scrubs the key and header-shaped text', () => {
  assert.ok(!redact(`failed with ${SENTINEL_KEY}`, ENV).includes(SENTINEL_KEY));
  assert.equal(redact('x-api-key: abc123', ENV), 'x-api-key: [REDACTED]');
});

test('a missing key fails closed, without calling upstream', async () => {
  const fetchImpl = mockFetch(jsonResponse({}));
  await assert.rejects(
    () => handleSearch(new URLSearchParams({ query: 'n8n' }), { env: {}, fetchImpl }),
    (err) => err.code === 'missing_api_key',
  );
  assert.equal(fetchImpl.calls.length, 0, 'upstream was called without a key');
});

/* ------------------------------------------------------ input + quota guards */

test('invalid input is rejected before any upstream call', async () => {
  const cases = [
    ['', 'query is required'],
    ['   ', 'query is required'],
  ];
  for(const [query] of cases){
    const fetchImpl = mockFetch(jsonResponse({}));
    await assert.rejects(
      () => handleSearch(new URLSearchParams({ query }), { env: ENV, fetchImpl }),
      (err) => err instanceof BadRequest,
    );
    assert.equal(fetchImpl.calls.length, 0, 'a rejected request still cost an upstream call');
  }

  const tooLong = new URLSearchParams({ query: 'a'.repeat(101) });
  const f2 = mockFetch(jsonResponse({}));
  await assert.rejects(() => handleSearch(tooLong, { env: ENV, fetchImpl: f2 }), (e) => e instanceof BadRequest);
  assert.equal(f2.calls.length, 0);
});

test('period, sort and region are allowlisted', () => {
  const cfg = settings({});
  assert.throws(() => validateSearchInput(new URLSearchParams({ query: 'a', period: 'forever' }), cfg), BadRequest);
  assert.throws(() => validateSearchInput(new URLSearchParams({ query: 'a', sort: 'magic' }), cfg), BadRequest);
  assert.throws(() => validateSearchInput(new URLSearchParams({ query: 'a', region: 'THA' }), cfg), BadRequest);
  assert.throws(() => validateSearchInput(new URLSearchParams({ query: 'a', cursor: 'x' + String.fromCharCode(0) + 'y' }), cfg), BadRequest);

  const ok = validateSearchInput(new URLSearchParams({ query: ' a ', period: '7d', sort: 'likes', region: 'th' }), cfg);
  assert.equal(ok.query, 'a');
  assert.equal(ok.region, 'TH');
});

test('the allowlists can be widened from the environment', () => {
  const cfg = settings({ VIRAL_RADAR_PERIODS: '1h,forever', VIRAL_RADAR_SORTS: 'magic' });
  const ok = validateSearchInput(new URLSearchParams({ query: 'a', period: 'forever', sort: 'magic' }), cfg);
  assert.equal(ok.period, 'forever');
});

test('results are capped', async () => {
  const many = { aweme_list: Array.from({ length: 120 }, (_, i) => ({ aweme_id: String(i), desc: 'x' })) };
  const fetchImpl = mockFetch(jsonResponse(many));
  const payload = await handleSearch(new URLSearchParams({ query: 'n8n' }), { env: ENV, fetchImpl });
  assert.equal(payload.items.length, 50, 'the default cap should apply');
  assert.equal(payload.count, 50);

  const small = await handleSearch(new URLSearchParams({ query: 'n8n', limit: '5' }), { env: ENV, fetchImpl: mockFetch(jsonResponse(many)) });
  assert.equal(small.items.length, 5);

  // A caller cannot raise the ceiling past the configured maximum.
  const over = await handleSearch(new URLSearchParams({ query: 'n8n', limit: '999' }), { env: ENV, fetchImpl: mockFetch(jsonResponse(many)) });
  assert.equal(over.items.length, 50);
});

test('our parameter names are translated to the provider\'s', () => {
  const upstream = toUpstreamParams({ query: 'n8n', period: '7d', sort: 'likes', region: 'TH', cursor: 'c1' });
  assert.deepEqual(upstream, { query: 'n8n', date_posted: '7d', sort_by: 'likes', region: 'TH', cursor: 'c1' });
  // Empty optionals are dropped rather than sent blank.
  assert.deepEqual(toUpstreamParams({ query: 'n8n', period: '', sort: '', region: '', cursor: '' }),
    { query: 'n8n', date_posted: undefined, sort_by: undefined, region: undefined, cursor: undefined });
});

test('the cursor is passed through for pagination', async () => {
  const fetchImpl = mockFetch(jsonResponse(readFixture('tiktok-search.sample.json')));
  const payload = await handleSearch(new URLSearchParams({ query: 'n8n', cursor: 'CURSOR_PAGE_2' }), { env: ENV, fetchImpl });
  assert.ok(fetchImpl.calls[0].url.includes('cursor=CURSOR_PAGE_2'));
  assert.equal(payload.nextCursor, 'CURSOR_PAGE_2');
});

/* ----------------------------------------------------------- source-tree scan */

test('no source file contains a hardcoded key, and the key is read only from the environment', () => {
  const root = __dirname;
  const files = [];
  (function walk(dir){
    for(const entry of fs.readdirSync(dir, { withFileTypes: true })){
      const full = path.join(dir, entry.name);
      if(entry.isDirectory()) walk(full);
      else if(/\.(cjs|js|json|html)$/.test(entry.name)) files.push(full);
    }
  })(root);

  const readers = [];
  for(const file of files){
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(root, file);

    // An assignment giving SCRAPE_CREATORS_API_KEY a literal value.
    assert.ok(
      !/SCRAPE_CREATORS_API_KEY\s*[:=]\s*['"][^'"]+['"]/.test(text),
      `${rel} assigns a literal value to SCRAPE_CREATORS_API_KEY`,
    );
    // Common secret shapes, ignoring this file's own sentinel.
    const secretish = text.match(/\b(?:sk|pk|api)[-_][A-Za-z0-9_-]{16,}\b/g) || [];
    const unexpected = secretish.filter(s => s !== SENTINEL_KEY);
    assert.deepEqual(unexpected, [], `${rel} contains something shaped like a secret: ${unexpected.join(', ')}`);

    // What matters is who READS the value (`env.SCRAPE_CREATORS_API_KEY`), not
    // who names the variable: a startup log and an error message both name it
    // on purpose, to tell the operator what to set.
    if(/\.\s*SCRAPE_CREATORS_API_KEY\b|\[\s*['"]SCRAPE_CREATORS_API_KEY['"]\s*\]/.test(text)) readers.push(rel);
  }

  // Only the transport module and this test may read the key at all.
  assert.deepEqual(readers.sort(), ['scrape-creators.cjs', 'test.cjs'],
    'the API key value is read outside the single module that owns it');

  // Nothing served to the browser may read process.env in any form.
  const served = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  assert.ok(!/process\s*\.\s*env/.test(served), 'the served page reads process.env');

  // index.html went through the value-shaped scan above with every other file,
  // which is the check that matters. Naming the variable in a help message is
  // deliberate and leaks nothing, so it is not treated as a finding here.
  const page = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  assert.ok(!/scrapecreators\.com/i.test(page.replace(/<code>[^<]*<\/code>/g, '')),
    'the served page addresses the provider outside of explanatory text');
  assert.ok(!/fetch\s*\(\s*['"`]https?:/i.test(page),
    'the served page fetches an absolute URL instead of its own origin');
});
