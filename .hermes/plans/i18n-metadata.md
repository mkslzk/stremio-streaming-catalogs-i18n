# i18n Metadata — Plan

> Status: **proposed** (waiting on user decisions before any code is changed)

## Goal

Make catalog titles, descriptions, and other metadata appear in the user's
language, not English-only.

## Why it currently doesn't work

The metadata pipeline is split across three sources, all of which deliver
English-only data:

| Source                | File                          | What it provides            | Locale support                  |
|-----------------------|-------------------------------|-----------------------------|---------------------------------|
| JustWatch GraphQL API | `src/services/justwatch.js`   | Provider availability       | ✅ has `language` param, but caller doesn't pass it for most providers |
| Cinemeta (Stremio)    | `src/services/cinemeta.js`    | Title + description         | ❌ hardcoded to English         |
| Netflix Top-10        | `src/services/netflix/*.js`   | Titles for Netflix Top-10   | ❌ hardcoded to English         |

`src/server/index.js` lines 81–151 hard-code the language for most providers
(e.g. `nfx` is always called as `justwatch.getMetas('MOVIE', ['nfx'], 'GB')`
with no language argument → defaults to `'en'`). Cinemeta has no language
parameter at all and responds in English.

## Strategy

**Replace Cinemeta with TMDB for metadata enrichment.** TMDB supports 80+
languages and is a drop-in replacement for the `fetchCinemetaMeta` step.

JustWatch itself already supports the `language` parameter — we just need to
plumb it through from the user config and stop defaulting to `'en'`.

### Pipeline (proposed)

```
JustWatch (provider + locale)
    │
    ▼
enrich with TMDB (imdb → tmdb_id lookup, then /movie/{id}?language=de-DE)
    │
    ▼
Stremio meta object (title, description, posters all localized)
```

### Two i18n dimensions

1. **Catalog locale** — what language the *titles* come in (set per provider
   from user config).
2. **Region** — what country determines provider availability (already
   configurable via the addon config base64, but the `country` per provider
   is hard-coded in `index.js`).

This plan focuses on #1 (catalog locale). #2 is a bigger refactor and is out
of scope unless explicitly requested.

## Proposed Changes (surgical)

1. **`src/services/tmdb.js`** *(new)* — thin TMDB client:
   - `getTmdbIdFromImdb(imdbId, type)` — IMDB → TMDB ID
   - `getMovieMeta(tmdbId, language)` → `{ name, description, ... }`
   - `getShowMeta(tmdbId, language)`
   - Uses TMDB API v3 with `TMDB_API_KEY` env var.

2. **`src/services/cinemeta.js`** — replace `fetchCinemetaMeta` body to call
   TMDB instead, keep same function signature (drop-in).

3. **`src/server/index.js`** — replace hard-coded language defaults with the
   `language` field that JustWatch already supports, derived from a single
   `LOCALE` env var (e.g. `de-DE` → `de`). Keep existing per-provider
   language overrides for the regional providers (NL/IN/BR/FR/DE/ES/HI)
   that were already configured.

4. **Config plumbing** — extend the base64 config to optionally include
   `language`, defaulting to env-var `LOCALE` → `'en'`.

5. **Frontend** — add a language selector to the Vue configurator so users
   can pick at install time.

6. **Tests** — `tests/i18n.test.js` — unit test for TMDB enrichment,
   integration test for full pipeline (mock JustWatch, real TMDB).

## Decisions (resolved with user 2026-06-19)

| # | Question                                                          | Decision                  |
|---|-------------------------------------------------------------------|---------------------------|
| A | Which languages must work in v1?                                  | **All 80+ that TMDB supports** |
| B | How should users set the language?                                | **Config flag in frontend only** (no env var) |
| C | Where will the hosted build run?                                  | **Local for now, decide hosting later** |
| D | Cinemeta fallback when TMDB has no match?                         | **Keep Cinemeta as fallback** |

## Non-goals (for this iteration)

- Changing provider availability per region (separate refactor)
- Localizing the Stremio addon name / description itself (Stremio convention:
  these stay in English)
- Touching the Netflix Top-10 fetcher (low priority, separate concern)

## Risks

- **TMDB rate limits** — 40 req/s per key, our burst is ~30 JustWatch titles
  per provider × ~30 providers = ~900 titles, but we batch via cache (6h),
  so worst case is one burst every 6h → ~1 req/s sustained. Well within
  limits.
- **TMDB API key** — needs free signup at https://www.themoviedb.org/settings/api
- **Some IMDB IDs have no TMDB match** — fallback to current English Cinemeta
  data, marked as such in the meta object.

## Verification

- Local dev server up, install via Stremio with locale `de-DE`.
- All titles in DE Netflix catalog should be German.
- TMDB fallback path: monkey-patch one IMDB ID to return 404 from TMDB →
  should fall back to English Cinemeta data without crashing.
- Cache hit on second load (no TMDB re-fetch).