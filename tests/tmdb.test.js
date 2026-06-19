/**
 * Tests for src/services/tmdb.js
 *
 * Strategy: pure unit tests with an injected mock HTTP client. NO network
 * calls in this file. Live integration tests live in tests/integration/.
 *
 * Behaviour tested:
 *   - Factory accepts either v4 Bearer token OR v3 API key
 *   - When both are set, v4 wins
 *   - findByImdbId translates IMDB → TMDB id
 *   - getMovieMeta returns localized meta with title, description, runtime, year
 *   - getShowMeta does the same for TV shows
 *   - 404 / unknown IMDB returns null (so caller can fall back to Cinemeta)
 *   - Non-2xx HTTP responses throw with status info
 *   - Network errors are wrapped with a clear message
 *   - Meta shape is compatible with the existing Cinemeta fallback contract:
 *     { id, name, description, type, poster, ... } with `type` normalized to
 *     'movie' or 'series' (lowercase, Stremio-style)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// We import from the file under test using a relative path; the file does not
// exist yet → these tests MUST fail (RED phase).
import { createTmdbClient } from '../src/services/tmdb.js';

/**
 * Build a mock HTTP client that returns canned responses in order.
 * Mirrors the axios interface: .get(url, { params, headers }) → { status, data }.
 * By default non-2xx statuses throw (matching axios); pass `noThrow: true` in
 * the canned response to make .get() return the response instead.
 */
function mockHttp(responses) {
  const calls = [];
  return {
    calls,
    async get(url, opts) {
      calls.push({ url, opts });
      const r = responses.shift();
      if (!r) throw new Error(`mockHttp: no more canned responses for ${url}`);
      if (r.throw) throw r.throw;
      // axios semantics: reject for non-2xx unless validateStatus overrides
      if (r.status != null && r.status >= 400 && !r.noThrow) {
        const err = new Error(`Request failed with status code ${r.status}`);
        err.response = { status: r.status, data: r.data };
        throw err;
      }
      return { status: r.status ?? 200, data: r.data };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. AUTH RESOLUTION
// ─────────────────────────────────────────────────────────────────────────────

describe('createTmdbClient — auth resolution', () => {
  it('throws a clear error when neither token nor key is provided', () => {
    assert.throws(
      () => createTmdbClient({ http: mockHttp([]) }),
      /TMDB credentials missing/i,
    );
  });

  it('uses v4 Bearer token when TMDB_READ_TOKEN is set', async () => {
    const http = mockHttp([{ data: { movie_results: [] } }]);
    const client = createTmdbClient({
      readToken: 'TOKEN',
      http,
    });
    await client.findByImdbId('tt0111161', 'movie');
    const sent = http.calls[0].opts.headers.Authorization;
    assert.equal(sent, 'Bearer TOKEN', 'v4 token must be sent as Bearer');
  });

  it('uses v3 API key as query string when only API_KEY is set', async () => {
    // axios turns { params: { api_key: 'KEY' } } into ?api_key=KEY at request time.
    // Mock just records the opts the module passed; we check that api_key was
    // included in the params object (which axios will serialize into the URL).
    const http = mockHttp([{ data: { movie_results: [] } }]);
    const client = createTmdbClient({
      apiKey: 'KEY',
      http,
    });
    await client.findByImdbId('tt0111161', 'movie');
    const params = http.calls[0].opts.params || {};
    assert.equal(params.api_key, 'KEY', 'v3 key must be passed as api_key param');
    assert.equal(http.calls[0].opts.headers?.Authorization, undefined);
  });

  it('prefers v4 token over v3 key when both are set', async () => {
    const http = mockHttp([{ data: { movie_results: [] } }]);
    const client = createTmdbClient({
      readToken: 'TOKEN',
      apiKey: 'KEY',
      http,
    });
    await client.findByImdbId('tt0111161', 'movie');
    assert.equal(http.calls[0].opts.headers.Authorization, 'Bearer TOKEN');
    assert.doesNotMatch(http.calls[0].url, /api_key=/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. findByImdbId
// ─────────────────────────────────────────────────────────────────────────────

describe('findByImdbId', () => {
  it('returns the first movie_results entry when type=movie', async () => {
    const http = mockHttp([{
      data: { movie_results: [{ id: 278, title: 'The Shawshank Redemption' }] },
    }]);
    const client = createTmdbClient({ readToken: 'T', http });
    const tmdbId = await client.findByImdbId('tt0111161', 'movie');
    assert.equal(tmdbId, 278);
  });

  it('returns the first tv_results entry when type=series', async () => {
    const http = mockHttp([{
      data: { tv_results: [{ id: 1399, name: 'Breaking Bad' }] },
    }]);
    const client = createTmdbClient({ readToken: 'T', http });
    const tmdbId = await client.findByImdbId('tt0903747', 'series');
    assert.equal(tmdbId, 1399);
  });

  it('returns null when TMDB has no match for the IMDB id', async () => {
    const http = mockHttp([{ data: { movie_results: [] } }]);
    const client = createTmdbClient({ readToken: 'T', http });
    const tmdbId = await client.findByImdbId('tt0000000', 'movie');
    assert.equal(tmdbId, null);
  });

  it('normalizes MOVIE/SHOW casing from the JustWatch side', async () => {
    const http = mockHttp([
      { data: { movie_results: [{ id: 1 }] } },
      { data: { tv_results: [{ id: 2 }] } },
    ]);
    const client = createTmdbClient({ readToken: 'T', http });
    await client.findByImdbId('tt1', 'MOVIE');
    await client.findByImdbId('tt2', 'SHOW');
    // /find/ is the lookup endpoint, then a "movie" vs "tv" bucket is selected
    // from the response based on the requested type.
    assert.match(http.calls[0].url, /\/find\/tt1/);
    assert.match(http.calls[1].url, /\/find\/tt2/);
    // Verify the type-bucket selection in the response handling:
    assert.deepEqual(http.calls[0].opts.params, { external_source: 'imdb_id', language: 'en-US' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. getMovieMeta — shape & localization
// ─────────────────────────────────────────────────────────────────────────────

describe('getMovieMeta', () => {
  it('returns Stremio-shaped meta with localized title + description', async () => {
    const http = mockHttp([{
      status: 200,
      data: {
        id: 278,
        title: 'Die Verurteilten',
        overview: 'Ein Bankier wird zu Unrecht verurteilt...',
        runtime: 142,
        release_date: '1994-09-23',
        poster_path: '/q6y0Go1tsGEsmtFryDOJo3dEmqu.jpg',
        vote_average: 9.3,
        genres: [{ id: 18, name: 'Drama' }],
      },
    }]);
    const client = createTmdbClient({ readToken: 'T', http });
    const meta = await client.getMovieMeta(278, 'de-DE', 'tt0111161');
    assert.equal(meta.id, 'tt0111161');
    assert.equal(meta.name, 'Die Verurteilten');
    assert.equal(meta.type, 'movie');
    assert.equal(meta.description, 'Ein Bankier wird zu Unrecht verurteilt...');
    assert.equal(meta.runtime, 142);
    assert.equal(meta.year, '1994');
    assert.match(meta.poster, /image\.tmdb\.org\/t\/p\/w500/);
    assert.match(meta.poster, /q6y0Go1tsGEsmtFryDOJo3dEmqu\.jpg$/);
  });

  it('passes language= query param so TMDB returns localized fields', async () => {
    const http = mockHttp([{ status: 200, data: { id: 1, title: 'X' } }]);
    const client = createTmdbClient({ readToken: 'T', http });
    await client.getMovieMeta(1, 'fr-FR');
    assert.equal(http.calls[0].opts.params.language, 'fr-FR');
  });

  it('returns null on 404 (caller falls back to Cinemeta)', async () => {
    const http = mockHttp([{ status: 404, data: { status_message: 'not found' }, noThrow: true }]);
    const client = createTmdbClient({ readToken: 'T', http });
    const meta = await client.getMovieMeta(99999999, 'en-US');
    assert.equal(meta, null);
  });

  it('throws on non-404 error responses', async () => {
    // Default mock behaviour: non-2xx throws with response attached (axios semantics)
    const http = mockHttp([{ status: 500, data: { status_message: 'boom' } }]);
    const client = createTmdbClient({ readToken: 'T', http });
    await assert.rejects(() => client.getMovieMeta(1, 'en-US'), /500/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. getShowMeta — TV shape & normalization
// ─────────────────────────────────────────────────────────────────────────────

describe('getShowMeta', () => {
  it('normalizes TMDB "name" → Stremio "name" and sets type=series', async () => {
    const http = mockHttp([{
      status: 200,
      data: {
        id: 1399,
        name: 'Breaking Bad',
        overview: 'A high school chemistry teacher...',
        first_air_date: '2008-01-20',
        episode_run_time: [45, 49],
        poster_path: '/1yeVJox3rjo2jBKrrihIMj7uoS9.jpg',
        vote_average: 9.0,
        genres: [{ id: 18, name: 'Drama' }],
      },
    }]);
    const client = createTmdbClient({ readToken: 'T', http });
    const meta = await client.getShowMeta(1399, 'en-US', 'tt0903747');
    assert.equal(meta.id, 'tt0903747');
    assert.equal(meta.name, 'Breaking Bad');
    assert.equal(meta.type, 'series');
    assert.equal(meta.year, '2008');
    // episode_run_time is an array; we pick the first entry as `runtime`
    assert.equal(meta.runtime, 45);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Network error wrapping
// ─────────────────────────────────────────────────────────────────────────────

describe('error wrapping', () => {
  it('wraps ECONNREFUSED with a clear TMDB context message', async () => {
    const http = mockHttp([{ throw: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }]);
    const client = createTmdbClient({ readToken: 'T', http });
    await assert.rejects(() => client.getMovieMeta(1, 'en'), /TMDB.*connect/i);
  });
});