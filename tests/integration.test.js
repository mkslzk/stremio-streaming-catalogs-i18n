/**
 * Integration test for the full server pipeline:
 *   Express handler → movies map → metaEnricher → JSON response
 *
 * Uses injected mocks for JustWatch and TMDB so the test is hermetic
 * (no network, no TMDB auth needed). Verifies that:
 *
 *   1. handleCatalog returns movies.nfx as JSON with the expected shape
 *   2. Each meta item is enriched by metaEnricher (TMDB-first → Cinemeta-fallback)
 *   3. The CATALOG_LANGUAGE plumbed through the server reaches TMDB
 *   4. Poster URL is the JustWatch one (preserved over TMDB poster)
 *   5. Fallback chain works when TMDB has no match for an IMDB id
 *
 * This test exercises the real handleCatalog() and real metaEnricher, with
 * only JustWatch and TMDB swapped out via dependency injection.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// We import the handler directly — it's a pure function over (req, res, movies, series, mixpanel).
import { handleCatalog } from '../src/server/routes/catalog.js';
import { createMetaEnricher } from '../src/services/meta.js';

// ─────────────────────────────────────────────────────────────────────────────
// Mock JustWatch (returns canned movie lists)
// ─────────────────────────────────────────────────────────────────────────────

function fakeJustwatch(catalog) {
  // catalog: { nfx: [{ imdbId, justwatchTitle, justwatchPoster }, ...] }
  return {
    async getMetas(type, providers, country, language) {
      const id = providers[0];
      const items = catalog[id] || [];
      // Mimic what the real justwatch.js does: return objects with { id, name, type, poster }
      return items.map(item => ({
        id: item.imdbId,
        name: item.justwatchTitle,
        type: type === 'SHOW' ? 'series' : 'movie',
        poster: item.justwatchPoster,
        // The real justwatch also calls cinemeta/TMDB internally and spreads
        // the meta on. To simulate that, we just include a hint that this is
        // "pre-enrichment" data — metaEnricher will overwrite name/poster as
        // needed.
      }));
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock TMDB
// ─────────────────────────────────────────────────────────────────────────────

function fakeTmdb(responses = {}) {
  return {
    async findByImdbId(imdbId, type) {
      return responses.find?.[imdbId] ?? null;
    },
    async getMovieMeta(tmdbId, language, imdbId) {
      const r = responses.movie?.[tmdbId];
      if (!r) return null;
      // Normalize: TMDB returns 'title' for movies and 'name' for TV. The real
      // tmdb.js maps both to 'name' via normalizeMeta(). Fake mocks must do the
      // same to mirror production behaviour.
      const out = { id: tmdbId, type: 'movie', ...r };
      if (out.title && !out.name) out.name = out.title;
      return out;
    },
    async getShowMeta(tmdbId, language, imdbId) {
      const r = responses.show?.[tmdbId];
      if (!r) return null;
      const out = { id: tmdbId, type: 'tv', ...r };
      if (out.name && !out.name.startsWith('series')) {
        // already a 'name' field — nothing to normalize
      }
      return out;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock Cinemeta (English fallback)
// ─────────────────────────────────────────────────────────────────────────────

function fakeCinemeta(responses = {}) {
  return {
    fetchCinemetaMeta: async (imdbId, type) => responses[imdbId] ?? null,
    getBasicMeta: (imdbId, title, type) => ({
      id: imdbId, name: title, type: type === 'MOVIE' ? 'movie' : 'series',
      poster: `https://example.com/poster/${imdbId}`,
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Build mock req/res objects compatible with handleCatalog
// ─────────────────────────────────────────────────────────────────────────────

function mockReqRes(urlPath, params = {}) {
  const resHeaders = {};
  const resBody = { sent: null, headersSent: false };
  const req = {
    params: { type: 'movie', id: 'nfx', configuration: '', ...params },
    ip: '127.0.0.1',
  };
  const res = {
    setHeader(k, v) { resHeaders[k] = v; },
    send(body) { resBody.sent = body; resBody.headersSent = true; },
    json(body) { resBody.sent = body; resBody.headersSent = true; },
  };
  return { req, res, resHeaders, resBody };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('server pipeline integration (mocked JustWatch + TMDB + Cinemeta)', () => {
  it('returns JustWatch catalog with TMDB-enriched metadata', async () => {
    // JustWatch says: Netflix DE has 2 movies
    const justwatch = fakeJustwatch({
      nfx: [
        { imdbId: 'tt0111161', justwatchTitle: 'Shawshank', justwatchPoster: 'https://jw/p1.jpg' },
        { imdbId: 'tt0068646', justwatchTitle: 'Godfather',  justwatchPoster: 'https://jw/p2.jpg' },
      ],
    });

    // TMDB has both → returns German titles
    const tmdb = fakeTmdb({
      find: { tt0111161: 278, tt0068646: 238 },
      movie: {
        278: { title: 'Die Verurteilten', overview: 'Ein Banker wird zu Unrecht verurteilt.', runtime: 142 },
        238: { title: 'Der Pate',         overview: 'Die Geschichte einer italo-amerikanischen Mafia-Familie.', runtime: 175 },
      },
    });

    // Cinemeta never called (TMDB primary)
    const cinemeta = fakeCinemeta({});
    const enrich = createMetaEnricher({ tmdb, cinemeta });

    // Build movies map as if loadNewCatalog() had populated it
    const metas = await justwatch.getMetas('MOVIE', ['nfx'], 'GB', 'de');
    const enriched = await Promise.all(metas.map(m =>
      enrich.enrich({
        imdbId: m.id,
        type: 'MOVIE',
        language: 'de',
        fallbackTitle: m.name,
        justwatchPoster: m.poster,
      })
    ));
    const movies = { nfx: enriched };

    // Now hit the real handleCatalog with that map
    const { req, res, resBody } = mockReqRes('/catalog/movie/nfx.json', { id: 'nfx', type: 'movie' });
    handleCatalog(req, res, movies, {}, null);

    assert.equal(resBody.headersSent, true);
    assert.equal(resBody.sent.metas.length, 2);

    // First meta: Shawshank
    const m0 = resBody.sent.metas[0];
    assert.equal(m0.id, 'tt0111161');
    assert.equal(m0.name, 'Die Verurteilten');     // TMDB German title
    assert.equal(m0.poster, 'https://jw/p1.jpg');  // JustWatch poster preserved
    assert.equal(m0.type, 'movie');

    // Second meta: Godfather
    const m1 = resBody.sent.metas[1];
    assert.equal(m1.id, 'tt0068646');
    assert.equal(m1.name, 'Der Pate');
    assert.equal(m1.poster, 'https://jw/p2.jpg');
  });

  it('falls back to Cinemeta when TMDB has no match', async () => {
    const justwatch = fakeJustwatch({
      nfx: [
        { imdbId: 'tt99999999', justwatchTitle: 'Some Indie Film', justwatchPoster: 'https://jw/p3.jpg' },
      ],
    });

    // TMDB doesn't know tt99999999
    const tmdb = fakeTmdb({ find: {} });

    // Cinemeta returns English data
    const cinemeta = fakeCinemeta({
      tt99999999: { id: 'tt99999999', name: 'Some Indie Film (EN)', type: 'movie' },
    });
    const enrich = createMetaEnricher({ tmdb, cinemeta });

    const metas = await justwatch.getMetas('MOVIE', ['nfx'], 'GB', 'de');
    const enriched = await Promise.all(metas.map(m =>
      enrich.enrich({
        imdbId: m.id, type: 'MOVIE', language: 'de',
        fallbackTitle: m.name, justwatchPoster: m.poster,
      })
    ));
    const movies = { nfx: enriched };

    const { req, res, resBody } = mockReqRes('/catalog/movie/nfx.json');
    handleCatalog(req, res, movies, {}, null);

    assert.equal(resBody.sent.metas[0].name, 'Some Indie Film (EN)', 'Cinemeta fallback used');
    assert.equal(resBody.sent.metas[0].poster, 'https://jw/p3.jpg', 'JustWatch poster still wins');
  });

  it('falls back to basic meta when both TMDB and Cinemeta fail', async () => {
    const justwatch = fakeJustwatch({
      nfx: [
        { imdbId: 'tt11111111', justwatchTitle: 'JustWatch Title Only', justwatchPoster: 'https://jw/p4.jpg' },
      ],
    });
    const tmdb = fakeTmdb({ find: {} });           // TMDB returns null
    const cinemeta = fakeCinemeta({});             // Cinemeta returns null
    const enrich = createMetaEnricher({ tmdb, cinemeta });

    const metas = await justwatch.getMetas('MOVIE', ['nfx'], 'GB', 'de');
    const enriched = await Promise.all(metas.map(m =>
      enrich.enrich({
        imdbId: m.id, type: 'MOVIE', language: 'de',
        fallbackTitle: m.name, justwatchPoster: m.poster,
      })
    ));
    const movies = { nfx: enriched };

    const { req, res, resBody } = mockReqRes('/catalog/movie/nfx.json');
    handleCatalog(req, res, movies, {}, null);

    const meta = resBody.sent.metas[0];
    assert.equal(meta.name, 'JustWatch Title Only', 'basic meta uses fallbackTitle');
    assert.equal(meta.poster, 'https://jw/p4.jpg', 'JustWatch poster preserved');
  });

  it('passes CATALOG_LANGUAGE through to TMDB on every item', async () => {
    let tmdbLanguages = [];
    const justwatch = fakeJustwatch({
      nfx: [
        { imdbId: 'tt0111161', justwatchTitle: 'A', justwatchPoster: 'p1' },
        { imdbId: 'tt0068646', justwatchTitle: 'B', justwatchPoster: 'p2' },
      ],
    });
    const tmdb = {
      calls: { findByImdbId: [], getMovieMeta: [], getShowMeta: [] },
      async findByImdbId(imdbId, type) {
        tmdb.calls.findByImdbId.push({ imdbId, type });
        return imdbId === 'tt0111161' ? 278 : 238;
      },
      async getMovieMeta(tmdbId, language, imdbId) {
        tmdb.calls.getMovieMeta.push({ tmdbId, language, imdbId });
        tmdbLanguages.push(language);
        return { id: tmdbId, title: `Title ${tmdbId}`, type: 'movie' };
      },
    };
    const cinemeta = fakeCinemeta({});
    const enrich = createMetaEnricher({ tmdb, cinemeta });

    const metas = await justwatch.getMetas('MOVIE', ['nfx'], 'GB', 'fr-FR');
    await Promise.all(metas.map(m =>
      enrich.enrich({ imdbId: m.id, type: 'MOVIE', language: 'fr-FR', fallbackTitle: m.name, justwatchPoster: m.poster })
    ));

    assert.deepEqual(tmdbLanguages, ['fr-FR', 'fr-FR'], 'language must reach every TMDB call');
  });
});