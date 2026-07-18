//=============================================================================
// ios_compat.js  — iOS / LiveContainer compatibility layer for OMORI (Cordova)
//
// Injected into index.html as a plain <script> right after js/main.js.
//
// The core iOS problem: WKWebView forbids ALL XHR/fetch to file:// (sync AND
// async) -> every asset the engine loads by XHR (database JSON, maps, audio
// ogg) throws "send@[native code]". Images/video load via <img>/<video>
// elements and are fine.
//
// Fix: intercept XMLHttpRequest and serve local URLs from the app bundle via
// cordova-plugin-file (native file read, not XHR). Synchronous reads are served
// from a cache preloaded before boot (yaml/Languages). Saves go to
// documentsDirectory (LiveContainer-safe). All no-ops off iOS.
//=============================================================================

(function () {
    "use strict";

    var isIOS = (typeof cordova !== "undefined" && cordova.platformId === "ios");
    if (!isIOS) return;
    console.log("[ios_compat] active");

    var noop = function () {};
    var statusLines = [];
    function stat(s) { statusLines.push(s); console.log("[ios_compat] " + s); try { writeStatus(); } catch (e) {} }

    // capture the real JS error (the game's red screen hides the message)
    window.addEventListener("error", function (ev) {
        var where = (ev.filename || "").split("/").pop() + ":" + ev.lineno + ":" + ev.colno;
        stat("JS ERROR: " + (ev.message || "") + " @ " + where +
             (ev.error && ev.error.stack ? " | " + String(ev.error.stack).split("\n").slice(0, 3).join(" << ") : ""));
    });
    // the engine catches exceptions itself (red screen) - hook it for the real message
    if (typeof SceneManager !== "undefined") {
        var _ce = SceneManager.catchException;
        SceneManager.catchException = function (e) {
            stat("SM.catch: " + (e && e.message ? e.message : e) + " || " +
                 String(e && e.stack || "").replace(/\n/g, " << ").slice(0, 500));
            return _ce ? _ce.apply(this, arguments) : undefined;
        };
        var _oe = SceneManager.onError;
        SceneManager.onError = function (e) {
            stat("SM.onError: " + (e && e.message ? e.message : e));
            return _oe ? _oe.apply(this, arguments) : undefined;
        };
    }
    // direct self-test of the exact runtime path that keeps failing (Atlas.yaml)
    function atlasSelfTest() {
        try {
            var fs = require("fs");
            var t = fs.readFileSync("./data/Atlas.yaml");
            stat("atlas read: type=" + typeof t + " len=" + (t && t.length) + " head=" + JSON.stringify(String(t).slice(0, 12)));
            var y = window.jsyaml || window.jsYaml;
            if (!y) return stat("atlas: jsyaml MISSING");
            var p = y.load(typeof t === "string" ? t : t.toString());
            stat("atlas parsed: type=" + typeof p + " hasSource=" + !!(p && p.source) +
                 " keys=" + (p && p.source ? Object.keys(p.source).length : -1));
            stat("$atlasData now: type=" + typeof window.$atlasData + " hasSource=" + !!(window.$atlasData && window.$atlasData.source));
        } catch (e) { stat("atlas selftest err: " + e.message); }
    }

    // ---- 1. Android-only API stubs ---------------------------------------
    window.AndroidFullScreen = {
        immersiveMode: noop, showSystemUI: noop, leanMode: noop,
        showUnderStatusBar: noop, showUnderSystemUI: noop,
        setSystemUiVisibility: noop, isSupported: noop
    };
    navigator.app = navigator.app || { exitApp: noop, overrideBackButton: noop };
    cordova.plugins = cordova.plugins || {};
    cordova.plugins.permissions = cordova.plugins.permissions || {
        WRITE_EXTERNAL_STORAGE: "",
        checkPermission: function (p, cb) { cb({ hasPermission: true }); },
        requestPermission: function (p, cb) { if (cb) cb({ hasPermission: true }); }
    };

    // ---- path helpers ----------------------------------------------------
    function toRel(url) { // any url -> "data/System.json" (www-relative) or null if remote
        var u = String(url).split("?")[0].split("#")[0];
        if (/^(https?|blob|data):/i.test(u)) return null;
        if (/^file:\/\//i.test(u)) {
            var i = u.indexOf("/www/");
            return i >= 0 ? u.slice(i + 5) : u.replace(/^file:\/\/+/, "");
        }
        return u.replace(/^\.?\/+/, "");
    }
    function baseName(p) { return String(p).replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop(); }

    // ---- cordova-plugin-file bundle readers (bypass WKWebView XHR) --------
    function readBundle(rel, kind) { // kind: 'text' | 'arraybuffer' | 'blob' -> Promise
        var url = cordova.file.applicationDirectory + "www/" + rel;
        return new Promise(function (resolve, reject) {
            window.resolveLocalFileSystemURL(url, function (entry) {
                entry.file(function (file) {
                    if (kind === "blob") return resolve(file); // File is a Blob
                    var r = new FileReader();
                    r.onerror = function () { reject(new Error("read " + rel)); };
                    if (kind === "arraybuffer") { r.onloadend = function () { resolve(r.result); }; r.readAsArrayBuffer(file); }
                    else { r.onloadend = function () { resolve(r.result); }; r.readAsText(file); }
                }, reject);
            }, reject);
        });
    }

    // =====================================================================
    //  XMLHttpRequest shim: local URLs -> file plugin; remote -> real XHR
    // =====================================================================
    // synchronous read caches, warmed from build-time embedded data so they
    // are ready BEFORE plugins run (plugins read Atlas.yaml/Languages at load).
    var syncCache = window.__IOS_SYNC_FILES || {}; // "data/Notes.yaml" -> text
    var dirCache = window.__IOS_SYNC_DIRS || {};   // "Languages/en" -> [files]

    function installXHRShim() {
        var Real = window.__RealXHR || window.XMLHttpRequest;
        if (window.XMLHttpRequest && window.XMLHttpRequest.__iosShim) return;
        window.__RealXHR = Real;

        function XHR() { this.readyState = 0; this.status = 0; this.response = null;
            this.responseText = ""; this.responseType = ""; this.responseURL = "";
            this.onload = null; this.onerror = null; this.onreadystatechange = null; this.onprogress = null;
            this.timeout = 0; this.withCredentials = false; this._h = { load: [], error: [], readystatechange: [] };
            this._url = null; this._async = true; this._method = "GET"; this._real = null; }

        XHR.prototype.open = function (method, url, async) {
            this._method = (method || "GET").toUpperCase(); this._url = url; this._async = (async !== false);
            var rel = toRel(url);
            if (rel === null || this._method !== "GET") { this._real = new Real(); this._real.open(method, url, async); this._rel = null; }
            else { this._rel = rel; }
        };
        XHR.prototype.setRequestHeader = function (k, v) { if (this._real) this._real.setRequestHeader(k, v); };
        XHR.prototype.overrideMimeType = function (m) { if (this._real && this._real.overrideMimeType) this._real.overrideMimeType(m); };
        XHR.prototype.getAllResponseHeaders = function () { return this._real ? this._real.getAllResponseHeaders() : ""; };
        XHR.prototype.getResponseHeader = function (h) { return this._real ? this._real.getResponseHeader(h) : null; };
        XHR.prototype.abort = function () { if (this._real) this._real.abort(); };
        XHR.prototype.addEventListener = function (t, fn) { if (this._h[t]) this._h[t].push(fn); if (this._real) this._real.addEventListener(t, fn); };
        XHR.prototype.removeEventListener = function (t, fn) { if (this._h[t]) this._h[t] = this._h[t].filter(function (f) { return f !== fn; }); if (this._real) this._real.removeEventListener(t, fn); };

        XHR.prototype._fire = function (type) {
            var e = { type: type, target: this, currentTarget: this };
            if (type === "readystatechange" && this.onreadystatechange) this.onreadystatechange(e);
            if (type === "load" && this.onload) this.onload(e);
            if (type === "error" && this.onerror) this.onerror(e);
            (this._h[type] || []).forEach(function (f) { try { f(e); } catch (x) {} });
        };
        XHR.prototype._done = function (status, resp, text) {
            this.readyState = 4; this.status = status; this.response = resp;
            this.responseText = (text != null ? text : (typeof resp === "string" ? resp : ""));
            this.responseURL = this._url;
            this._fire("readystatechange");
            this._fire(status >= 200 && status < 400 ? "load" : "error");
        };

        XHR.prototype.send = function (body) {
            var self = this;
            if (this._real) { // remote or non-GET: proxy through a real XHR
                var r = this._real;
                try { r.responseType = this.responseType; } catch (e) {}
                r.onreadystatechange = function () {
                    self.readyState = r.readyState; self.status = r.status; self.response = r.response;
                    try { self.responseText = r.responseText; } catch (e) {}
                    self._fire("readystatechange");
                    if (r.readyState === 4) self._fire(r.status >= 200 && r.status < 400 ? "load" : "error");
                };
                return r.send(body);
            }
            var rel = this._rel;
            if (!this._async) { // synchronous local read: cache only
                var k = rel.replace(/\/+$/, "");
                if (Object.prototype.hasOwnProperty.call(syncCache, k)) { this._done(200, syncCache[k], syncCache[k]); }
                else { this._done(404, null, ""); }
                return;
            }
            var kind = this.responseType === "arraybuffer" ? "arraybuffer" : this.responseType === "blob" ? "blob" : "text";
            readBundle(rel, kind).then(function (res) {
                self._done(200, res, kind === "text" ? res : null);
            }, function () { self._done(404, null, ""); });
        };

        XHR.UNSENT = 0; XHR.OPENED = 1; XHR.HEADERS_RECEIVED = 2; XHR.LOADING = 3; XHR.DONE = 4;
        XHR.__iosShim = true;
        window.XMLHttpRequest = XHR;
        stat("XMLHttpRequest shim installed");
    }

    // ---- override the nwjs fs sync shim (bypass XHR entirely for sync) ----
    function installFsOverride() {
        var fs = (typeof require === "function") && require.libs && require.libs.fs;
        if (!fs || fs.__iosPatched) return;
        var _rfs = fs.readFileSync, _rds = fs.readdirSync;
        fs.readFileSync = function (path) {
            var k = toRel(path);
            if (k != null && Object.prototype.hasOwnProperty.call(syncCache, k)) return syncCache[k];
            return _rfs.apply(fs, arguments); // saves -> NativeFunctions
        };
        fs.readdirSync = function (path) {
            var k = toRel(path);
            if (k != null && Object.prototype.hasOwnProperty.call(dirCache, k)) return dirCache[k].slice();
            return _rds.apply(fs, arguments);
        };
        fs.__iosPatched = true;
        stat("fs override; embedded syncFiles=" + Object.keys(syncCache).length + " dirs=" + Object.keys(dirCache).length);
    }

    // =====================================================================
    //  Save I/O on documentsDirectory
    // =====================================================================
    window._SAYGEXES = window._SAYGEXES || {};
    function cacheSet(name, exists, content) {
        var e = window._SAYGEXES[name] || {};
        if (exists !== undefined) e.exists = exists;
        if (content !== undefined) e.content = content;
        window._SAYGEXES[name] = e;
    }
    function installNativeFunctions() {
        if (window.NativeFunctions && window.NativeFunctions.__ios) return;
        StorageManager.isLocalMode = function () { return true; };
        var NF = { __ios: true,
            saveFileExists: function (p) { var e = window._SAYGEXES[baseName(p)]; return !!(e && e.exists); },
            readSaveFileUTF8: function (p) { var e = window._SAYGEXES[baseName(p)]; return (e && e.content != null) ? e.content : null; },
            writeSaveFileUTF8: function (p, d) { var n = baseName(p); cacheSet(n, true, d); writeDocs("save", n, d); },
            writeExternalFileUTF8: function (p, d) { writeDocs(null, baseName(p), d); } };
        window.NativeFunctions = NF; Object.freeze(window.NativeFunctions);
        stat("NativeFunctions installed + frozen (documentsDirectory)");
    }
    function writeDocs(subdir, name, data) {
        window.resolveLocalFileSystemURL(cordova.file.documentsDirectory, function (root) {
            function put(dir) {
                dir.getFile(name, { create: true, exclusive: false }, function (fe) {
                    fe.createWriter(function (w) {
                        var blob = new Blob([data], { type: "text/plain" }), wrote = false;
                        w.onerror = function (e) { console.error("[ios_compat] write err", name, e); };
                        w.onwriteend = function () { if (!wrote) { wrote = true; w.write(blob); } };
                        w.truncate(0);
                    });
                }, function (e) { console.error("[ios_compat] getFile err", name, e); });
            }
            if (subdir) root.getDirectory(subdir, { create: true }, put, function (e) { console.error("[ios_compat] getDir err", e); });
            else put(root);
        }, function (e) { console.error("[ios_compat] resolve docs failed", e); });
    }
    function preloadSaves() {
        return new Promise(function (resolve) {
            window.resolveLocalFileSystemURL(cordova.file.documentsDirectory, function (root) {
                root.getDirectory("save", { create: true }, function (saveDir) {
                    saveDir.createReader().readEntries(function (entries) {
                        var files = entries.filter(function (e) { return e.isFile; });
                        if (!files.length) return resolve();
                        var pending = files.length;
                        files.forEach(function (fe) {
                            fe.file(function (file) {
                                var r = new FileReader();
                                r.onloadend = function () { cacheSet(fe.name, true, r.result); if (--pending === 0) resolve(); };
                                r.readAsText(file);
                            }, function () { if (--pending === 0) resolve(); });
                        });
                    }, function () { resolve(); });
                }, function () { resolve(); });
            }, function () { resolve(); });
        });
    }
    function writeStatus() { try { writeDocs(null, "ios_status.txt", statusLines.join("\n")); } catch (e) {} }

    // =====================================================================
    //  Boot gate: hold SceneManager.run until caches warm & shims installed
    // =====================================================================
    installXHRShim();
    installFsOverride();

    var savesReady = false, pendingBoot = null;
    var _run = SceneManager.run.bind(SceneManager);
    SceneManager.run = function (sceneClass) {
        if (savesReady) return _run(sceneClass);
        stat("holding boot until preload done"); pendingBoot = sceneClass;
    };
    function releaseBoot() {
        if (savesReady) return; savesReady = true;
        installXHRShim(); installFsOverride(); installNativeFunctions(); writeStatus();
        if (pendingBoot) { var s = pendingBoot; pendingBoot = null; _run(s); }
    }
    SceneManager.terminate = noop;

    document.addEventListener("deviceready", function () {
        stat("deviceready; docs=" + (cordova.file && cordova.file.documentsDirectory));
        installXHRShim(); installFsOverride(); installNativeFunctions();
        atlasSelfTest();
        preloadSaves()
            .then(function () { stat("saves preloaded=" + Object.keys(window._SAYGEXES).length); releaseBoot(); })
            .catch(function (e) { stat("saves preload error: " + e); releaseBoot(); });
    }, false);

    setTimeout(releaseBoot, 40000); // safety net
})();
