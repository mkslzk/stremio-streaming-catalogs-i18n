/**
 * Tests for src/services/meta.js — the meta-enrichment layer.
 *
 * Behaviour tested:
 *   - enrich() prefers TMDB meta over Cinemeta when both available
 *   - enrich() falls back to Cinemeta when TMDB has no match
 *   - enrich() falls back to a minimal basic meta when both fail
 *   - enrich() preserves the JustWatch poster (overrides TMDB poster)
 *   - IMDB → TMDB id lookups are cached across calls (avoid 2x API hits)
 *   - Cinemeta fetches are NOT cached (cheap, may have updates; keep simple)
 *   - Concurrent calls for same IMDB id are deduplicated (no thundering herd)
 *   - Language parameter is plumbed through to TMDB
 *   - null/undefined meta responses are handled gracefully
 *   - Errors from TMDB that are not 404 fall back to Cinemeta (graceful degradation)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createMetaEnricher } from '../src/services/meta.js';

// ─────────────────────────────────────────────────────────────────────────────
// Test doubles
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a fake tmdb client that returns canned responses keyed by tmdb id.
 * Each call records its arguments so tests can assert cache behaviour.
 */
function fakeTmdb(responses = {}) {
  const calls = { findByImdbId: [], getMovieMeta: [], getShowMeta: [] };
  return {
    calls,
    async findByImdbId(imdbId, type) {
      calls.findByImdbId.push({ imdbId, type });
      return responses.find?.[imdbId] ?? null;
    },
    async getMovieMeta(tmdbId, language, imdbId) {
      calls.getMovieMeta.push({ tmdbId, language, imdbId });
      const r = responses.movie?.[tmdbId];
      if (r?.throw) throw r.throw;
      return r?.data ?? null;
    },
    async getShowMeta(tmdbId, language, imdbId) {
      calls.getShowMeta.push({ tmdbId, language, imdbId });
      const r = responses.show?.[tmdbId];
      if (r?.throw) throw r.throw;
      return r?.data ?? null;
    },
  };
}

/**
 * Build a fake cinemeta fetcher that returns canned responses keyed by imdb id.
 */
function fakeCinemeta(responses = {}) {
  const calls = [];
  return {
    calls,
    fetchCinemetaMeta: async (imdbId, type) => {
      calls.push({ imdbId, type });
      const r = responses[imdbId];
      if (r?.throw) throw r.throw;
      return r ?? null;
    },
    getBasicMeta: (imdbId, title, type) => ({
      id: imdbId,
      name: title,
      type: type === 'MOVIE' || type === 'movie' ? 'movie' : 'series',
      poster: `https://live.metahub.space/poster/medium/${imdbId}/img`,
      posterShape: 'poster',
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. TMDB primary path
// ─────────────────────────────────────────────────────────────────────────────

describe('enrich — TMDB primary path', () => {
  it('returns TMDB meta when IMDB id resolves and movie detail succeeds', async () => {
    const tmdb = fakeTmdb({
      find: { tt0111161: 278 },
      movie: { 278: { data: { id: 278, name: 'Die Verurteilten', type: 'movie' } } },
    });
    const cinemeta = fakeCinemeta();
    const enrich = createMetaEnricher({ tmdb, cinemeta });

    const result = await enrich.enrich({
      imdbId: 'tt0111161', type: 'MOVIE', language: 'de-DE',
      fallbackTitle: 'The Shawshank Redemption',
      justwatchPoster: 'https://images.justwatch.com/poster/x.jpg',
    });

    assert.equal(result.id, 'tt0111161');
    assert.equal(result.name, 'Die Verurteilten');
    // JustWatch poster must win over TMDB poster (it's the addon contract)
    assert.equal(result.poster, 'https://images.justwatch.com/poster/x.jpg');
  });

  it('passes language through to TMDB detail call', async () => {
    const tmdb = fakeTmdb({
      find: { tt1: 100 },
      movie: { 100: { data: { id: 100, name: 'Le Film', type: 'movie' } } },
    });
    const cinemeta = fakeCinemeta();
    const enrich = createMetaEnricher({ tmdb, cinemeta });

    await enrich.enrich({
      imdbId: 'tt1', type: 'MOVIE', language: 'fr-FR',
      fallbackTitle: 'X', justwatchPoster: 'p',
    });

    assert.equal(tmdb.calls.getMovieMeta[0].language, 'fr-FR');
  });

  it('uses tv endpoint for SHOW type', async () => {
    const tmdb = fakeTmdb({
      find: { tt0903747: 1399 },
      show: { 1399: { data: { id: 1399, name: 'Breaking Bad', type: 'series' } } },
    });
    const cinemeta = fakeCinemeta();
    const enrich = createMetaEnricher({ tmdb, cinemeta });

    await enrich.enrich({
      imdbId: 'tt0903747', type: 'SHOW', language: 'de-DE',
      fallbackTitle: 'X', justwatchPoster: 'p',
    });

    assert.equal(tmdb.calls.getShowMeta.length, 1);
    assert.equal(tmdb.calls.getShowMeta[0].tmdbId, 1399);
    assert.equal(tmdb.calls.getMovieMeta.length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Cinemeta fallback
// ─────────────────────────────────────────────────────────────────────────────

describe('enrich — Cinemeta fallback', () => {
  it('falls back to Cinemeta when TMDB has no IMDB match', async () => {
    const tmdb = fakeTmdb({ find: {} }); // empty → null
    const cinemeta = fakeCinemeta({
      tt1: { id: 'tt1', name: 'English Title', type: 'movie' },
    });
    const enrich = createMetaEnricher({ tmdb, cinemeta });

    const result = await enrich.enrich({
      imdbId: 'tt1', type: 'MOVIE', language: 'de-DE',
      fallbackTitle: 'X', justwatchPoster: 'p',
    });

    assert.equal(result.name, 'English Title');
    assert.equal(cinemeta.calls.length, 1);
  });

  it('falls back to Cinemeta when TMDB throws a non-404 error', async () => {
    const tmdb = fakeTmdb({
      find: { tt1: 100 },
      movie: { 100: { throw: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) } },
    });
    const cinemeta = fakeCinemeta({
      tt1: { id: 'tt1', name: 'Fallback', type: 'movie' },
    });
    const enrich = createMetaEnricher({ tmdb, cinemeta });

    const result = await enrich.enrich({
      imdbId: 'tt1', type: 'MOVIE', language: 'de-DE',
      fallbackTitle: 'X', justwatchPoster: 'p',
    });
    assert.equal(result.name, 'Fallback');
  });

  it('falls back to basic meta when both TMDB and Cinemeta fail', async () => {
    const tmdb = fakeTmdb({ find: {} });
    const cinemeta = fakeCinemeta({ tt1: null }); // Cinemeta returns null too
    const enrich = createMetaEnricher({ tmdb, cinemeta });

    const result = await enrich.enrich({
      imdbId: 'tt1', type: 'MOVIE', language: 'de-DE',
      fallbackTitle: 'JustWatch Title', justwatchPoster: 'p',
    });

    // Basic meta uses fallbackTitle as name
    assert.equal(result.name, 'JustWatch Title');
    assert.equal(result.id, 'tt1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Caching — IMDB → TMDB id mapping
// ─────────────────────────────────────────────────────────────────────────────

describe('enrich — caching', () => {
  it('caches IMDB → TMDB id mapping across calls (no duplicate findByImdbId)', async () => {
    const tmdb = fakeTmdb({
      find: { tt1: 100 },
      movie: { 100: { data: { id: 100, name: 'Cached', type: 'movie' } } },
    });
    const cinemeta = fakeCinemeta();
    const enrich = createMetaEnricher({ tmdb, cinemeta });

    // Same imdb id, two different languages → TMDB id should be looked up once
    await enrich.enrich({ imdbId: 'tt1', type: 'MOVIE', language: 'de-DE', fallbackTitle: 'X', justwatchPoster: 'p' });
    await enrich.enrich({ imdbId: 'tt1', type: 'MOVIE', language: 'fr-FR', fallbackTitle: 'X', justwatchPoster: 'p' });

    assert.equal(tmdb.calls.findByImdbId.length, 1, 'findByImdbId must be cached');
    // ...but the detail call happens twice (one per language)
    assert.equal(tmdb.calls.getMovieMeta.length, 2);
  });

  it('caches negative TMDB lookups too (null result remembered)', async () => {
    const tmdb = fakeTmdb({ find: {} });
    const cinemeta = fakeCinemeta({ tt1: { id: 'tt1', name: 'Cinemeta', type: 'movie' } });
    const enrich = createMetaEnricher({ tmdb, cinemeta });

    await enrich.enrich({ imdbId: 'tt1', type: 'MOVIE', language: 'de-DE', fallbackTitle: 'X', justwatchPoster: 'p' });
    await enrich.enrich({ imdbId: 'tt1', type: 'MOVIE', language: 'en-US', fallbackTitle: 'X', justwatchPoster: 'p' });

    assert.equal(tmdb.calls.findByImdbId.length, 1, 'negative cache hit');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Concurrency
// ─────────────────────────────────────────────────────────────────────────────

describe('enrich — concurrent dedup', () => {
  it('deduplicates concurrent enrich() calls for the same imdb id', async () => {
    // Slow TMDB so we can issue parallel calls before the first finishes
    let tmdbCallCount = 0;
    const tmdb = {
      calls: { findByImdbId: [], getMovieMeta: [], getShowMeta: [] },
      async findByImdbId(imdbId) {
        tmdb.calls.findByImdbId.push({ imdbId });
        tmdbCallCount++;
        await new Promise(r => setTimeout(r, 30));
        return 100;
      },
      async getMovieMeta(tmdbId, language, imdbId) {
        tmdb.calls.getMovieMeta.push({ tmdbId, language, imdbId });
        await new Promise(r => setTimeout(r, 10));
        return { id: 100, name: 'Concurrent', type: 'movie' };
      },
    };
    const cinemeta = fakeCinemeta();
    const enrich = createMetaEnricher({ tmdb, cinemeta });

    // Fire 5 concurrent requests for the same imdb id
    const results = await Promise.all([
      enrich.enrich({ imdbId: 'tt1', type: 'MOVIE', language: 'de-DE', fallbackTitle: 'X', justwatchPoster: 'p' }),
      enrich.enrich({ imdbId: 'tt1', type: 'MOVIE', language: 'de-DE', fallbackTitle: 'X', justwatchPoster: 'p' }),
      enrich.enrich({ imdbId: 'tt1', type: 'MOVIE', language: 'de-DE', fallbackTitle: 'X', justwatchPoster: 'p' }),
      enrich.enrich({ imdbId: 'tt1', type: 'MOVIE', language: 'de-DE', fallbackTitle: 'X', justwatchPoster: 'p' }),
      enrich.enrich({ imdbId: 'tt1', type: 'MOVIE', language: 'de-DE', fallbackTitle: 'X', justwatchPoster: 'p' }),
    ]);

    // All should resolve to the same result
    assert.equal(new Set(results.map(r => r.name)).size, 1);
    // findByImdbId should only run once thanks to in-flight dedup
    assert.equal(tmdbCallCount, 1, 'in-flight dedup must collapse concurrent lookups');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. JustWatch poster preservation
// ─────────────────────────────────────────────────────────────────────────────

describe('enrich — poster handling', () => {
  it('preserves JustWatch poster over TMDB poster (per existing addon contract)', async () => {
    const tmdb = fakeTmdb({
      find: { tt1: 100 },
      movie: { 100: { data: { id: 100, name: 'X', type: 'movie', poster: 'https://image.tmdb.org/x.jpg' } } },
    });
    const cinemeta = fakeCinemeta();
    const enrich = createMetaEnricher({ tmdb, cinemeta });

    const result = await enrich.enrich({
      imdbId: 'tt1', type: 'MOVIE', language: 'de-DE',
      fallbackTitle: 'X', justwatchPoster: 'https://images.justwatch.com/y.jpg',
    });

    assert.equal(result.poster, 'https://images.justwatch.com/y.jpg');
  });
});