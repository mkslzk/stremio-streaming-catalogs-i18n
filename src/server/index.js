import express from 'express';
import cors from 'cors';
import Mixpanel from 'mixpanel';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import justwatch from '../services/justwatch.js';
import { loadCatalogCache, saveCatalogCache, clearCatalogCache, loadTmdbIdCache, saveTmdbIdCache } from '../utils/cache.js';
import { handleConfiguredManifest, handleDefaultManifest } from './routes/manifest.js';
import { handleCatalog } from './routes/catalog.js';
import { createTmdbClient } from '../services/tmdb.js';
import { createMetaEnricher } from '../services/meta.js';
import { fetchCinemetaMeta, getBasicMeta } from '../services/cinemeta.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REFRESH_INTERVAL = process.env.REFRESH_INTERVAL || 21600000; // 6 hours in milliseconds
const USE_CACHE = process.env.USE_CACHE !== 'false'; // Default to true
const FORCE_REFRESH = process.env.FORCE_REFRESH === 'true'; // Default to false

// ─────────────────────────────────────────────────────────────────────────────
// Meta-enricher setup
//
// TMDB client is built once at boot. If TMDB credentials are missing, we skip
// enrichment entirely (the existing Cinemeta-only path takes over).
// ─────────────────────────────────────────────────────────────────────────────
const tmdb = (() => {
  try {
    return createTmdbClient({
      readToken: process.env.TMDB_READ_TOKEN,
      apiKey: process.env.TMDB_API_KEY,
    });
  } catch (e) {
    console.warn('TMDB client not initialized:', e.message, '— falling back to Cinemeta-only');
    return null;
  }
})();

const metaEnricher = tmdb
  ? createMetaEnricher({
      tmdb,
      cinemeta: { fetchCinemetaMeta, getBasicMeta },
      logger: (msg) => console.warn('[meta]', msg),
    })
  : null;

// Restore the IMDB→TMDB id cache from disk if present. After the first cold
// boot, this saves us ~thousands of /find calls per restart.
if (metaEnricher) {
  const cached = loadTmdbIdCache();
  if (cached && Object.keys(cached).length > 0) {
    metaEnricher._importIdCache(cached);
    console.log(`Loaded ${Object.keys(cached).length} TMDB id mappings from cache`);
  }
}

// Persist the TMDB id cache on graceful shutdown so the next boot skips the
// /find round-trip for known items. SIGINT (Ctrl-C) and SIGTERM are the
// common stop signals in dev and Docker.
function persistTmdbIdCache() {
  if (metaEnricher) {
    try {
      saveTmdbIdCache(metaEnricher._exportIdCache());
    } catch (e) {
      console.warn('Failed to persist TMDB id cache:', e.message);
    }
  }
}
process.on('SIGINT', () => { persistTmdbIdCache(); process.exit(0); });
process.on('SIGTERM', () => { persistTmdbIdCache(); process.exit(0); });

// Production error handling
if (process.env.NODE_ENV === 'production') {
  const errorLog = fs.createWriteStream(path.join(__dirname, '../../vue/dist/error.log'));
  process.stderr.write = errorLog.write.bind(errorLog);

  process.on('uncaughtException', function (err) {
    console.error((err && err.stack) ? err.stack : err);
  });
}

const app = express();
app.set('trust proxy', true);
app.use(cors());
app.use(express.static(path.join(__dirname, '../../vue/dist')));

// Initialize Mixpanel
let mixpanel = null;
if (process.env.MIXPANEL_KEY) {
  mixpanel = Mixpanel.init(process.env.MIXPANEL_KEY);
}

// Catalog data storage
let movies = {
  'nfx': [], 'nfk': [], 'dnp': [], 'amp': [], 'atp': [], 'pmp': [], 'hbm': [],
  'hlu': [], 'pcp': [], 'cru': [], 'jhs': [], 'zee': [], 'vil': [], 'clv': [],
  'gop': [], 'mgl': [], 'cts': [], 'sst': [], 'nlz': [], 'stz': [], 'mbi': [],
  'vik': [], 'sgo': [], 'sonyliv': [], 'cpd': [], 'mp9': [], 'shd': [], 'bbo': [],
  'act': [], 'itv': [], 'bbc': [], 'al4': [], 'crc': [], 'iqi': [], 'sha': [],
};

let series = {
  'nfx': [], 'nfk': [], 'dnp': [], 'amp': [], 'atp': [], 'pmp': [], 'hbm': [],
  'hlu': [], 'pcp': [], 'cru': [], 'jhs': [], 'zee': [], 'vil': [], 'clv': [],
  'gop': [], 'mgl': [], 'cts': [], 'sst': [], 'nlz': [], 'stz': [], 'vik': [],
  'sgo': [], 'sonyliv': [], 'hay': [], 'cpd': [], 'dpe': [], 'mp9': [], 'shd': [],
  'bbo': [], 'act': [], 'itv': [], 'bbc': [], 'al4': [], 'iqi': [], 'sha': [],
};

/**
 * Load catalog data (from cache or fresh fetch)
 */
async function loadNewCatalog() {
  console.log('loadNewCatalog');
  
  // Clear cache if force refresh is enabled
  if (FORCE_REFRESH) {
    clearCatalogCache();
  }
  
  // Try to load from cache first (if caching is enabled)
  if (USE_CACHE) {
    const cachedData = loadCatalogCache(REFRESH_INTERVAL);
    if (cachedData) {
      Object.assign(movies, cachedData.movies);
      Object.assign(series, cachedData.series);
      console.log('Catalog data loaded from cache');
      return;
    }
  }
  
  // If no cache or expired, fetch fresh data
  console.log('Fetching fresh catalog data...');
  // CATALOG_LANGUAGE defaults to 'en'. Per-provider overrides below match
  // the original config: regional providers (NL/IN/BR/FR/DE/ES/HI) keep their
  // native language so JustWatch still returns the right country availability.
  const DEFAULT_LANG = process.env.CATALOG_LANGUAGE || 'en';
  // Helper: build a caller that threads the metaEnricher through to getMetas.
  const call = (type, providers, country, lang = DEFAULT_LANG) =>
    justwatch.getMetas(type, providers, country, lang, metaEnricher);
  movies.nfx = await call('MOVIE', ['nfx'], 'GB');
  movies.nfk = await call('MOVIE', ['nfk'], 'US');
  movies.dnp = await call('MOVIE', ['dnp'], 'GB');
  movies.atp = await call('MOVIE', ['atp'], 'GB');
  movies.amp = await call('MOVIE', ['amp'], 'US');
  movies.pmp = await call('MOVIE', ['pmp'], 'US');
  movies.hbm = await call('MOVIE', ['hbm'], 'NL');
  movies.hlu = await call('MOVIE', ['hlu'], 'US');
  movies.pcp = await call('MOVIE', ['pcp'], 'US');
  movies.cts = await call('MOVIE', ['cts'], 'US');
  movies.mgl = await call('MOVIE', ['mgl'], 'US');
  movies.cru = await call('MOVIE', ['cru'], 'US');
  movies.jhs = await call('MOVIE', ['jhs'], 'IN', 'in');
  movies.zee = await call('MOVIE', ['zee'], 'IN', 'in');
  movies.vil = await call('MOVIE', ['vil'], 'NL', 'nl');
  movies.nlz = await call('MOVIE', ['nlz'], 'NL', 'nl');
  movies.sst = await call('MOVIE', ['sst'], 'NL', 'nl');
  movies.clv = await call('MOVIE', ['clv'], 'BR', 'br');
  movies.gop = await call('MOVIE', ['gop'], 'BR', 'br');
  movies.cpd = await call('MOVIE', ['cpd'], 'FR', 'fr');
  movies.stz = await call('MOVIE', ['stz'], 'US');
  movies.mbi = await call('MOVIE', ['mbi'], 'US');
  movies.vik = await call('MOVIE', ['vik'], 'US');
  movies.sgo = await call('MOVIE', ['sgo'], 'DE', 'de');
  movies.sonyliv = await call('MOVIE', ['sonyliv'], 'IN', 'hi');
  movies.mp9 = await call('MOVIE', ['mp9'], 'ES', 'es');
  movies.shd = await call('MOVIE', ['shd'], 'US');
  movies.bbo = await call('MOVIE', ['bbo'], 'US');
  movies.act = await call('MOVIE', ['act'], 'US');
  movies.crc = await call('MOVIE', ['crc'], 'US');
  movies.iqi = await call('MOVIE', ['iqi'], 'US');
  movies.sha = await call('MOVIE', ['sha'], 'US');
  movies.itv = await call('MOVIE', ['itv'], 'GB');
  movies.bbc = await call('MOVIE', ['bbc'], 'GB');
  movies.al4 = await call('MOVIE', ['al4'], 'GB');

  series.nfx = await call('SHOW', ['nfx'], 'GB');
  series.nfk = await call('SHOW', ['nfk'], 'US');
  series.dnp = await call('SHOW', ['dnp'], 'GB');
  series.atp = await call('SHOW', ['atp'], 'GB');
  series.hay = await call('SHOW', ['hay'], 'GB');
  series.dpe = await call('SHOW', ['dpe'], 'GB');
  series.amp = await call('SHOW', ['amp'], 'US');
  series.pmp = await call('SHOW', ['pmp'], 'US');
  series.hbm = await call('SHOW', ['hbm'], 'NL');
  series.hlu = await call('SHOW', ['hlu'], 'US');
  series.pcp = await call('SHOW', ['pcp'], 'US');
  series.cru = await call('SHOW', ['cru'], 'US');
  series.cts = await call('SHOW', ['cts'], 'US');
  series.mgl = await call('SHOW', ['mgl'], 'US');
  series.jhs = await call('SHOW', ['jhs'], 'IN', 'in');
  series.zee = await call('SHOW', ['zee'], 'IN', 'in');
  series.vil = await call('SHOW', ['vil'], 'NL', 'nl');
  series.nlz = await call('SHOW', ['nlz'], 'NL', 'nl');
  series.sst = await call('SHOW', ['sst'], 'NL', 'nl');
  series.clv = await call('SHOW', ['clv'], 'BR', 'br');
  series.gop = await call('SHOW', ['gop'], 'BR', 'br');
  series.cpd = await call('SHOW', ['cpd'], 'FR', 'fr');
  series.stz = await call('SHOW', ['stz'], 'US');
  series.vik = await call('SHOW', ['vik'], 'US');
  series.sgo = await call('SHOW', ['sgo'], 'DE', 'de');
  series.sonyliv = await call('SHOW', ['sonyliv'], 'IN', 'hi');
  series.mp9 = await call('SHOW', ['mp9'], 'ES', 'es');
  series.shd = await call('SHOW', ['shd'], 'US');
  series.bbo = await call('SHOW', ['bbo'], 'US');
  series.act = await call('SHOW', ['act'], 'US');
  series.iqi = await call('SHOW', ['iqi'], 'US');
  series.sha = await call('SHOW', ['sha'], 'US');
  series.itv = await call('SHOW', ['itv'], 'GB');
  series.bbc = await call('SHOW', ['bbc'], 'GB');
  series.al4 = await call('SHOW', ['al4'], 'GB');

  // Save to cache (if caching is enabled)
  if (USE_CACHE) {
    saveCatalogCache(movies, series);
  }
  console.log('done');
}

// Routes
app.get('/:configuration/manifest.json', (req, res) => {
  handleConfiguredManifest(req, res, mixpanel);
});

app.get('/manifest.json', (req, res) => {
  handleDefaultManifest(req, res, mixpanel);
});

app.get('/:configuration?/catalog/:type/:id/:extra?.json', (req, res) => {
  handleCatalog(req, res, movies, series, mixpanel);
});

// Development endpoint to clear cache
if (process.env.NODE_ENV !== 'production') {
  app.get('/clear-cache', function (req, res) {
    clearCatalogCache();
    res.json({ message: 'Cache cleared successfully' });
  });
}

// Fallback to Vue
app.get(/.*/, (req, res) => {
  res.setHeader('Cache-Control', 'max-age=86400,stale-while-revalidate=86400,stale-if-error=86400,public');
  res.setHeader('content-type', 'text/html');
  res.sendFile(path.join(__dirname, '../../vue/dist/index.html'));
});

// Initialize catalog loading
loadNewCatalog();
setInterval(loadNewCatalog, REFRESH_INTERVAL);

export default app;

