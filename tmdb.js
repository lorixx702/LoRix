/**
 * LoRix TMDB Live Catalog — dynamic global fetcher (movies-first, 70k+ pool)
 *
 * Cinema-focused scaling: a ring of paginated movie discovery sources
 * (Hollywood blockbusters, Anime JA, Korean, Turkish, Arabic + era and
 * genre slices) is drained round-robin by a background expansion loop so
 * the local pool grows toward 70,000-100,000+ movies for instant text
 * and genre filtering. TV shows ride along as a lean bootstrap layer so
 * movies keep equal-or-greater representation everywhere.
 *
 * KEY: TMDB_API_KEY below, or LoRixTMDB.configure({ apiKey }) — which
 * persists to localStorage['lorix.tmdb_key']. Without a key every call
 * degrades to [] and the app runs on its bundled catalog.
 *
 * API:
 *   bootstrapRails()                  -> Promise<items[]>  boot: page-1 ring + featured pages + TV
 *   expandMovies({ pages })           -> Promise<items[]>  next round-robin discovery pages
 *   startBackgroundExpansion({ onBatch }) / stopBackgroundExpansion()
 *   poolStats()                       -> { pool, movies, tv, target, done }
 *   searchMulti(query, page)          -> Promise<items[]>  multi p1+p2 + /search/movie, movies first
 *   getTvShow(id) / getTvSeason(id, n) / resolveImdbId(id, type)
 */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.LoRixTMDB = api;
})(typeof window !== 'undefined' ? window : this, function () {
    'use strict';

    /* ======================= CONFIG SLOT ======================= */
    var TMDB_API_KEY = '310fba77e5f2c280f32d821b8f8f08ec'; // <<< TMDB v3 API key
    /* ========================================================== */

    var BASE = 'https://api.themoviedb.org/3';
    var IMG = 'https://image.tmdb.org/t/p';
    var CACHE_NS = 'lorix.tmdb.';
    var TMDB_MAX_PAGE = 500; // hard page ceiling on TMDB list/discover endpoints
    var TTL = {
        bootstrap: 12 * 60 * 60 * 1000, // page-1 rails: 12h (localStorage)
        live: 10 * 60 * 1000,           // expansion pages: memory only
        search: 5 * 60 * 1000,          // live queries: 5min
        detail: 30 * 60 * 1000,         // show/season: 30min
        meta: 24 * 60 * 60 * 1000       // imdb lookups: 24h
    };

    /* --------------------- tuning knobs ----------------------- */

    var settings = {
        maxPool: 75000,            // hard cap on pooled titles (70k-100k target)
        bootstrapMoviePages: 4,    // pages per featured movie source at boot
        expandBatchPages: 12,      // pages pulled per expansion round
        expandIntervalMs: 2000,    // background driver cadence
        fetchConcurrency: 6        // parallel requests inside one round
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
        if (!opts) return isReady();
        if (opts.apiKey) {
            apiKey = String(opts.apiKey).trim();
            try { localStorage.setItem('lorix.tmdb_key', apiKey); } catch (e) {}
            mem = Object.create(null);
        }
        ['maxPool', 'bootstrapMoviePages', 'expandBatchPages', 'expandIntervalMs', 'fetchConcurrency']
            .forEach(function (k) {
                if (opts[k] != null && isFinite(Number(opts[k])) && Number(opts[k]) > 0) {
                    settings[k] = Number(opts[k]);
                }
            });
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

    function cachePut(url, data, ttl, persist) {
        var entry = { at: Date.now(), data: data };
        mem[url] = entry;
        if (persist === false) return; // expansion pages stay in memory (localStorage quota)
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

    async function get(path, params, ttl, persist) {
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
            cachePut(url, data, limit, persist);
            return data;
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    // Ordered map over a list with a hard concurrency ceiling — keeps the
    // expansion rounds well inside TMDB's request-rate budget.
    function mapConcurrent(arr, limit, fn) {
        var results = new Array(arr.length);
        var next = 0;
        function worker() {
            if (next >= arr.length) return Promise.resolve();
            var idx = next++;
            return Promise.resolve()
                .then(function () { return fn(arr[idx], idx); })
                .then(function (r) { results[idx] = r; })
                .then(worker);
        }
        var workers = [];
        for (var w = 0; w < Math.min(limit, arr.length); w++) workers.push(worker());
        return Promise.all(workers).then(function () { return results; });
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

    /* =====================================================================
     * MOVIE SOURCE RING — the 70k+ engine.
     * Every source carries its own page cursor, learned total-page ceiling
     * and per-source cap. Expansion drains the ring round-robin so each
     * pillar (Hollywood / Anime / Korean / Turkish / Arabic / eras /
     * genres) grows at an equal rate instead of favoring one lane.
     * ===================================================================== */

    function buildMovieSources() {
        var list = [];
        var add = function (s) {
            s.path = s.path || '/discover/movie';
            s.params = s.params || {};
            s.page = 1;
            s.totalPages = null;
            s.exhausted = false;
            list.push(s);
        };

        /* -------- Hollywood / global blockbusters -------- */
        add({ id: 'trending-movies', path: '/trending/movie/week', cap: 12, featured: true });
        add({ id: 'popular-movies', path: '/movie/popular', cap: 500, featured: true });
        add({ id: 'top-rated-movies', path: '/movie/top_rated', cap: 400, featured: true });
        add({ id: 'discover-popular', params: { sort_by: 'popularity.desc' }, cap: 500, featured: true });
        add({ id: 'discover-acclaimed', params: { sort_by: 'vote_average.desc', 'vote_count.gte': 800 }, cap: 300, featured: true });
        add({ id: 'now-playing', path: '/movie/now_playing', cap: 60 });
        add({ id: 'upcoming', path: '/movie/upcoming', cap: 60 });

        /* -------- current-year hits (feeds the 2024-2026 chip) -------- */
        [2026, 2025, 2024].forEach(function (y) {
            add({ id: 'year-' + y, params: { primary_release_year: y, sort_by: 'popularity.desc' }, cap: 250 });
        });

        /* -------- era slices (feeds All Eras / 2020-2023 / 2010-2019 / 2000-2009) -------- */
        add({ id: 'era-2020-2023', params: { 'primary_release_date.gte': '2020-01-01', 'primary_release_date.lte': '2023-12-31', sort_by: 'popularity.desc' }, cap: 500 });
        add({ id: 'era-2010-2019', params: { 'primary_release_date.gte': '2010-01-01', 'primary_release_date.lte': '2019-12-31', sort_by: 'popularity.desc' }, cap: 500 });
        add({ id: 'era-2000-2009', params: { 'primary_release_date.gte': '2000-01-01', 'primary_release_date.lte': '2009-12-31', sort_by: 'popularity.desc' }, cap: 400 });
        add({ id: 'era-1990-1999', params: { 'primary_release_date.gte': '1990-01-01', 'primary_release_date.lte': '1999-12-31', sort_by: 'popularity.desc' }, cap: 300 });
        add({ id: 'era-classics', params: { 'primary_release_date.lte': '1989-12-31', sort_by: 'popularity.desc' }, cap: 300 });

        /* -------- global cinema pillars (equal round-robin share) -------- */
        add({ id: 'anime-movies', params: { with_genres: 16, with_original_language: 'ja', sort_by: 'popularity.desc' }, cap: 250, featured: true, tag: 'Anime' });
        add({ id: 'korean-films', params: { with_original_language: 'ko', sort_by: 'popularity.desc' }, cap: 250, featured: true, tag: 'Korean' });
        add({ id: 'turkish-films', params: { with_original_language: 'tr', sort_by: 'popularity.desc' }, cap: 250, featured: true, tag: 'Turkish' });
        add({ id: 'arabic-films', params: { with_original_language: 'ar', sort_by: 'popularity.desc' }, cap: 250, featured: true, tag: 'Arabic' });
        add({ id: 'hindi-films', params: { with_original_language: 'hi', sort_by: 'popularity.desc' }, cap: 150, tag: 'Bollywood' });
        add({ id: 'chinese-films', params: { with_original_language: 'zh', sort_by: 'popularity.desc' }, cap: 150, tag: 'Chinese' });
        add({ id: 'french-films', params: { with_original_language: 'fr', sort_by: 'popularity.desc' }, cap: 150, tag: 'French' });
        add({ id: 'spanish-films', params: { with_original_language: 'es', sort_by: 'popularity.desc' }, cap: 150, tag: 'Spanish' });

        /* -------- genre depth (genre text filtering) -------- */
        [
            { key: 'action', g: 28 }, { key: 'comedy', g: 35 }, { key: 'drama', g: 18 },
            { key: 'horror', g: 27 }, { key: 'thriller', g: 53 }, { key: 'scifi', g: 878 },
            { key: 'romance', g: 10749 }, { key: 'animation', g: 16 }
        ].forEach(function (x) {
            add({ id: 'genre-' + x.key, params: { with_genres: x.g, sort_by: 'popularity.desc' }, cap: 120 });
        });

        return list;
    }

    // Lean TV layer: bootstrap-only, one page each — movies keep the
    // equal-or-greater share of the catalog.
    var TV_SOURCES = [
        { path: '/trending/tv/week' },
        { path: '/tv/popular' },
        { path: '/tv/top_rated' },
        { path: '/discover/tv', params: { with_genres: 16, sort_by: 'popularity.desc' }, tag: 'Anime' },
        { path: '/discover/tv', params: { with_origin_country: 'KR', sort_by: 'popularity.desc' }, tag: 'K-Drama' },
        { path: '/discover/tv', params: { with_origin_country: 'TR', sort_by: 'popularity.desc' }, tag: 'Turkish' },
        { path: '/discover/tv', params: { with_original_language: 'ar', sort_by: 'popularity.desc' }, tag: 'Arabic' }
    ];

    var sources = null;         // movie source ring (page cursors live here)
    var ringCursor = 0;         // round-robin position across the ring
    var expanding = false;      // re-entry guard for expandMovies()
    var bgTimer = null;         // background driver handle
    var poolListener = null;    // onBatch(items, stats) callback

    // Global dedupe across bootstrap + every expansion round.
    var seenIds = Object.create(null);
    var poolTotal = 0;
    var poolMovies = 0;
    var poolTv = 0;

    function ensureSources() {
        if (!sources) sources = buildMovieSources();
        return sources;
    }

    function remember(items) {
        var fresh = [];
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            if (!it || seenIds[it.id]) continue;
            seenIds[it.id] = true;
            poolTotal++;
            if (it.type === 'movie') poolMovies++;
            else poolTv++;
            fresh.push(it);
        }
        return fresh;
    }

    function sourceHasMore(s) {
        if (s.exhausted) return false;
        if (s.totalPages != null && s.page > s.totalPages) { s.exhausted = true; return false; }
        if (s.page > Math.min(s.cap || TMDB_MAX_PAGE, TMDB_MAX_PAGE)) { s.exhausted = true; return false; }
        return true;
    }

    function allSourcesExhausted() {
        if (!sources) return true;
        for (var i = 0; i < sources.length; i++) {
            if (sourceHasMore(sources[i])) return false;
        }
        return true;
    }

    function poolStats() {
        return {
            pool: poolTotal,
            movies: poolMovies,
            tv: poolTv,
            target: settings.maxPool,
            ready: isReady(),
            expanding: expanding,
            done: !isReady() || poolTotal >= settings.maxPool || allSourcesExhausted()
        };
    }

    /* ------------------- source page fetching ------------------ */

    async function fetchSourcePage(src, page) {
        var params = Object.assign({}, src.params, { page: page });
        // Only page-1 rails persist to localStorage (quota); deeper pages are
        // session-memory — the pool itself would never fit on disk anyway.
        var persist = page === 1;
        var data = await get(src.path, params, page === 1 ? TTL.bootstrap : TTL.live, persist);

        if (data && Array.isArray(data.results)) {
            if (data.results.length === 0) src.exhausted = true; // confirmed-empty page
            if (isFinite(data.total_pages)) {
                src.totalPages = Math.min(Number(data.total_pages), src.cap || TMDB_MAX_PAGE, TMDB_MAX_PAGE);
            }
        }
        return (data && Array.isArray(data.results) ? data.results : [])
            .map(function (raw) { return mapItem(raw, src.type || 'movie', src.tag); })
            .filter(Boolean);
    }

    /* ------------------------ bootstrap ------------------------ */

    async function bootstrapRails() {
        if (!isReady()) return [];
        var srcs = ensureSources();

        // Wave 1 — page 1 across the whole ring: every movie pillar and era
        // represented equally from the very first paint.
        var wave1 = await mapConcurrent(srcs, settings.fetchConcurrency, function (s) {
            return fetchSourcePage(s, 1).then(
                function (list) { if (2 > s.page) s.page = 2; return list; },
                function () { if (1 < s.page) s.page = 1; return []; }
            );
        });

        // Wave 2 — extra pages for featured sources: multi-page discovery is
        // live from boot, not just after the first expansion round.
        var featuredJobs = [];
        srcs.forEach(function (s) {
            if (!s.featured) return;
            var ceiling = Math.min(settings.bootstrapMoviePages, s.totalPages || settings.bootstrapMoviePages);
            for (var p = 2; p <= ceiling; p++) featuredJobs.push({ src: s, page: p });
        });
        var wave2 = await mapConcurrent(featuredJobs, settings.fetchConcurrency, function (job) {
            return fetchSourcePage(job.src, job.page).then(
                function (list) { if (job.page + 1 > job.src.page) job.src.page = job.page + 1; return list; },
                function () { if (job.page < job.src.page) job.src.page = job.page; return []; }
            );
        });

        // Lean TV layer (bootstrap only).
        var tvLists = await mapConcurrent(TV_SOURCES, settings.fetchConcurrency, function (tv) {
            return get(tv.path, Object.assign({ page: 1 }, tv.params || {}), TTL.bootstrap, true)
                .then(function (data) {
                    return (data && data.results ? data.results : [])
                        .map(function (raw) { return mapItem(raw, 'tv', tv.tag); })
                        .filter(Boolean);
                })
                .catch(function () { return []; });
        });

        var fresh = [];
        wave1.concat(wave2).concat(tvLists).forEach(function (list) {
            fresh = fresh.concat(remember(list));
        });
        return fresh;
    }

    /* ----------------------- expansion loop --------------------- */

    async function expandMovies(options) {
        options = options || {};
        if (!isReady()) return [];
        var srcs = ensureSources();
        if (expanding) return [];              // re-entry guard
        if (poolTotal >= settings.maxPool) return [];

        expanding = true;
        try {
            var want = Math.max(1, Number(options.pages) || settings.expandBatchPages);
            var jobs = [];
            var guard = 0;
            // Round-robin: every pillar advances one page per lap so the
            // pool stays balanced instead of draining Hollywood first.
            while (jobs.length < want && guard < srcs.length * 3) {
                guard++;
                var s = srcs[ringCursor % srcs.length];
                ringCursor++;
                if (!sourceHasMore(s)) continue;
                jobs.push({ src: s, page: s.page });
                s.page++; // reserve the slot (rewound on fetch failure)
            }
            if (!jobs.length) return [];

            var lists = await mapConcurrent(jobs, settings.fetchConcurrency, function (job) {
                return fetchSourcePage(job.src, job.page).then(null, function () {
                    if (job.page < job.src.page) job.src.page = job.page; // retry next round
                    return [];
                });
            });

            var fresh = [];
            lists.forEach(function (list) { fresh = fresh.concat(remember(list)); });
            return fresh;
        } finally {
            expanding = false;
        }
    }

    /* ------------------- background driver ---------------------- */

    function startBackgroundExpansion(opts) {
        opts = opts || {};
        if (typeof opts.onBatch === 'function') poolListener = opts.onBatch;
        if (bgTimer) return true;
        if (!isReady()) return false;

        var interval = Math.max(500, Number(opts.intervalMs) || settings.expandIntervalMs);
        var batch = Math.max(1, Number(opts.batchPages) || settings.expandBatchPages);

        bgTimer = setInterval(function () {
            try {
                if (typeof document !== 'undefined' && document.hidden) return; // pause when hidden
                if (poolTotal >= settings.maxPool || allSourcesExhausted()) {
                    stopBackgroundExpansion();
                    if (poolListener) { try { poolListener([], poolStats()); } catch (e) {} }
                    return;
                }
                expandMovies({ pages: batch }).then(function (items) {
                    if (poolListener && items && items.length) {
                        try { poolListener(items, poolStats()); } catch (e) {}
                    }
                }).catch(function () {});
            } catch (e) { /* never let the driver throw into the page */ }
        }, interval);
        return true;
    }

    function stopBackgroundExpansion() {
        if (bgTimer) { clearInterval(bgTimer); bgTimer = null; }
        return true;
    }

    /* ------------------------ live search ----------------------- */

    // Optimized for the massive movie index: multi-search pages 1+2 plus a
    // dedicated /search/movie pass so obscure global titles surface even
    // when they rank below TV in the blended feed. Movies sort first.
    async function searchMulti(query, page) {
        var p = Number(page) || 1;
        var reqs = [
            { path: '/search/multi', params: { query: query, page: p, include_adult: false } },
            { path: '/search/multi', params: { query: query, page: p + 1, include_adult: false } },
            { path: '/search/movie', params: { query: query, page: p, include_adult: false } }
        ];
        var data = await mapConcurrent(reqs, 3, function (r) {
            return get(r.path, r.params, TTL.search).catch(function () { return null; });
        });

        var merged = [];
        var seen = Object.create(null);
        data.forEach(function (d) {
            (d && d.results ? d.results : []).forEach(function (raw) {
                var item = mapItem(raw, null, null);
                if (!item || seen[item.id]) return;
                seen[item.id] = true;
                merged.push(item);
            });
        });

        // Equal-or-greater movie representation: stable movies-first ordering
        // keeps each group's relevance intact.
        merged.sort(function (a, b) {
            return (a.type === b.type) ? 0 : (a.type === 'movie' ? -1 : 1);
        });
        return merged;
    }

    /* ------------------ TV show / season data ------------------- */

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
        expandMovies: expandMovies,
        startBackgroundExpansion: startBackgroundExpansion,
        stopBackgroundExpansion: stopBackgroundExpansion,
        poolStats: poolStats,
        getTvShow: getTvShow,
        getTvSeason: getTvSeason,
        resolveImdbId: resolveImdbId,
        clearCache: clearCache,
        settings: settings,
        TTL: TTL
    };
});
