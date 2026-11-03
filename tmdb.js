/**
 * LoRix TMDB Live Catalog — dynamic global fetcher (90,000+ titles)
 *
 * Covers Hollywood, Anime, K-Drama, Turkish and Arabic catalogs through
 * TMDB trending / popular / discover / search endpoints, with real
 * posters, ratings, years and overviews.
 *
 * KEY: drop your TMDB v3 API key into TMDB_API_KEY below, or set it at
 * runtime — LoRixTMDB.configure({ apiKey: '...' }) — which also persists
 * to localStorage['lorix.tmdb_key']. Without a key every call degrades to
 * [] and the app runs on its bundled catalog.
 *
 * Season/episode data for TV shows: getTvShow() / getTvSeason().
 * IMDb resolution for the Family Engine: resolveImdbId().
 */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.LoRixTMDB = api;
})(typeof window !== 'undefined' ? window : this, function () {
    'use strict';

    /* ======================= CONFIG SLOT ======================= */
    var TMDB_API_KEY = ''; // <<< TMDB v3 API key (40 chars) goes here
    /* ========================================================== */

    var BASE = 'https://api.themoviedb.org/3';
    var IMG = 'https://image.tmdb.org/t/p';
    var CACHE_NS = 'lorix.tmdb.';
    var TTL = {
        bootstrap: 12 * 60 * 60 * 1000, // home rails: 12h
        search: 5 * 60 * 1000,          // live queries: 5min
        detail: 30 * 60 * 1000,         // show/season: 30min
        meta: 24 * 60 * 60 * 1000       // imdb lookups: 24h
    };

    var GENRES = {
        28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy',
        80: 'Crime', 99: 'Documentary', 18: 'Drama', 10751: 'Family',
        14: 'Fantasy', 36: 'History', 27: 'Horror', 10402: 'Music',
        9648: 'Mystery', 10749: 'Romance', 878: 'Sci-Fi', 53: 'Thriller',
        10752: 'War', 37: 'Western', 10759: 'Action & Adventure',
        10762: 'Kids', 10763: 'News', 10764: 'Reality',
        10765: 'Sci-Fi & Fantasy', 10766: 'Soap', 10767: 'Talk',
        10768: 'War & Politics'
    };

    var FALLBACK_POSTER = 'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?auto=format&fit=crop&w=400&q=80';

    var apiKey = '';
    var mem = Object.create(null);

    try {
        apiKey = TMDB_API_KEY || localStorage.getItem('lorix.tmdb_key') || '';
    } catch (e) {
        apiKey = TMDB_API_KEY || '';
    }

    /* --------------------------- config ------------------------ */

    function configure(opts) {
        if (opts && opts.apiKey) {
            apiKey = String(opts.apiKey).trim();
            try { localStorage.setItem('lorix.tmdb_key', apiKey); } catch (e) {}
            mem = Object.create(null);
        }
        return isReady();
    }

    function isReady() { return !!apiKey; }

    function isTmdbId(id) { return /^\d+$/.test(String(id == null ? '' : id)); }

    /* ------------------------ tiny cache ----------------------- */

    function hash(str) {
        var h = 5381;
        for (var i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
        return h.toString(36);
    }

    function cacheGet(url, ttl) {
        var hit = mem[url];
        if (hit && Date.now() - hit.at <= ttl) return hit.data;
        try {
            var raw = localStorage.getItem(CACHE_NS + hash(url));
            if (!raw) return null;
            var entry = JSON.parse(raw);
            if (Date.now() - entry.at > ttl) {
                localStorage.removeItem(CACHE_NS + hash(url));
                return null;
            }
            mem[url] = entry;
            return entry.data;
        } catch (e) { return null; }
    }

    function cachePut(url, data, ttl) {
        var entry = { at: Date.now(), data: data };
        mem[url] = entry;
        try { localStorage.setItem(CACHE_NS + hash(url), JSON.stringify(entry)); } catch (e) {}
    }

    function clearCache() {
        mem = Object.create(null);
        try {
            Object.keys(localStorage).forEach(function (k) {
                if (k.indexOf(CACHE_NS) === 0) localStorage.removeItem(k);
            });
        } catch (e) {}
    }

    /* --------------------------- fetch ------------------------- */

    function buildUrl(path, params) {
        var url = BASE + path + '?api_key=' + encodeURIComponent(apiKey) + '&language=en-US';
        if (params) {
            Object.keys(params).forEach(function (k) {
                var v = params[k];
                if (v !== undefined && v !== null && v !== '') {
                    url += '&' + k + '=' + encodeURIComponent(v);
                }
            });
        }
        return url;
    }

    async function get(path, params, ttl) {
        if (!isReady()) throw new Error('TMDB API key missing');
        var url = buildUrl(path, params);
        var limit = ttl || TTL.search;
        var cached = cacheGet(url, limit);
        if (cached) return cached;

        var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 12000) : null;
        try {
            var res = await fetch(url, ctrl ? { signal: ctrl.signal } : undefined);
            if (!res.ok) throw new Error('TMDB HTTP ' + res.status);
            var data = await res.json();
            cachePut(url, data, limit);
            return data;
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    /* ------------------------ mapping -------------------------- */

    function posterUrl(path, size) {
        return path ? IMG + '/' + (size || 'w500') + path : '';
    }

    function genreNames(ids) {
        return (ids || []).map(function (id) { return GENRES[id]; }).filter(Boolean);
    }

    function mapItem(raw, fallbackType, tag) {
        if (!raw || raw.media_type === 'person') return null;

        var type = (raw.media_type === 'movie' || raw.media_type === 'tv')
            ? raw.media_type
            : (fallbackType || (raw.title ? 'movie' : 'tv'));

        var title = type === 'tv'
            ? (raw.name || raw.original_name)
            : (raw.title || raw.original_title);
        if (!title) return null;

        var date = type === 'tv' ? raw.first_air_date : raw.release_date;
        var year = date ? parseInt(String(date).slice(0, 4), 10) : null;
        var names = genreNames(raw.genre_ids);
        if (tag) names.push(tag);

        return {
            id: String(raw.id),
            source: 'tmdb',
            type: type,
            title: title,
            year: year || null,
            rating: Math.round((raw.vote_average || 0) * 10) / 10 || null,
            genre: names.length ? names.join(' / ') : 'Featured',
            poster: posterUrl(raw.poster_path) || posterUrl(raw.backdrop_path, 'w780') || FALLBACK_POSTER,
            desc: (raw.overview || 'Ultra-high definition cinema stream available on LoRix cloud.')
                .slice(0, 240),
            popularity: raw.popularity || 0
        };
    }

    /* ------------------- home rails (bootstrap) ---------------- */

    var RAILS = [
        { path: '/trending/all/week', params: { page: 1 }, type: null },
        { path: '/movie/popular', params: { page: 1 }, type: 'movie' },
        { path: '/movie/top_rated', params: { page: 2 }, type: 'movie' },
        { path: '/tv/popular', params: { page: 1 }, type: 'tv' },
        { path: '/tv/top_rated', params: { page: 1 }, type: 'tv' },
        { path: '/discover/tv', params: { with_genres: 16, sort_by: 'popularity.desc' }, type: 'tv', tag: 'Anime' },
        { path: '/discover/tv', params: { with_origin_country: 'KR', sort_by: 'popularity.desc' }, type: 'tv', tag: 'K-Drama' },
        { path: '/discover/tv', params: { with_origin_country: 'TR', sort_by: 'popularity.desc' }, type: 'tv', tag: 'Turkish' },
        { path: '/discover/tv', params: { with_original_language: 'ar', sort_by: 'popularity.desc' }, type: 'tv', tag: 'Arabic' },
        { path: '/discover/movie', params: { with_original_language: 'ar', sort_by: 'popularity.desc' }, type: 'movie', tag: 'Arabic' }
    ];

    async function bootstrapRails() {
        if (!isReady()) return [];
        var batches = await Promise.all(RAILS.map(function (rail) {
            return get(rail.path, rail.params, TTL.bootstrap)
                .then(function (data) {
                    return (data.results || [])
                        .map(function (raw) { return mapItem(raw, rail.type, rail.tag); })
                        .filter(Boolean);
                })
                .catch(function () { return []; });
        }));

        var out = [];
        var seen = Object.create(null);
        batches.forEach(function (list) {
            list.forEach(function (item) {
                var k = item.type + ':' + item.title.toLowerCase();
                if (seen[k]) return;
                seen[k] = true;
                out.push(item);
            });
        });
        return out;
    }

    /* ------------------------ live search ---------------------- */

    async function searchMulti(query, page) {
        var data = await get('/search/multi', {
            query: query,
            page: page || 1,
            include_adult: false
        }, TTL.search);
        return (data.results || [])
            .map(function (raw) { return mapItem(raw, null, null); })
            .filter(Boolean);
    }

    /* ------------------ TV show / season data ------------------ */

    async function getTvShow(tmdbId) {
        return get('/tv/' + encodeURIComponent(tmdbId),
            { append_to_response: 'external_ids' }, TTL.detail);
    }

    async function getTvSeason(tmdbId, season) {
        var data = await get('/tv/' + encodeURIComponent(tmdbId) +
            '/season/' + encodeURIComponent(season), {}, TTL.detail);
        return (data.episodes || [])
            .filter(function (ep) { return ep && ep.episode_number > 0; })
            .map(function (ep) {
                return {
                    season: ep.season_number || Number(season) || 1,
                    number: ep.episode_number,
                    name: ep.name || 'Episode ' + ep.episode_number,
                    summary: (ep.overview || 'HD Stream Ready').slice(0, 160),
                    runtime: ep.runtime || 45,
                    still: ep.still_path ? posterUrl(ep.still_path, 'w92') : '',
                    embedId: null
                };
            });
    }

    /* ------------- IMDb resolution (Family Engine keys) --------- */

    async function resolveImdbId(id, type) {
        var base = String(id == null ? '' : id).trim();
        if (!base) return null;
        if (/^tt\d+$/i.test(base)) return base.toLowerCase();
        if (!isReady() || !isTmdbId(base)) return null;
        try {
            if ((type || 'movie') === 'tv') {
                var show = await getTvShow(base);
                var imdbTv = show && show.external_ids && show.external_ids.imdb_id;
                if (imdbTv) return imdbTv;
            } else {
                var movie = await get('/movie/' + base + '/external_ids', {}, TTL.meta);
                var imdbMv = movie && movie.imdb_id;
                if (imdbMv) return imdbMv;
            }
        } catch (e) { return null; }
        return null;
    }

    return {
        configure: configure,
        isReady: isReady,
        isTmdbId: isTmdbId,
        posterUrl: posterUrl,
        mapItem: mapItem,
        searchMulti: searchMulti,
        bootstrapRails: bootstrapRails,
        getTvShow: getTvShow,
        getTvSeason: getTvSeason,
        resolveImdbId: resolveImdbId,
        clearCache: clearCache,
        TTL: TTL
    };
});
