import axios from 'axios';
import { fetchCinemetaMeta, getBasicMeta } from './cinemeta.js';

const AMOUNT = 100;
const AMOUNT_TO_VERIFY = 24;
const DUPES_CACHE = {};
const DELETED_CACHE = [];

export default {
  verify: true,
  async getLatest(type = 'MOVIE', providers = ['nfx'], country = "GB", language = 'en') {
    // todo
  },
  async getMetas(type = 'MOVIE', providers = ['nfx'], country = "GB", language = 'en', metaEnricher = null) {
    let res = null;
    try {
      res = await axios.post('https://apis.justwatch.com/graphql', {
        "operationName": "GetPopularTitles",
        "variables": {
          "popularTitlesSortBy": "TRENDING",
          "first": AMOUNT,
          "platform": "WEB",
          "sortRandomSeed": 0,
          "popularAfterCursor": "",
          "offset": null,
          "popularTitlesFilter": {
            "ageCertifications": [],
            "excludeGenres": [],
            "excludeProductionCountries": [],
            "genres": [],
            "objectTypes": [
              type
            ],
            "productionCountries": [],
            "packages": providers,
            "excludeIrrelevantTitles": false,
            "presentationTypes": [],
            "monetizationTypes": [],
          },
          "language": language,
          "country": country
        },
        "query": "query GetPopularTitles(\n  $country: Country!\n  $popularTitlesFilter: TitleFilter\n  $popularAfterCursor: String\n  $popularTitlesSortBy: PopularTitlesSorting! = POPULAR\n  $first: Int!\n  $language: Language!\n  $offset: Int = 0\n  $sortRandomSeed: Int! = 0\n  $profile: PosterProfile\n  $backdropProfile: BackdropProfile\n  $format: ImageFormat\n) {\n  popularTitles(\n    country: $country\n    filter: $popularTitlesFilter\n    offset: $offset\n    after: $popularAfterCursor\n    sortBy: $popularTitlesSortBy\n    first: $first\n    sortRandomSeed: $sortRandomSeed\n  ) {\n    totalCount\n    pageInfo {\n      startCursor\n      endCursor\n      hasPreviousPage\n      hasNextPage\n      __typename\n    }\n    edges {\n      ...PopularTitleGraphql\n      __typename\n    }\n    __typename\n  }\n}\n\nfragment PopularTitleGraphql on PopularTitlesEdge {\n  cursor\n  node {\n    id\n    objectId\n    objectType\n    content(country: $country, language: $language) {\n      externalIds {\n        imdbId\n      }\n      title\n      fullPath\n      scoring {\n        imdbScore\n        __typename\n      }\n      posterUrl(profile: $profile, format: $format)\n      ... on ShowContent {\n        backdrops(profile: $backdropProfile, format: $format) {\n          backdropUrl\n          __typename\n        }\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n  __typename\n}"
      });
    } catch (e) {
      console.error(e.message);
      console.log(e.response?.data);
      return [];
    }

    console.log(providers.join(','), res.data.data.popularTitles.edges.length);

    return (await Promise.all(res.data.data.popularTitles.edges.map(async (item, index) => {
      let imdbId = item.node.content.externalIds.imdbId;

      if (!imdbId || DELETED_CACHE.includes(imdbId)) {
        if (imdbId) console.log('deleted cache hit');

        return null;
      }

      if (DUPES_CACHE[imdbId]) {
        console.log('dupe cache hit');
        imdbId = DUPES_CACHE[imdbId];
      } else if (index < AMOUNT_TO_VERIFY && this.verify) {
        try {
          await axios.head(`https://www.imdb.com/title/${imdbId}/`, {
            maxRedirects: 0,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:109.0) Gecko/20100101 Firefox/110.0'
            }
          });
        } catch (e) {
          if (e.response?.status === 308) {
            const newImdbId = e.response?.headers?.['location']?.split('/')?.[2];
            console.log('DUPE imdb redirects to', newImdbId);
            DUPES_CACHE[imdbId] = newImdbId;
            imdbId = newImdbId;
          } else if (e.response?.status === 404) {
            console.log('imdb does not exist');
            DELETED_CACHE.push(imdbId);
            return null;
          } else {
            console.error('Stop verifying, IMDB error', e.response?.status);
            this.verify = false;
          }
        }
      }

      const posterId = item?.node?.content?.posterUrl?.match(/\/poster\/([0-9]+)\//)?.pop();
      let posterUrl;
      if (posterId) {
        posterUrl = `https://images.justwatch.com/poster/${posterId}/s332/img`;
      } else {
        posterUrl = `https://live.metahub.space/poster/medium/${imdbId}/img`;
      }

      // Enrich metadata: TMDB primary, Cinemeta fallback, basic meta last.
      // If a metaEnricher is provided, it owns the i18n logic. If not, fall
      // back to the original Cinemeta-only path (backward compatibility).
      if (metaEnricher) {
        return await metaEnricher.enrich({
          imdbId,
          type,
          language,
          fallbackTitle: item.node.content.title,
          justwatchPoster: posterUrl,
        });
      }

      const cinemetaMeta = await fetchCinemetaMeta(imdbId, type, item.node.content.title);

      if (cinemetaMeta) {
        return {
          ...cinemetaMeta,
          poster: posterUrl, // Use JustWatch poster URL
        };
      }

      // Fallback to basic metadata
      return {
        ...getBasicMeta(imdbId, item.node.content.title, type),
        poster: posterUrl, // Use JustWatch poster URL
      };
    }))).filter(item => item?.id);
  }
}

