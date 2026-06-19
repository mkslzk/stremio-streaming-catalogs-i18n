/**
 * TMDB (The Movie Database) client — used to enrich JustWatch catalog items
 * with localized metadata (title, description, runtime, year, poster).
 *
 * Replaces Cinemeta as the primary metadata source because Cinemeta is
 * English-only, while TMDB supports 80+ languages.
 *
 * Two auth methods are supported:
 *   - TMDB_READ_TOKEN (v4 Bearer token)  — preferred
 *   - TMDB_API_KEY (v3 key as query param) — fallback
 *
 * Design notes:
 *   - Pure factory: createTmdbClient({ readToken?, apiKey?, http? }) returns
 *     a frozen client object. No globals, no env access inside the module —
 *     all credentials are passed in. This makes the module trivially testable
 *     and lets the caller (server boot) decide where the credentials come
 *     from (.env / config flag / etc).
 *   - The HTTP client is injectable. Default is `axios` (matches the rest
 *     of the codebase); tests pass a mock.
 *   - Errors are normalized: 404 → null (caller falls back to Cinemeta);
 *     other non-2xx → thrown with status info; network errors wrapped.
 */

import axios from 'axios';

const BASE_URL = 'https://api.themoviedb.org/3';
const POSTER_SIZE = 'w500'; // TMDB poster size — good balance for Stremio catalog thumbnails

/**
 * Build the URL query params object for an outgoing request.
 * Adds api_key for v3 auth; v4 auth lives in the Authorization header.
 */
function authQuery(auth) {
  return auth.kind === 'v3' ? { api_key: auth.key } : {};
}

/**
 * Build the request headers.
 */
function authHeaders(auth, extra = {}) {
  const headers = { ...extra };
  if (auth.kind === 'v4') {
    headers.Authorization = `Bearer ${auth.token}`;
  }
  return headers;
}

/**
 * Resolve auth from the createTmdbClient input.
 * Returns { kind: 'v4', token } | { kind: 'v3', key } | throws.
 */
function resolveAuth({ readToken, apiKey }) {
  if (readToken && readToken.trim()) return { kind: 'v4', token: readToken.trim() };
  if (apiKey && apiKey.trim()) return { kind: 'v3', key: apiKey.trim() };
  throw new Error('TMDB credentials missing — set TMDB_READ_TOKEN or TMDB_API_KEY');
}

/**
 * Normalize the JustWatch-style type ('MOVIE' / 'SHOW') to TMDB's URL segment.
 * Accepts both 'MOVIE'/'SHOW' and 'movie'/'series' for flexibility.
 */
function tmdbType(type) {
  const t = String(type).toUpperCase();
  if (t === 'MOVIE') return 'movie';
  if (t === 'SHOW' || t === 'SERIES' || t === 'TV') return 'tv';
  throw new Error(`Unknown content type for TMDB lookup: ${type}`);
}

/**
 * Normalize TMDB's type back to Stremio's lowercase form ('movie' | 'series').
 */
function stremioType(type) {
  return type === 'tv' ? 'series' : 'movie';
}

/**
 * Normalize a TMDB movie/TV response into the shape the rest of the addon
 * already understands (same as the Cinemeta fallback in src/services/cinemeta.js).
 *
 * Returns null when the response is missing essential fields.
 */
function normalizeMeta(raw, type, imdbId) {
  if (!raw || !raw.id) return null;
  const isTv = type === 'tv';
  const title = isTv ? raw.name : raw.title;
  if (!title) return null;
  const date = isTv ? raw.first_air_date : raw.release_date;
  const year = date && typeof date === 'string' ? date.slice(0, 4) : undefined;
  // For TV shows, episode_run_time is an array — pick the first entry.
  const runtime = isTv
    ? (Array.isArray(raw.episode_run_time) ? raw.episode_run_time[0] : undefined)
    : raw.runtime;
  const poster = raw.poster_path
    ? `https://image.tmdb.org/t/p/${POSTER_SIZE}${raw.poster_path}`
    : undefined;
  const genres = Array.isArray(raw.genres)
    ? raw.genres.map((g) => g.name).filter(Boolean)
    : undefined;

  return {
    id: imdbId,
    name: title,
    type: stremioType(type),
    description: raw.overview || undefined,
    runtime,
    year,
    poster,
    imdbRating: raw.vote_average || undefined,
    genres,
  };
}

/**
 * Factory — returns a TMDB client with bound auth.
 *
 * @param {object} opts
 * @param {string} [opts.readToken]  v4 Bearer token (preferred)
 * @param {string} [opts.apiKey]     v3 API key (fallback)
 * @param {object} [opts.http]       HTTP client. Defaults to axios. Tests pass a mock.
 */
export function createTmdbClient(opts = {}) {
  const auth = resolveAuth(opts);
  const http = opts.http || axios;

  /**
   * Look up a TMDB id by IMDB id.
   * @param {string} imdbId  e.g. 'tt0111161'
   * @param {string} type    'MOVIE' | 'SHOW' | 'movie' | 'series'
   * @returns {Promise<number|null>}
   */
  async function findByImdbId(imdbId, type = 'MOVIE') {
    const url = `${BASE_URL}/find/${imdbId}`;
    const t = tmdbType(type);
    const params = {
      ...authQuery(auth),
      external_source: 'imdb_id',
      language: 'en-US', // find endpoint uses English IDs only; localization happens on detail
    };
    try {
      const res = await http.get(url, { params, headers: authHeaders(auth) });
      const bucket = t === 'tv' ? res.data?.tv_results : res.data?.movie_results;
      const first = Array.isArray(bucket) && bucket.length > 0 ? bucket[0] : null;
      return first && first.id ? first.id : null;
    } catch (e) {
      // Find returning 404 / empty → caller treats as no match
      if (e?.response?.status === 404) return null;
      throw wrapError('TMDB find', e);
    }
  }

  /**
   * Fetch localized movie metadata by TMDB id.
   * @param {number} tmdbId
   * @param {string} language  BCP-47, e.g. 'de-DE', 'en-US'
   * @param {string} [imdbId]  If provided, stamped onto the returned meta as `id`.
   * @returns {Promise<object|null>}  Stremio-shaped meta, or null on 404.
   */
  async function getMovieMeta(tmdbId, language = 'en-US', imdbId = null) {
    const url = `${BASE_URL}/movie/${tmdbId}`;
    const params = { ...authQuery(auth), language };
    try {
      const res = await http.get(url, { params, headers: authHeaders(auth) });
      if (res.status === 404) return null;
      return normalizeMeta(res.data, 'movie', imdbId);
    } catch (e) {
      if (e?.response?.status === 404) return null;
      throw wrapError('TMDB movie', e);
    }
  }

  /**
   * Fetch localized TV metadata by TMDB id.
   * @param {number} tmdbId
   * @param {string} language
   * @param {string} [imdbId]
   * @returns {Promise<object|null>}
   */
  async function getShowMeta(tmdbId, language = 'en-US', imdbId = null) {
    const url = `${BASE_URL}/tv/${tmdbId}`;
    const params = { ...authQuery(auth), language };
    try {
      const res = await http.get(url, { params, headers: authHeaders(auth) });
      if (res.status === 404) return null;
      return normalizeMeta(res.data, 'tv', imdbId);
    } catch (e) {
      if (e?.response?.status === 404) return null;
      throw wrapError('TMDB tv', e);
    }
  }

  /**
   * End-to-end helper: given an IMDB id, type and language, return localized
   * meta (or null if TMDB has no match). This is what callers will use.
   * @param {string} imdbId
   * @param {string} type   'MOVIE' | 'SHOW'
   * @param {string} language
   * @returns {Promise<object|null>}
   */
  async function getLocalizedMeta(imdbId, type = 'MOVIE', language = 'en-US') {
    const t = tmdbType(type);
    const tmdbId = await findByImdbId(imdbId, t);
    if (tmdbId == null) return null;
    const meta = t === 'tv' ? await getShowMeta(tmdbId, language)
                              : await getMovieMeta(tmdbId, language);
    if (meta) meta.id = imdbId; // ensure IMDB id, not TMDB id
    return meta;
  }

  return Object.freeze({
    findByImdbId,
    getMovieMeta,
    getShowMeta,
    getLocalizedMeta,
  });
}

/**
 * Wrap an unknown error with a TMDB-context prefix so logs are debuggable.
 */
function wrapError(context, e) {
  const status = e?.response?.status;
  const msg = e?.response?.data?.status_message || e?.message || String(e);
  const wrapped = new Error(`${context} error${status ? ` (HTTP ${status})` : ''}: ${msg}`);
  wrapped.cause = e;
  wrapped.status = status;
  return wrapped;
}

export default createTmdbClient;