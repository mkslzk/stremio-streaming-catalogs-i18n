import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CACHE_DIR = path.join(__dirname, '../../cache');

/**
 * Ensure cache directory exists
 */
export function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

/**
 * Load catalog cache from disk
 */
export function loadCatalogCache(refreshInterval = 21600000) {
  ensureCacheDir();
  const cacheFile = path.join(CACHE_DIR, 'catalog-cache.json');
  
  try {
    if (fs.existsSync(cacheFile)) {
      const cacheData = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      const now = Date.now();
      
      // Check if cache is still valid
      if (cacheData.timestamp && (now - cacheData.timestamp) < refreshInterval) {
        console.log('Loading catalog data from cache...');
        return {
          movies: cacheData.movies || {},
          series: cacheData.series || {}
        };
      } else {
        console.log('Cache expired, will fetch fresh data...');
      }
    }
  } catch (error) {
    console.log('Error loading cache:', error.message);
  }
  return null;
}

/**
 * Save catalog cache to disk
 */
export function saveCatalogCache(movies, series) {
  ensureCacheDir();
  const cacheFile = path.join(CACHE_DIR, 'catalog-cache.json');
  
  try {
    const cacheData = {
      timestamp: Date.now(),
      movies,
      series
    };
    fs.writeFileSync(cacheFile, JSON.stringify(cacheData, null, 2));
    console.log('Catalog data cached successfully');
  } catch (error) {
    console.log('Error saving cache:', error.message);
  }
}

/**
 * Clear catalog cache
 */
export function clearCatalogCache() {
  ensureCacheDir();
  const cacheFile = path.join(CACHE_DIR, 'catalog-cache.json');
  
  try {
    if (fs.existsSync(cacheFile)) {
      fs.unlinkSync(cacheFile);
      console.log('Cache cleared successfully');
    }
  } catch (error) {
    console.log('Error clearing cache:', error.message);
  }
}

/**
 * Load resolution cache from disk
 */
export function loadResolutionCache(cacheDurationMs = 7 * 24 * 60 * 60 * 1000) {
  ensureCacheDir();
  const cacheFile = path.join(CACHE_DIR, 'netflix-top10-resolved.json');
  
  try {
    if (fs.existsSync(cacheFile)) {
      const cacheData = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      const now = Date.now();
      
      // Check if cache is still valid
      if (cacheData.timestamp && (now - cacheData.timestamp) < cacheDurationMs) {
        return cacheData.resolutions || {};
      }
    }
  } catch (error) {
    console.log('Error loading resolution cache:', error.message);
  }
  return {};
}

/**
 * Save resolution cache to disk
 */
export function saveResolutionCache(resolutions) {
  ensureCacheDir();
  const cacheFile = path.join(CACHE_DIR, 'netflix-top10-resolved.json');
  
  try {
    const cacheData = {
      timestamp: Date.now(),
      resolutions,
    };
    fs.writeFileSync(cacheFile, JSON.stringify(cacheData, null, 2));
  } catch (error) {
    console.log('Error saving resolution cache:', error.message);
  }
}

/**
 * Load Netflix Top 10 catalog cache from disk
 * Cache duration: 24 hours (daily refresh)
 * Returns object with catalogs and timestamp
 */
export function loadNetflixTop10Cache(cacheDurationMs = 24 * 60 * 60 * 1000) {
  ensureCacheDir();
  const cacheFile = path.join(CACHE_DIR, 'netflix-top10-catalog.json');
  
  try {
    if (fs.existsSync(cacheFile)) {
      const cacheData = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      const now = Date.now();
      
      // Check if cache is still valid
      if (cacheData.timestamp && (now - cacheData.timestamp) < cacheDurationMs) {
        return {
          catalogs: cacheData.catalogs || {},
          timestamp: cacheData.timestamp,
        };
      } else {
        console.log('Netflix Top 10 catalog cache expired, will fetch fresh data');
      }
    }
  } catch (error) {
    console.log('Error loading Netflix Top 10 catalog cache:', error.message);
  }
  return {
    catalogs: {},
    timestamp: null,
  };
}

/**
 * Save Netflix Top 10 catalog cache to disk
 */
export function saveNetflixTop10Cache(catalogs) {
  ensureCacheDir();
  const cacheFile = path.join(CACHE_DIR, 'netflix-top10-catalog.json');
  
  try {
    const cacheData = {
      timestamp: Date.now(),
      catalogs,
    };
    fs.writeFileSync(cacheFile, JSON.stringify(cacheData, null, 2));
    console.log('Netflix Top 10 catalog cache saved successfully');
  } catch (error) {
    console.log('Error saving Netflix Top 10 catalog cache:', error.message);
  }
}



// ─────────────────────────────────────────────────────────────────────────────
// TMDB IMDB→TMDB-id cache (i18n fork)
//
// Persists the mapping forever (or until the file is manually cleared). TMDB
// IDs are stable — once we resolve an IMDB id, it never changes. This means
// after the first cold boot the server makes zero /find calls for known items.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load TMDB id cache from disk. Returns {} if missing/corrupt.
 * @returns {Object<string, number|null>}  { imdbId: tmdbId or null }
 */
export function loadTmdbIdCache() {
  ensureCacheDir();
  const cacheFile = path.join(CACHE_DIR, 'tmdb-id-cache.json');

  try {
    if (fs.existsSync(cacheFile)) {
      const data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        return data;
      }
    }
  } catch (error) {
    console.log('Error loading TMDB id cache:', error.message);
  }
  return {};
}

/**
 * Save TMDB id cache to disk. Writes synchronously — called from a graceful
 * shutdown hook so we don't need async here.
 * @param {Object<string, number|null>} idMap
 */
export function saveTmdbIdCache(idMap) {
  ensureCacheDir();
  const cacheFile = path.join(CACHE_DIR, 'tmdb-id-cache.json');

  try {
    const data = {
      timestamp: Date.now(),
      ids: idMap,
    };
    fs.writeFileSync(cacheFile, JSON.stringify(data, null, 2));
    console.log(`TMDB id cache saved: ${Object.keys(idMap).length} entries`);
  } catch (error) {
    console.log('Error saving TMDB id cache:', error.message);
  }
}
