/**
 * Meta-enrichment layer.
 *
 * Takes an IMDB id + content type + language and returns a Stremio-shaped
 * meta object (id, name, description, runtime, year, poster, ...).
 *
 * Strategy: TMDB first (i18n), Cinemeta fallback (English), basic meta
 * last resort. The result always includes the JustWatch poster because the
 * existing addon contract depends on it.
 *
 * Two caches:
 *   1. IMDB → TMDB id (positive + negative). Avoids a /find call per item
 *      per catalog refresh.
 *   2. In-flight request dedup. Five concurrent enrich() calls for the same
 *      IMDB id collapse to a single TMDB round-trip (no thundering herd).
 *
 * Cinemeta is NOT cached. It's already a single GET per item and Stremio
 * can change its English titles any time — keep it live.
 *
 * Design: pure factory, no env access inside, all collaborators injected.
 *   createMetaEnricher({ tmdb, cinemeta, logger? }) → { enrich(input) }
 */

const NULL_TMDB_ID = null; // sentinel for negative cache (TMDB has no match)

/**
 * Factory — returns an enrich() function bound to the supplied collaborators.
 *
 * @param {object} deps
 * @param {object} deps.tmdb       a createTmdbClient() result
 * @param {object} deps.cinemeta   { fetchCinemetaMeta, getBasicMeta }
 * @param {function} [deps.logger]  optional (msg) => void for debug output
 */
export function createMetaEnricher({ tmdb, cinemeta, logger = () => {} }) {
  if (!tmdb) throw new Error('meta.js: tmdb client is required');
  if (!cinemeta) throw new Error('meta.js: cinemeta client is required');

  // IMDB → TMDB id cache. Value is either a number (positive) or NULL_TMDB_ID.
  const idCache = new Map();

  // In-flight request map: deduplicates concurrent calls for the same imdbId.
  // Maps imdbId → Promise<tmdbId|null>.
  const inflight = new Map();

  /**
   * Resolve IMDB → TMDB id, with caching + concurrency dedup.
   * @returns {Promise<number|null>}  tmdb id, or null if TMDB has no match.
   */
  async function resolveTmdbId(imdbId, type) {
    if (idCache.has(imdbId)) return idCache.get(imdbId);
    if (inflight.has(imdbId)) return inflight.get(imdbId);

    const p = (async () => {
      let tmdbId;
      try {
        tmdbId = await tmdb.findByImdbId(imdbId, type);
      } catch (e) {
        // Auth/quota failures bubble up to enrich() so it can fall back to
        // Cinemeta. We deliberately do NOT cache these — caching a transient
        // 401/429 would lock us out for the rest of the process lifetime.
        throw e;
      } finally {
        inflight.delete(imdbId);
      }
      // Cache the result (real id or NULL_TMDB_ID for "no match").
      idCache.set(imdbId, tmdbId == null ? NULL_TMDB_ID : tmdbId);
      return tmdbId;
    })();
    inflight.set(imdbId, p);
    return p;
  }

  /**
   * Fetch meta from TMDB given a known tmdb id. Returns null on 404.
   * Throws on non-404 errors (caller decides what to do — typically fall back).
   */
  async function fetchTmdbMeta(tmdbId, type, language, imdbId) {
    if (type === 'SHOW' || type === 'series' || type === 'tv') {
      return tmdb.getShowMeta(tmdbId, language, imdbId);
    }
    return tmdb.getMovieMeta(tmdbId, language, imdbId);
  }

  /**
   * Normalize the type input to uppercase for our internal type-tag.
   * Preserves the JustWatch-style 'MOVIE' / 'SHOW' convention used elsewhere.
   */
  function upType(t) {
    return String(t || '').toUpperCase();
  }

  /**
   * Main entry. Returns a Stremio-shaped meta object.
   * Always succeeds (worst case: basic meta with the fallback title).
   *
   * @param {object} input
   * @param {string} input.imdbId          e.g. 'tt0111161'
   * @param {string} input.type            'MOVIE' | 'SHOW' | 'movie' | 'series'
   * @param {string} input.language        BCP-47, e.g. 'de-DE'
   * @param {string} input.fallbackTitle   Title from JustWatch when nothing else resolves
   * @param {string} input.justwatchPoster URL to override the meta's poster field
   * @returns {Promise<object>}
   */
  async function enrich({ imdbId, type, language, fallbackTitle, justwatchPoster }) {
    if (!imdbId) throw new Error('enrich: imdbId is required');
    const t = upType(type);
    const lang = language || 'en-US';

    let meta = null;

    // 1. TMDB (preferred — has localization)
    try {
      const tmdbId = await resolveTmdbId(imdbId, t);
      if (tmdbId != null) {
        meta = await fetchTmdbMeta(tmdbId, t, lang, imdbId);
      }
    } catch (e) {
      // Non-404 TMDB errors → log and fall through to Cinemeta
      logger(`meta.enrich: TMDB error for ${imdbId}, falling back to Cinemeta: ${e.message}`);
    }

    // 2. Cinemeta (English fallback)
    if (!meta) {
      try {
        meta = await cinemeta.fetchCinemetaMeta(imdbId, t, fallbackTitle);
      } catch (e) {
        logger(`meta.enrich: Cinemeta error for ${imdbId}: ${e.message}`);
      }
    }

    // 3. Basic meta (last resort — always works)
    if (!meta) {
      meta = cinemeta.getBasicMeta(imdbId, fallbackTitle, t);
    }

    // Stremio-shaped contract: keep JustWatch poster, ensure id is IMDB, normalise type
    meta.id = imdbId;
    if (justwatchPoster) meta.poster = justwatchPoster;
    if (!meta.type) {
      meta.type = (t === 'SHOW' || t === 'SERIES' || t === 'TV') ? 'series' : 'movie';
    } else if (meta.type === 'tv') {
      meta.type = 'series';
    } else if (meta.type === 'MOVIE') {
      meta.type = 'movie';
    }

    return meta;
  }

  /**
   * Test helper / debug: clear both caches. Not used in production paths.
   */
  function _resetCache() {
    idCache.clear();
    inflight.clear();
  }

  /**
   * Test helper: current cache stats.
   */
  function _stats() {
    return {
      idCacheSize: idCache.size,
      inflightSize: inflight.size,
    };
  }

  /**
   * Export the current idCache as a plain object, suitable for serializing
   * to disk. Negative cache entries (NULL_TMDB_ID) are kept — they save
   * /find calls for items TMDB never knows about.
   */
  function _exportIdCache() {
    const out = {};
    for (const [imdbId, val] of idCache.entries()) {
      out[imdbId] = val === NULL_TMDB_ID ? null : val;
    }
    return out;
  }

  /**
   * Import a previously exported idCache (e.g. loaded from disk on boot).
   * Overwrites any in-memory state. Use right after createMetaEnricher().
   */
  function _importIdCache(serialized) {
    idCache.clear();
    for (const [imdbId, val] of Object.entries(serialized || {})) {
      idCache.set(imdbId, val == null ? NULL_TMDB_ID : val);
    }
  }

  return Object.freeze({
    enrich,
    _resetCache,
    _stats,
    _exportIdCache,
    _importIdCache,
  });
}

export default createMetaEnricher;