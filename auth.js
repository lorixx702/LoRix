/**
 * LoRix Auth & License Gate — login gating + license key management.
 *
 * Blocks the catalog, the player and the admin console behind a login
 * screen until a valid account signs in; non-admin accounts additionally
 * need an active, unexpired license key (LORIX-XXXX-XXXX). Credentials
 * are stored salted+SHA-256 hashed in localStorage ('lorix.auth.users'),
 * keys in 'lorix.auth.keys', the session in 'lorix.auth.session'.
 *
 * First run seeds two accounts:
 *   admin / lorix2026  (role: admin, 10-year key)
 *   demo  / demo1234   (role: user,   30-day key)
 *
 * API:
 *   mountGate({ requireAdmin }) -> { mounted, ok, reason }   login overlay + page lock
 *   login(u, p)                -> { ok, error?, role?, user? }
 *   validate() / isAuthed() / isAdmin() / currentUser() / logout()
 *   listUsers() / listKeys() / stats()
 *   generateKey({ days, user }) / addUser({ username, password, days })
 *   renewKey(k) / extendKey(k) / revokeKey(k) / deleteKey(k)
 *   bindDpad(root)             -> detach()   TV remote focus navigation
 *   fmtDate(ts) / sha256(str)
 */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.LoRixAuth = api;
})(typeof window !== 'undefined' ? window : this, function () {
    'use strict';

    var K = {
        users: 'lorix.auth.users',
        keys: 'lorix.auth.keys',
        session: 'lorix.auth.session',
        lock: 'lorix.auth.lock',
        seeded: 'lorix.auth.seeded'
    };
    var DAY = 86400000;
    var SESSION_DAYS = 7;
    var LOCK_LIMIT = 5;          // failed attempts before cooldown
    var LOCK_MS = 60000;         // 60s lockout window
    var KEY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I/L/O/0/1

    /* ------------------------ storage -------------------------- */

    function read(key, fallback) {
        try {
            var v = localStorage.getItem(key);
            return v === null || v === undefined ? fallback : JSON.parse(v);
        } catch (e) { return fallback; }
    }
    function write(key, val) {
        try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
    }
    function del(key) {
        try { localStorage.removeItem(key); } catch (e) {}
    }
    function now() { return Date.now(); }
    function getUsers() { var u = read(K.users, null); return Array.isArray(u) ? u : []; }
    function getKeys() { var k = read(K.keys, null); return Array.isArray(k) ? k : []; }
    function saveUsers(u) { write(K.users, u); }
    function saveKeys(k) { write(K.keys, k); }

    /* --------------------- SHA-256 (pure JS) -------------------- */

    function sha256(input) {
        var ascii = utf8Binary(input);
        function rightRotate(value, amount) {
            return (value >>> amount) | (value << (32 - amount));
        }
        var mathPow = Math.pow;
        var maxWord = mathPow(2, 32);
        var result = '';
        var words = [];
        var asciiBitLength = ascii.length * 8;
        var hash = [];
        var k = [];
        var primeCounter = 0;
        var isComposite = {};
        for (var candidate = 2; primeCounter < 64; candidate++) {
            if (!isComposite[candidate]) {
                for (var i = 0; i < 313; i += candidate) { isComposite[i] = candidate; }
                hash[primeCounter] = (mathPow(candidate, 0.5) * maxWord) | 0;
                k[primeCounter++] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
            }
        }
        ascii += '\x80';
        while (ascii.length % 64 - 56) { ascii += '\x00'; }
        for (i = 0; i < ascii.length; i++) {
            var j = ascii.charCodeAt(i);
            if (j >> 8) return ''; // non-binary string: must be UTF-8 folded first
            words[i >> 2] |= j << ((3 - i) % 4) * 8;
        }
        words[words.length] = (asciiBitLength / maxWord) | 0;
        words[words.length] = asciiBitLength;
        var blockStart = 0;
        while (blockStart < words.length) {
            var w = words.slice(blockStart, blockStart += 16);
            var oldHash = hash.slice();
            var a = hash[0], e = hash[4];
            for (i = 0; i < 64; i++) {
                var w15 = w[i - 15];
                var w2 = w[i - 2];
                a = hash[0];
                e = hash[4];
                var temp1 = hash[7]
                    + (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25))
                    + ((e & hash[5]) ^ ((~e) & hash[6]))
                    + k[i]
                    + (w[i] = (i < 16) ? w[i] : (
                        w[i - 16]
                        + (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3))
                        + w[i - 7]
                        + (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10))
                    ) | 0);
                var temp2 = (rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22))
                    + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
                hash = [(temp1 + temp2) | 0].concat(hash);
                hash[4] = (hash[4] + temp1) | 0;
            }
            for (i = 0; i < 8; i++) {
                hash[i] = (hash[i] + oldHash[i]) | 0;
            }
        }
        for (i = 0; i < 8; i++) {
            for (j = 3; j + 1; j--) {
                var b = (hash[i] >> (j * 8)) & 255;
                result += ((b < 16) ? 0 : '') + b.toString(16);
            }
        }
        return result;
    }

    /** UTF-8 encode to a binary string (charCodes 0..255) — no unescape dependency. */
    function utf8Binary(str) {
        str = String(str);
        var out = '';
        for (var i = 0; i < str.length; i++) {
            var c = str.charCodeAt(i);
            if (c < 128) {
                out += String.fromCharCode(c);
            } else if (c < 2048) {
                out += String.fromCharCode(192 | (c >> 6), 128 | (c & 63));
            } else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length) {
                var c2 = str.charCodeAt(i + 1);
                var cp = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00);
                i++;
                out += String.fromCharCode(
                    240 | (cp >> 18), 128 | ((cp >> 12) & 63), 128 | ((cp >> 6) & 63), 128 | (cp & 63)
                );
            } else {
                out += String.fromCharCode(224 | (c >> 12), 128 | ((c >> 6) & 63), 128 | (c & 63));
            }
        }
        return out;
    }
    function hashPassword(salt, password) {
        return sha256(salt + '|' + password);
    }

    /* --------------------- random helpers ----------------------- */

    function randBytes(n) {
        var arr = new Uint8Array(n);
        if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
            crypto.getRandomValues(arr);
        } else {
            for (var i = 0; i < n; i++) arr[i] = Math.floor(Math.random() * 256);
        }
        return arr;
    }
    function randHex(n) {
        var b = randBytes(n), s = '';
        for (var i = 0; i < b.length; i++) s += ('0' + b[i].toString(16)).slice(-2);
        return s;
    }
    function generateKeyValue() {
        var bytes = randBytes(8), out = '';
        for (var i = 0; i < 8; i++) out += KEY_ALPHABET[bytes[i] % KEY_ALPHABET.length];
        return 'LORIX-' + out.slice(0, 4) + '-' + out.slice(4);
    }

    /* ------------------------ seeding --------------------------- */

    function seed() {
        if (localStorage.getItem(K.seeded)) return false;
        if (localStorage.getItem(K.users)) {          // partial state: never clobber
            localStorage.setItem(K.seeded, '1');
            return false;
        }
        var adminSalt = randHex(16);
        var demoSalt = randHex(16);
        var adminKey = makeKeyRecord({ user: 'admin', days: 3650 });
        var demoKey = makeKeyRecord({ user: 'demo', days: 30 });
        saveUsers([
            { u: 'admin', salt: adminSalt, hash: hashPassword(adminSalt, 'lorix2026'), role: 'admin', created: now() },
            { u: 'demo', salt: demoSalt, hash: hashPassword(demoSalt, 'demo1234'), role: 'user', created: now() }
        ]);
        saveKeys([adminKey, demoKey]);
        localStorage.setItem(K.seeded, '1');
        return true;
    }

    /* --------------------- key bookkeeping ---------------------- */

    function effectiveStatus(k) {
        if (k.status === 'revoked') return 'revoked';
        return k.expires > now() ? 'active' : 'expired';
    }
    function activeKeyFor(username) {
        var list = getKeys().filter(function (k) {
            return k.user === username && k.status === 'active' && k.expires > now();
        });
        list.sort(function (a, b) { return b.created - a.created; });
        return list[0] || null;
    }
    function newestKeyFor(username) {
        var list = getKeys().filter(function (k) { return k.user === username; });
        list.sort(function (a, b) { return b.created - a.created; });
        return list[0] || null;
    }
    function makeKeyRecord(opts) {
        opts = opts || {};
        var existing = getKeys();
        var v;
        do { v = generateKeyValue(); }
        while (existing.some(function (x) { return x.k === v; }));
        var days = Math.max(1, Number(opts.days) || 90);
        return {
            k: v,
            user: opts.user || null,
            created: now(),
            expires: now() + days * DAY,
            days: days,
            status: 'active'
        };
    }

    /* ------------------------ lockout --------------------------- */

    function lockState() {
        var l = read(K.lock, null);
        return (l && typeof l === 'object') ? l : { fails: 0, until: 0 };
    }
    function lockBump() {
        var l = lockState();
        l.fails = (l.fails || 0) + 1;
        if (l.fails >= LOCK_LIMIT) { l.fails = 0; l.until = now() + LOCK_MS; }
        write(K.lock, l);
        return l;
    }
    function lockReset() { del(K.lock); }

    /* ------------------------ session --------------------------- */

    function validate() {
        var s = read(K.session, null);
        if (!s || !s.u) return { ok: false, reason: 'no-session' };
        if (s.exp <= now()) { del(K.session); return { ok: false, reason: 'session-expired' }; }
        var user = null;
        var users = getUsers();
        for (var i = 0; i < users.length; i++) {
            if (users[i].u.toLowerCase() === String(s.u).toLowerCase()) { user = users[i]; break; }
        }
        if (!user) { del(K.session); return { ok: false, reason: 'no-user' }; }
        if (user.role !== 'admin' && !activeKeyFor(user.u)) {
            del(K.session);
            var mine = newestKeyFor(user.u);
            return {
                ok: false,
                reason: mine && mine.status === 'revoked' ? 'revoked' : 'key-expired'
            };
        }
        return { ok: true, user: user.u, role: user.role };
    }
    function isAuthed() { return validate().ok; }
    function isAdmin() { var v = validate(); return v.ok && v.role === 'admin'; }
    function currentUser() { var v = validate(); return v.ok ? v.user : null; }

    function login(username, password) {
        var u = String(username == null ? '' : username).trim();
        var p = String(password == null ? '' : password);
        if (!u || !p) return { ok: false, error: 'Enter username and password.' };

        var l = lockState();
        if (l.until > now()) {
            var secs = Math.ceil((l.until - now()) / 1000);
            return { ok: false, error: 'Too many attempts — try again in ' + secs + 's.' };
        }

        var users = getUsers();
        var user = null;
        for (var i = 0; i < users.length; i++) {
            if (users[i].u.toLowerCase() === u.toLowerCase()) { user = users[i]; break; }
        }
        if (!user || user.hash !== hashPassword(user.salt, p)) {
            var st = lockBump();
            var left = LOCK_LIMIT - (st.fails || 0);
            return {
                ok: false,
                error: 'Invalid username or password.'
                    + (st.until > now() ? '' : ' (' + Math.max(0, left) + ' attempts left)')
            };
        }

        if (user.role !== 'admin') {
            if (!activeKeyFor(user.u)) {
                var mine = newestKeyFor(user.u);
                lockReset();
                if (!mine) return { ok: false, error: 'No license key assigned. Contact the administrator.' };
                if (mine.status === 'revoked') return { ok: false, error: 'Your license key has been revoked.' };
                return { ok: false, error: 'Your license key has expired. Renew it to continue.' };
            }
        }

        lockReset();
        write(K.session, { u: user.u, exp: now() + SESSION_DAYS * DAY });
        return { ok: true, user: user.u, role: user.role };
    }

    function logout() {
        del(K.session);
        try { location.reload(); } catch (e) {}
    }

    /* ------------------ admin data operations ------------------- */

    function listUsers() {
        return getUsers().map(function (u) {
            return { u: u.u, role: u.role, created: u.created };
        }).sort(function (a, b) { return a.created - b.created; });
    }

    function listKeys() {
        return getKeys().map(function (k) {
            var st = effectiveStatus(k);
            var t = now();
            return {
                key: k.k,
                user: k.user || null,
                created: k.created,
                expires: k.expires,
                days: k.days,
                status: st,
                // positive = days left, negative = days since expiry
                remaining: st === 'active'
                    ? Math.ceil((k.expires - t) / DAY)
                    : (st === 'expired' ? -Math.ceil((t - k.expires) / DAY) : null)
            };
        }).sort(function (a, b) { return b.created - a.created; });
    }

    function stats() {
        var keys = getKeys();
        var active = 0, expiring = 0, dead = 0;
        var t = now();
        keys.forEach(function (k) {
            var st = effectiveStatus(k);
            if (st === 'active') {
                active++;
                if (k.expires - t <= 7 * DAY) expiring++;
            } else {
                dead++;
            }
        });
        return { users: getUsers().length, keys: keys.length, active: active, expiring: expiring, dead: dead };
    }

    function generateKey(opts) {
        opts = opts || {};
        var keys = getKeys();
        var rec = makeKeyRecord(opts);
        keys.push(rec);
        saveKeys(keys);
        return { ok: true, key: rec.k, user: rec.user, days: rec.days, expires: rec.expires };
    }

    function addUser(opts) {
        opts = opts || {};
        var u = String(opts.username || '').trim();
        var p = String(opts.password || '');
        var days = Math.max(1, Number(opts.days) || 30);
        if (u.length < 3) return { ok: false, error: 'Username needs at least 3 characters.' };
        if (!/^[A-Za-z0-9._-]+$/.test(u)) return { ok: false, error: 'Username: letters, numbers, dot, dash, underscore only.' };
        if (u.toLowerCase() === 'admin') return { ok: false, error: 'That username is reserved.' };
        if (p.length < 6) return { ok: false, error: 'Password needs at least 6 characters.' };
        var users = getUsers();
        if (users.some(function (x) { return x.u.toLowerCase() === u.toLowerCase(); })) {
            return { ok: false, error: 'Username already exists.' };
        }
        var salt = randHex(16);
        users.push({ u: u, salt: salt, hash: hashPassword(salt, p), role: 'user', created: now() });
        saveUsers(users);
        var keys = getKeys();
        var rec = makeKeyRecord({ user: u, days: days });
        keys.push(rec);
        saveKeys(keys);
        return { ok: true, user: u, key: rec.k, days: days };
    }

    function withKey(keyValue, mutate) {
        var keys = getKeys();
        var rec = null;
        for (var i = 0; i < keys.length; i++) {
            if (keys[i].k === keyValue) { rec = keys[i]; break; }
        }
        if (!rec) return { ok: false, error: 'License key not found.' };
        var out = mutate(rec) || { ok: true };
        saveKeys(keys);
        return out;
    }

    function renewKey(keyValue) {
        return withKey(keyValue, function (rec) {
            rec.expires = now() + rec.days * DAY;
            rec.status = 'active';
            return { ok: true, expires: rec.expires };
        });
    }
    function extendKey(keyValue) {
        return withKey(keyValue, function (rec) {
            rec.expires = Math.max(now(), rec.expires) + rec.days * DAY;
            rec.status = 'active';
            return { ok: true, expires: rec.expires };
        });
    }
    function revokeKey(keyValue) {
        return withKey(keyValue, function (rec) {
            rec.status = 'revoked';
            return { ok: true };
        });
    }
    function deleteKey(keyValue) {
        var keys = getKeys().filter(function (k) { return k.k !== keyValue; });
        saveKeys(keys);
        return { ok: true };
    }

    function fmtDate(ts) {
        if (!ts) return '—';
        var d = new Date(ts);
        var m = ('0' + (d.getMonth() + 1)).slice(-2);
        var day = ('0' + d.getDate()).slice(-2);
        return d.getFullYear() + '-' + m + '-' + day;
    }

    /* ====================== GATE UI ============================= */

    var GATE_CSS = [
        'html.lorix-locked, html.lorix-locked body { overflow: hidden !important; }',
        'html.lorix-locked body > *:not(.lorix-auth-gate):not(script):not(style):not(noscript) { visibility: hidden !important; }',
        '.lorix-auth-gate { position: fixed; inset: 0; z-index: 2147483000; display: flex; align-items: center; justify-content: center;',
        '  font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #e8ecf7; box-sizing: border-box;',
        '  background: radial-gradient(1100px 650px at 18% -12%, rgba(139,92,246,.20), transparent 60%),',
        '    radial-gradient(900px 600px at 105% 105%, rgba(16,185,129,.12), transparent 55%), #06080e; }',
        '.lorix-auth-gate *, .lorix-auth-gate *::before, .lorix-auth-gate *::after { box-sizing: border-box; }',
        '.gate-card { width: min(470px, 94vw); background: #0e1320; border: 1px solid rgba(139,92,246,.30); border-radius: 20px;',
        '  padding: 32px 34px 26px; box-shadow: 0 34px 90px rgba(0,0,0,.65), 0 0 60px rgba(139,92,246,.14); }',
        '.gate-logo { display: flex; align-items: center; gap: 11px; font-size: 24px; font-weight: 800; letter-spacing: .4px; margin-bottom: 20px; }',
        '.gate-logo-icon { width: 40px; height: 40px; border-radius: 11px; display: grid; place-items: center; font-size: 15px; color: #fff;',
        '  background: linear-gradient(135deg, #8b5cf6, #6d28d9); box-shadow: 0 8px 20px rgba(139,92,246,.5); }',
        '.gate-secure { margin-left: auto; font-size: 10.5px; font-weight: 800; letter-spacing: 1.4px; color: #10b981;',
        '  background: rgba(16,185,129,.12); border: 1px solid rgba(16,185,129,.4); padding: 5px 11px; border-radius: 999px; }',
        '.gate-title { font-size: 21px; font-weight: 800; margin: 0 0 7px; }',
        '.gate-sub { font-size: 13.5px; line-height: 1.55; color: #93a0bd; margin: 0 0 20px; }',
        '.gate-field { margin-bottom: 14px; }',
        '.gate-field label { display: block; font-size: 11.5px; font-weight: 800; text-transform: uppercase; letter-spacing: 1.3px;',
        '  color: #8b98b8; margin-bottom: 7px; }',
        '.gate-field input { width: 100%; height: 54px; background: #141b2e; border: 1.5px solid #232d48; border-radius: 12px;',
        '  color: #eef2ff; font-size: 17px; padding: 0 16px; outline: none; transition: border-color .15s, box-shadow .15s; }',
        '.gate-field input::placeholder { color: #55628a; }',
        '.gate-field input:focus { border-color: #8b5cf6; box-shadow: 0 0 0 3px rgba(139,92,246,.22); }',
        '.gate-msg { min-height: 20px; font-size: 13.5px; font-weight: 700; color: #f87171; margin: 2px 0 10px; line-height: 1.45; }',
        '.gate-msg.gate-success { color: #10b981; }',
        '.gate-submit { width: 100%; height: 56px; border: 0; border-radius: 12px; font-size: 17px; font-weight: 800; cursor: pointer;',
        '  color: #fff; background: linear-gradient(135deg, #8b5cf6, #7c3aed); box-shadow: 0 12px 28px rgba(139,92,246,.42); transition: transform .12s; }',
        '.gate-submit:disabled { opacity: .62; cursor: default; }',
        '.gate-hint { margin-top: 14px; font-size: 12.5px; line-height: 1.55; color: #fbbf24; background: rgba(251,191,36,.07);',
        '  border: 1px dashed rgba(251,191,36,.45); border-radius: 10px; padding: 9px 12px; }',
        '.gate-foot { margin-top: 16px; text-align: center; font-size: 11.5px; color: #5b678a; letter-spacing: .4px; }',
        '.lorix-auth-gate .remote-focused { outline: none; }',
        '.lorix-auth-gate input.remote-focused { border-color: #c084fc !important;',
        '  box-shadow: 0 0 0 3px rgba(192,132,252,.35), 0 0 24px rgba(139,92,246,.38); }',
        '.lorix-auth-gate button.remote-focused { transform: scale(1.03);',
        '  box-shadow: 0 0 0 3px rgba(192,132,252,.6), 0 0 34px rgba(139,92,246,.6); }'
    ].join('');

    var gateBusy = false;
    var gateDetach = null;

    function focusables(root) {
        var nodes = root.querySelectorAll('button, input, select, textarea, a[href], [tabindex]');
        return Array.prototype.filter.call(nodes, function (el) {
            if (el.disabled) return false;
            if (el.getAttribute('tabindex') === '-1') return false;
            return el.getClientRects().length > 0;
        });
    }
    function markRemote(el) {
        var prev = document.querySelectorAll('.remote-focused');
        for (var i = 0; i < prev.length; i++) prev[i].classList.remove('remote-focused');
        if (el && el.classList) el.classList.add('remote-focused');
    }
    function moveFocus(root, dir) {
        var els = focusables(root);
        if (!els.length) return;
        var cur = document.activeElement;
        var idx = els.indexOf(cur);
        if (idx === -1) {
            var first = (dir === 'up' || dir === 'left') ? els[els.length - 1] : els[0];
            first.focus(); markRemote(first);
            return;
        }
        var r = cur.getBoundingClientRect();
        var cx = r.left + r.width / 2;
        var cy = r.top + r.height / 2;
        var best = null;
        var bestScore = Infinity;
        for (var i = 0; i < els.length; i++) {
            var el = els[i];
            if (el === cur) continue;
            var b = el.getBoundingClientRect();
            var dx = (b.left + b.width / 2) - cx;
            var dy = (b.top + b.height / 2) - cy;
            var primary, cross;
            if (dir === 'right') { primary = dx; cross = Math.abs(dy); }
            else if (dir === 'left') { primary = -dx; cross = Math.abs(dy); }
            else if (dir === 'down') { primary = dy; cross = Math.abs(dx); }
            else { primary = -dy; cross = Math.abs(dx); }
            if (primary <= 2) continue;
            var score = primary + cross * 2;
            if (score < bestScore) { bestScore = score; best = el; }
        }
        if (!best) { // wrap around
            best = (dir === 'down' || dir === 'right') ? els[0] : els[els.length - 1];
            if (best === cur) return;
        }
        best.focus();
        if (best.scrollIntoView) best.scrollIntoView({ block: 'nearest' });
        markRemote(best);
    }

    /**
     * TV remote navigation: arrows move focus between focusable elements,
     * OK/Enter activates. Text fields keep native caret Left/Right and
     * native <select> behavior; Up/Down always walks the layout.
     */
    function bindDpad(root) {
        root = root || document;
        function onKey(e) {
            if (document.getElementById('lorixAuthGate')) return; // gate owns keys
            var map = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
            var dir = map[e.key];
            if (dir) {
                var tag = (e.target && e.target.tagName ? e.target.tagName : '').toLowerCase();
                var type = e.target && e.target.type ? e.target.type : '';
                if (tag === 'select') return;                         // native option walking
                if (tag === 'input' && (type === 'text' || type === 'password' || type === 'number' || type === 'search')
                    && (dir === 'left' || dir === 'right')) return;   // caret movement
                e.preventDefault();
                moveFocus(root, dir);
            } else if (e.key === 'Enter') {
                var t = e.target;
                if (t && t.tagName === 'INPUT') {
                    e.preventDefault();
                    var f = focusables(root);
                    var i = f.indexOf(t);
                    if (i > -1 && f[i + 1]) { f[i + 1].focus(); markRemote(f[i + 1]); }
                    else t.blur();
                }
            }
        }
        window.addEventListener('keydown', onKey, true);
        root.addEventListener('focusin', function (e) { markRemote(e.target); });
        return function () { window.removeEventListener('keydown', onKey, true); };
    }

    /* --------------------- gate rendering ----------------------- */

    function reasonCopy(reason, requireAdmin) {
        if (requireAdmin && reason !== 'no-session') {
            return {
                title: 'Administrator sign-in',
                sub: 'This console is restricted to LoRix administrators.'
            };
        }
        switch (reason) {
            case 'session-expired':
                return { title: 'Session expired', sub: 'Please sign in again to keep streaming.' };
            case 'key-expired':
                return { title: 'License expired', sub: 'Your license key has expired. Renew it with the administrator to continue streaming.' };
            case 'revoked':
                return { title: 'Access revoked', sub: 'This license key has been revoked by the administrator.' };
            case 'no-user':
                return { title: 'Account missing', sub: 'This account no longer exists. Contact the administrator.' };
            default:
                return {
                    title: requireAdmin ? 'Administrator sign-in' : 'Sign in to continue',
                    sub: requireAdmin
                        ? 'Enter the administrator credentials to open the license console.'
                        : 'Streaming is locked until an active account with an unexpired license key signs in.'
                };
        }
    }

    function submitGate() {
        if (gateBusy) return;
        var u = document.getElementById('gateUser');
        var p = document.getElementById('gatePass');
        var btn = document.getElementById('gateSubmit');
        var msg = document.getElementById('gateMsg');
        if (!u || !p || !btn) return;
        gateBusy = true;
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Verifying…';
        var res = login(u.value, p.value);
        if (res.ok) {
            msg.className = 'gate-msg gate-success';
            msg.textContent = 'Welcome back, ' + res.user + ' — opening LoRix…';
            setTimeout(function () {
                try { location.reload(); } catch (e) {}
            }, 450);
            return;
        }
        gateBusy = false;
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> Sign In';
        msg.className = 'gate-msg';
        msg.textContent = res.error || 'Sign-in failed.';
        p.value = '';
        p.focus();
        markRemote(p);
    }

    function buildGate(v, opts, firstRun) {
        if (document.getElementById('lorixAuthGate')) return;
        var style = document.createElement('style');
        style.id = 'lorixAuthStyle';
        style.textContent = GATE_CSS;
        document.head.appendChild(style);

        var copy = reasonCopy(v.reason, opts.requireAdmin);

        var gate = document.createElement('div');
        gate.className = 'lorix-auth-gate';
        gate.id = 'lorixAuthGate';
        gate.setAttribute('role', 'dialog');
        gate.setAttribute('aria-modal', 'true');
        gate.innerHTML =
            '<div class="gate-card">' +
                '<div class="gate-logo"><span class="gate-logo-icon"><i class="fa-solid fa-play"></i></span>' +
                    'LoRix <span class="gate-secure"><i class="fa-solid fa-lock"></i> LICENSE GATE</span></div>' +
                '<h1 class="gate-title" id="gateTitle">' + copy.title + '</h1>' +
                '<p class="gate-sub" id="gateSub">' + copy.sub + '</p>' +
                '<div class="gate-field"><label for="gateUser">Username</label>' +
                    '<input id="gateUser" type="text" autocomplete="username" autocapitalize="off" spellcheck="false" placeholder="Enter username"></div>' +
                '<div class="gate-field"><label for="gatePass">Password</label>' +
                    '<input id="gatePass" type="password" autocomplete="current-password" placeholder="Enter password"></div>' +
                '<div class="gate-msg" id="gateMsg" role="alert"></div>' +
                '<button class="gate-submit" id="gateSubmit"><i class="fa-solid fa-right-to-bracket"></i> Sign In</button>' +
                (firstRun
                    ? '<div class="gate-hint"><b>First run — seeded accounts:</b><br>admin / lorix2026 (administrator) · demo / demo1234 (30-day user key)</div>'
                    : '') +
                '<div class="gate-foot">LoRix License Gate · active key required · session 7 days</div>' +
            '</div>';
        document.body.appendChild(gate);
        document.documentElement.classList.add('lorix-locked');

        document.getElementById('gateSubmit').addEventListener('click', submitGate);
        var passInput = document.getElementById('gatePass');
        passInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); submitGate(); }
        });
        var userInput = document.getElementById('gateUser');
        userInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); passInput.focus(); markRemote(passInput); }
        });

        // Capture-phase key handling: the page behind the gate never sees keys.
        function onGateKey(e) {
            e.stopImmediatePropagation();
            var tag = (e.target && e.target.tagName ? e.target.tagName : '').toLowerCase();
            var inField = tag === 'input' || tag === 'textarea';
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                moveFocus(gate, e.key === 'ArrowDown' ? 'down' : 'up');
            } else if (e.key === 'Enter') {
                e.preventDefault();
                if (e.target && e.target.id === 'gateUser') {
                    passInput.focus(); markRemote(passInput);
                } else {
                    submitGate();
                }
            } else if (e.key === 'Backspace' && !inField) {
                e.preventDefault();
            }
        }
        window.addEventListener('keydown', onGateKey, true);
        gateDetach = function () { window.removeEventListener('keydown', onGateKey, true); };

        // First field focused so a remote OK opens the on-screen keyboard.
        setTimeout(function () { userInput.focus(); markRemote(userInput); }, 60);
    }

    function revealAffordances(v) {
        var adminBtn = document.getElementById('btnAdmin');
        if (adminBtn) adminBtn.style.display = (v.role === 'admin') ? '' : 'none';
        var exitBtn = document.getElementById('btnLogout');
        if (exitBtn) exitBtn.style.display = '';
    }

    /**
     * Page entry point. Called at the top of <body> so the gate paints
     * before any catalog/player markup. Returns { mounted, ok, reason }.
     */
    function mountGate(opts) {
        opts = opts || {};
        var firstRun = seed();
        var v = validate();
        var wantAdmin = !!opts.requireAdmin;
        if (v.ok && (!wantAdmin || v.role === 'admin')) {
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', function () { revealAffordances(v); });
            } else {
                revealAffordances(v);
            }
            return { mounted: false, ok: true, reason: null };
        }
        buildGate(v, opts, firstRun);
        return { mounted: true, ok: false, reason: v.ok ? 'not-admin' : v.reason };
    }

    return {
        version: '1.0.0',
        mountGate: mountGate,
        login: login,
        logout: logout,
        validate: validate,
        isAuthed: isAuthed,
        isAdmin: isAdmin,
        currentUser: currentUser,
        seed: seed,
        listUsers: listUsers,
        listKeys: listKeys,
        stats: stats,
        generateKey: generateKey,
        addUser: addUser,
        renewKey: renewKey,
        extendKey: extendKey,
        revokeKey: revokeKey,
        deleteKey: deleteKey,
        fmtDate: fmtDate,
        bindDpad: bindDpad,
        sha256: sha256
    };
});
