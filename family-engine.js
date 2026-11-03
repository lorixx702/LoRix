/**
 * LoRix Family Engine — front-end content filtering & censorship module.
 *
 * Real playback clock, three paths:
 *   1. native <video> in the page           -> video.currentTime
 *   2. same-origin embed iframe (proxied)   -> inner <video>.currentTime
 *   3. cross-origin embed (cooperating)     -> lorix-embed postMessage time feed
 *
 * Policy per category: nudity/gore SKIP the range, profanity MUTES audio.
 * Keys: "tt0816692" (movie) | "tt0944947:s01e06" (episode -> show fallback).
 *
 * Embed bridge protocol:
 *   embed page  -> parent: { source:'lorix-embed', type:'time', time, duration }
 *   parent      -> embed: { source:'lorix-family', action:'seek', time }
 *   parent      -> embed: { source:'lorix-family', action:'muted', value }
 *   embed page  -> parent: { source:'lorix-embed', type:'cue', text }
 */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) {
        root.LoRixFamily = api;
        root.familyEngineDatabase = api.familyEngineDatabase;
        root.familyEngineLexicon = api.familyEngineLexicon;
    }
})(typeof window !== 'undefined' ? window : this, function () {
    'use strict';

    /* =====================================================================
     * 1. TIMESTAMP DATABASE — start/end in seconds, per category
     * ===================================================================== */
    const familyEngineDatabase = {

        /* ---- demo entry: matches the bundled sample stream (~596s) ---- */
        "tt0000001": { // LoRix demo reel
            nudity: [
                { start: 8, end: 16 },
                { start: 120, end: 132 }
            ],
            gore: [
                { start: 40, end: 52 },
                { start: 300, end: 312 }
            ],
            profanity: [
                { start: 20, end: 25 },
                { start: 70, end: 76 }
            ]
        },

        /* ---- movies ---- */
        "tt0816692": { // Interstellar
            nudity: [
                { start: 1205, end: 1240 },
                { start: 3410, end: 3450 }
            ],
            gore: [
                { start: 5120, end: 5155 }
            ],
            profanity: [
                { start: 300, end: 305 },
                { start: 1540, end: 1544 }
            ]
        },
        "tt0468569": { // The Dark Knight
            gore: [
                { start: 4380, end: 4412 },
                { start: 6615, end: 6640 }
            ],
            profanity: [
                { start: 1875, end: 1879 },
                { start: 5290, end: 5294 }
            ]
        },
        "tt1375666": { // Inception
            gore: [
                { start: 7480, end: 7505 }
            ],
            profanity: [
                { start: 2140, end: 2144 },
                { start: 6010, end: 6014 }
            ]
        },
        "tt0120338": { // Titanic
            nudity: [
                { start: 4320, end: 4375 }
            ],
            profanity: [
                { start: 5100, end: 5104 }
            ]
        },
        "tt1431045": { // Deadpool
            nudity: [
                { start: 320, end: 360 },
                { start: 4050, end: 4085 }
            ],
            gore: [
                { start: 1150, end: 1185 },
                { start: 4620, end: 4655 },
                { start: 5900, end: 5935 }
            ],
            profanity: [
                { start: 95, end: 99 },
                { start: 2410, end: 2416 },
                { start: 6010, end: 6015 }
            ]
        },
        "tt6263850": { // Deadpool & Wolverine
            nudity: [
                { start: 420, end: 455 }
            ],
            gore: [
                { start: 900, end: 935 },
                { start: 5400, end: 5440 }
            ],
            profanity: [
                { start: 60, end: 66 },
                { start: 3200, end: 3207 }
            ]
        },
        "tt2911666": { // John Wick
            gore: [
                { start: 3600, end: 3640 },
                { start: 5400, end: 5430 }
            ],
            profanity: [
                { start: 2100, end: 2104 }
            ]
        },
        "tt1392190": { // Mad Max: Fury Road
            gore: [
                { start: 3900, end: 3935 },
                { start: 6300, end: 6330 }
            ],
            profanity: [
                { start: 1500, end: 1504 }
            ]
        },
        "tt0137523": { // Fight Club
            nudity: [
                { start: 4800, end: 4840 }
            ],
            gore: [
                { start: 3900, end: 3935 },
                { start: 7300, end: 7340 }
            ],
            profanity: [
                { start: 600, end: 604 },
                { start: 5100, end: 5106 }
            ]
        },
        "tt0110912": { // Pulp Fiction
            gore: [
                { start: 2700, end: 2735 },
                { start: 7200, end: 7230 }
            ],
            profanity: [
                { start: 450, end: 456 },
                { start: 6100, end: 6105 }
            ]
        },
        "tt7286456": { // Joker
            gore: [
                { start: 4500, end: 4530 },
                { start: 6900, end: 6930 }
            ],
            profanity: [
                { start: 1200, end: 1204 }
            ]
        },
        "tt4154756": { // Avengers: Endgame
            gore: [
                { start: 9600, end: 9630 }
            ],
            profanity: [
                { start: 3000, end: 3004 }
            ]
        },
        "tt0499549": { // Avatar
            gore: [
                { start: 6300, end: 6330 },
                { start: 8400, end: 8430 }
            ],
            profanity: [
                { start: 4200, end: 4204 }
            ]
        },
        "tt15239678": { // Dune: Part Two
            gore: [
                { start: 4500, end: 4535 },
                { start: 8100, end: 8130 }
            ],
            profanity: [
                { start: 2200, end: 2204 }
            ]
        },

        /* ---- tv shows: show-level + episode-level keys ---- */
        "tt0944947": { // Game of Thrones (show level)
            profanity: [
                { start: 1400, end: 1404 }
            ]
        },
        "tt0944947:s01e06": { // Game of Thrones — S01E06 The Golden Crown
            nudity: [
                { start: 1650, end: 1700 }
            ],
            profanity: [
                { start: 2800, end: 2804 }
            ]
        },
        "tt0944947:s01e09": { // Game of Thrones — S01E09 Baelor
            gore: [
                { start: 2650, end: 2690 }
            ]
        },
        "tt0903747": { // Breaking Bad (show level)
            profanity: [
                { start: 1100, end: 1104 }
            ]
        },
        "tt0903747:s05e14": { // Breaking Bad — S05E14 Ozymandias
            gore: [
                { start: 1800, end: 1830 }
            ],
            profanity: [
                { start: 2400, end: 2405 }
            ]
        },
        "tt4574334": { // Stranger Things (show level)
            gore: [
                { start: 1900, end: 1935 }
            ],
            profanity: [
                { start: 1600, end: 1604 }
            ]
        },
        "tt7632524": { // The Boys (show level)
            nudity: [
                { start: 1500, end: 1535 }
            ],
            gore: [
                { start: 900, end: 935 },
                { start: 2100, end: 2140 }
            ],
            profanity: [
                { start: 400, end: 406 }
            ]
        },
        "tt1190634": { // The Boys — legacy alias from v1 dataset
            nudity: [
                { start: 1500, end: 1535 }
            ],
            gore: [
                { start: 900, end: 935 },
                { start: 2100, end: 2140 }
            ],
            profanity: [
                { start: 400, end: 406 }
            ]
        },
        "tt5180504": { // The Witcher (show level)
            nudity: [
                { start: 800, end: 845 }
            ],
            gore: [
                { start: 2200, end: 2235 }
            ],
            profanity: [
                { start: 1700, end: 1705 }
            ]
        }
    };

    /* =====================================================================
     * 2. KEYWORD RULES — profanity & slur lexicon (caption/text scanning)
     * ===================================================================== */
    const familyEngineLexicon = {
        profanity: [
            'fuck', 'fucking', 'fucked', 'fucker', 'motherfucker', 'shit', 'shitty',
            'bullshit', 'bitch', 'bastard', 'asshole', 'dickhead', 'dick', 'cock',
            'pussy', 'whore', 'slut', 'damn', 'dammit', 'goddamn', 'piss', 'pissed',
            'crap', 'arse', 'wanker', 'bollocks', 'prick', 'twat', 'douche',
            'jackass', 'dumbass', 'handjob', 'blowjob', 'cunt', 'tosser',
            'bugger', 'douchebag', 'dumbfuck', 'goddammit'
        ],
        slurs: [
            'nigger', 'nigga', 'faggot', 'retard', 'retarded', 'tranny', 'dyke',
            'spic', 'kike', 'wetback', 'cripple', 'chink', 'paki', 'coon',
            'gook', 'beaner'
        ]
    };

    /* =====================================================================
     * 3. CENSORSHIP POLICY — one object, retune freely
     * ===================================================================== */
    const FAMILY_POLICY = { nudity: 'skip', gore: 'skip', profanity: 'mute' };

    /* ---------------------------- helpers ------------------------------ */

    function pad2(n) {
        return String(n == null ? '' : n).trim().padStart(2, '0');
    }

    function flattenRanges(entry) {
        var out = [];
        ['nudity', 'gore', 'profanity'].forEach(function (cat) {
            (entry[cat] || []).forEach(function (r) {
                var s = Number(r.start);
                var e = Number(r.end);
                if (isFinite(s) && isFinite(e) && e > s) {
                    out.push({ category: cat, start: s, end: e });
                }
            });
        });
        out.sort(function (a, b) { return a.start - b.start; });
        return out;
    }

    function buildLexiconRegex() {
        var words = familyEngineLexicon.profanity.concat(familyEngineLexicon.slurs);
        var body = words.map(function (w) {
            return w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }).join('|');
        return new RegExp('(?:^|[^a-z0-9])(' + body + ')(?:[^a-z0-9]|$)', 'i');
    }

    /* --------------------------- adapters ------------------------------ */

    function createVideoAdapter(video) {
        return {
            kind: 'native',
            element: video,
            refresh: function () {},
            getTime: function () { return video.currentTime; },
            getDuration: function () { return video.duration; },
            isReady: function () { return video.readyState > 0; },
            seek: function (t) { video.currentTime = t; },
            setMuted: function (b) { video.muted = !!b; },
            getMuted: function () { return video.muted; },
            getTextTracks: function () { return video.textTracks || null; }
        };
    }

    // Same-origin walk: iframe -> its document -> nested iframes -> <video>.
    // Cross-origin boundaries are swallowed and treated as "not ours".
    function probeVideoInDoc(doc, depth) {
        if (!doc || depth > 3) return null;
        var v = null;
        try { v = doc.querySelector('video'); } catch (e) { return null; }
        if (v) return v;
        var frames = null;
        try { frames = doc.querySelectorAll('iframe'); } catch (e) { return null; }
        for (var i = 0; i < frames.length; i++) {
            try {
                var found = probeVideoInDoc(frames[i].contentDocument, depth + 1);
                if (found) return found;
            } catch (e) { /* cross-origin boundary */ }
        }
        return null;
    }

    function createEmbedAdapter(iframe) {
        var feed = { time: 0, duration: 0, muted: false, got: false, cue: '' };
        var bound = null;

        window.addEventListener('message', function (ev) {
            if (ev.source !== iframe.contentWindow) return;
            var d = ev.data;
            if (!d || d.source !== 'lorix-embed') return;
            if (d.type === 'time') {
                feed.time = Number(d.time) || 0;
                var dur = Number(d.duration);
                if (isFinite(dur) && dur > 0) feed.duration = dur;
                feed.got = true;
            } else if (d.type === 'muted') {
                feed.muted = !!d.value;
            } else if (d.type === 'cue') {
                feed.cue = String(d.text || '');
            }
        });

        function post(msg) {
            try {
                msg.source = 'lorix-family';
                iframe.contentWindow.postMessage(msg, '*');
            } catch (e) { /* detached frame */ }
        }

        return {
            kind: 'embed',
            element: iframe,
            refresh: function () {
                if (bound) {
                    if (bound.isConnected === false) bound = null; // embed navigated away
                    else return;
                }
                var v = null;
                try { v = probeVideoInDoc(iframe.contentDocument, 0); } catch (e) { v = null; }
                if (v) {
                    bound = v;
                    this.kind = 'embed-native';
                } else {
                    this.kind = 'embed';
                }
            },
            getTime: function () { return bound ? bound.currentTime : feed.time; },
            getDuration: function () { return bound ? (bound.duration || 0) : feed.duration; },
            isReady: function () { return bound ? bound.readyState > 0 : feed.got; },
            seek: function (t) {
                if (bound) { bound.currentTime = t; return; }
                post({ action: 'seek', time: t });
            },
            setMuted: function (b) {
                if (bound) { bound.muted = !!b; return; }
                feed.muted = !!b;
                post({ action: 'muted', value: !!b });
            },
            getMuted: function () { return bound ? bound.muted : feed.muted; },
            getTextTracks: function () { return bound && bound.textTracks ? bound.textTracks : null; },
            getCueText: function () { return feed.cue || ''; },
            getMode: function () {
                if (bound) return 'embed-native';
                return feed.got ? 'embed-bridge' : 'embed-idle';
            }
        };
    }

    /* =====================================================================
     * 4. ENGINE — tick loop, mute/skip enforcement, state events
     * ===================================================================== */
    class FamilyEngine {
        constructor(media, options) {
            options = options || {};
            if (!media) throw new TypeError('FamilyEngine: media element or iframe required');

            if (typeof HTMLMediaElement !== 'undefined' && media instanceof HTMLMediaElement) {
                this.adapter = createVideoAdapter(media);
            } else if (media.tagName === 'IFRAME') {
                this.adapter = createEmbedAdapter(media);
            } else if (typeof media.getTime === 'function') {
                this.adapter = media; // custom adapter
            } else {
                throw new TypeError('FamilyEngine: unsupported media source');
            }

            this.policy = Object.assign({}, FAMILY_POLICY, options.policy || {});
            this.tickMs = options.tickMs || 250;
            this.captionScan = options.captionScan !== false;
            this.onState = typeof options.onState === 'function' ? options.onState : function () {};

            this.enabled = false;
            this.id = null;
            this.key = null;
            this.hasId = false;
            this._ranges = [];
            this._active = null;
            this._engineMuted = false;
            this._savedMuted = false;
            this._lastSkipAt = 0;
            this._timer = null;
            this._lexiconRe = buildLexiconRegex();
            this.autoTrack = options.autoTrack !== false;
            this._flippedTracks = [];

            this._tick = this._tick.bind(this);
            this._release = this._release.bind(this);

            if (this.adapter.element && this.adapter.kind === 'native') {
                var el = this.adapter.element;
                el.addEventListener('seeked', this._tick);
                el.addEventListener('loadedmetadata', this._tick);
                el.addEventListener('emptied', this._release);
                this._boundEl = el;
            }
        }

        /** Load a title: { id:'tt0816692', season:1, episode:6 } */
        setMedia(spec) {
            spec = spec || {};
            var base = String(spec.id || spec.imdbId || '').trim();
            this.id = base || null;
            this.hasId = !!base;

            var key = null;
            if (base && spec.season != null && spec.episode != null &&
                String(spec.season).length && String(spec.episode).length) {
                var epKey = base + ':s' + pad2(spec.season) + 'e' + pad2(spec.episode);
                if (familyEngineDatabase[epKey]) key = epKey;
            }
            if (!key && base && familyEngineDatabase[base]) key = base;

            this.key = key;
            this._ranges = key ? flattenRanges(familyEngineDatabase[key]) : [];
            this._release();
            this._emit('media');
            return key;
        }

        enable() {
            if (this.enabled) return this;
            this.enabled = true;
            this._emit('toggle');
            this._timer = setInterval(this._tick, this.tickMs);
            this._tick();
            return this;
        }

        disable() {
            if (!this.enabled) return this;
            this.enabled = false;
            if (this._timer) { clearInterval(this._timer); this._timer = null; }
            this._release();
            this._restoreTracks();
            this._emit('toggle');
            return this;
        }

        getState() {
            var now = this.adapter.getTime();
            return {
                enabled: this.enabled,
                id: this.id,
                key: this.key,
                hasId: this.hasId,
                ranges: this._ranges.length,
                mode: this.adapter.getMode ? this.adapter.getMode() : this.adapter.kind,
                now: now,
                active: this._active ? {
                    category: this._active.category,
                    start: this._active.start,
                    end: this._active.end,
                    source: this._active.caption ? 'subtitle' : 'timestamp',
                    remaining: Math.max(0, Math.ceil(this._active.end - now))
                } : null
            };
        }

        destroy() {
            this.disable();
            if (this._boundEl) {
                this._boundEl.removeEventListener('seeked', this._tick);
                this._boundEl.removeEventListener('loadedmetadata', this._tick);
                this._boundEl.removeEventListener('emptied', this._release);
                this._boundEl = null;
            }
        }

        /* --------------------------- internals -------------------------- */

        _tick() {
            if (!this.enabled) return;
            if (this.adapter.refresh) this.adapter.refresh();

            var t = this.adapter.getTime();
            var hit = null;

            if (this._ranges.length && isFinite(t)) {
                for (var i = 0; i < this._ranges.length; i++) {
                    var r = this._ranges[i];
                    if (t >= r.start && t < r.end) { hit = r; break; }
                }
            }
            if (!hit && this.captionScan) hit = this._scanCaptions(t);

            if (!hit) {
                if (this._active) this._release();
                return;
            }

            var same = this._active &&
                this._active.category === hit.category &&
                (hit.caption
                    ? this._active.caption === true
                    : (this._active.start === hit.start && this._active.end === hit.end));

            if (same) this._hold(hit);
            else this._engage(hit);
        }

        // Still inside the active range on a repeat tick: keep enforcing.
        _hold(hit) {
            var policy = this.policy[hit.category] || 'mute';
            if (policy === 'skip') {
                var now = Date.now();
                if (now - this._lastSkipAt > 800) { // failed-seek retry guard
                    this._lastSkipAt = now;
                    this._seekPast(hit);
                }
            } else if (!this.adapter.getMuted()) {
                this.adapter.setMuted(true);
            }
        }

        _engage(hit) {
            var policy = this.policy[hit.category] || 'mute';

            if (policy === 'skip') {
                if (!this.adapter.isReady()) return; // metadata not ready: retry next tick
                if (!this._seekPast(hit)) return;
                this._active = hit;
                this._emit('engage', {
                    policy: 'skip', category: hit.category,
                    start: hit.start, end: hit.end,
                    source: hit.caption ? 'subtitle' : 'timestamp'
                });
                return;
            }

            // mute policy
            if (!this._engineMuted) {
                this._savedMuted = this.adapter.getMuted();
                this._engineMuted = true;
            }
            this.adapter.setMuted(true);
            this._active = hit;
            this._emit('engage', {
                policy: 'mute', category: hit.category,
                start: hit.start, end: hit.end,
                source: hit.caption ? 'subtitle' : 'timestamp'
            });
        }

        _seekPast(hit) {
            var dur = this.adapter.getDuration();
            var target = hit.end + 0.05;
            if (isFinite(dur) && dur > 0 && target > dur) {
                target = Math.max(hit.start, dur - 0.1);
            }
            try { this.adapter.seek(target); return true; }
            catch (e) { return false; }
        }

        _release() {
            var had = !!this._active;
            if (this._engineMuted) {
                try { this.adapter.setMuted(this._savedMuted); } catch (e) {}
                this._engineMuted = false;
            }
            if (had) {
                this._active = null;
                this._emit('clear');
            }
        }

        _restoreTracks() {
            for (var i = 0; i < this._flippedTracks.length; i++) {
                try { this._flippedTracks[i].mode = 'disabled'; } catch (e) {}
            }
            this._flippedTracks = [];
        }

        // Keyword rules: subtitle cues scanned live — the bulk path across the
        // massive catalog. Mutes for the duration of the offensive sentence.
        _scanCaptions(t) {
            if (!isFinite(t)) return null;

            // Bridge mode: cooperating embeds push their active cue text.
            if (this.adapter.getCueText) {
                var bridgeCue = this.adapter.getCueText();
                if (bridgeCue && this._lexiconRe.test(String(bridgeCue))) {
                    return { category: 'profanity', start: t, end: t + 0.5, caption: true, source: 'subtitle' };
                }
            }

            var tracks = this.adapter.getTextTracks ? this.adapter.getTextTracks() : null;
            if (!tracks || !tracks.length) return null;
            for (var i = 0; i < tracks.length; i++) {
                var tr = tracks[i];
                // Auto-arm disabled tracks: cues load for scanning, never displayed.
                if (tr.mode === 'disabled' && this.autoTrack) {
                    try {
                        tr.mode = 'hidden';
                        if (this._flippedTracks.indexOf(tr) === -1) this._flippedTracks.push(tr);
                    } catch (e) { continue; }
                }
                if (tr.mode !== 'showing' && tr.mode !== 'hidden') continue;
                var cues = tr.activeCues;
                if (!cues || !cues.length) continue;
                for (var j = 0; j < cues.length; j++) {
                    var text = String(cues[j].text || '');
                    if (this._lexiconRe.test(text)) {
                        return { category: 'profanity', start: t, end: t + 0.5, caption: true, source: 'subtitle' };
                    }
                }
            }
            return null;
        }

        _emit(type, detail) {
            this.onState({
                type: type,
                enabled: this.enabled,
                id: this.id,
                key: this.key,
                hasId: this.hasId,
                mode: this.adapter.getMode ? this.adapter.getMode() : this.adapter.kind,
                active: this._active ? {
                    category: this._active.category,
                    start: this._active.start,
                    end: this._active.end
                } : null,
                detail: detail || null,
                state: this.getState()
            });
        }
    }

    return {
        FamilyEngine: FamilyEngine,
        familyEngineDatabase: familyEngineDatabase,
        familyEngineLexicon: familyEngineLexicon,
        FAMILY_POLICY: FAMILY_POLICY,
        createVideoAdapter: createVideoAdapter,
        createEmbedAdapter: createEmbedAdapter
    };
});