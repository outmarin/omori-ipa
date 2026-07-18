//=============================================================================
// ios_compat.js  — iOS / LiveContainer layer for OMORI (Cordova), HTTP-server
// approach. Injected into index.html right BEFORE js/main.js.
//
// Root problem: WKWebView blocks ALL file:// XHR/fetch (sync + async), which
// breaks every asset the RPG Maker MV engine loads (database, maps, audio,
// fonts, per-image dir listings). Shimming each path from file:// proved
// fragile and non-deterministic.
//
// Fix: run a tiny local HTTP server (cordova-plugin-httpd / CocoaHTTPServer)
// that serves the bundle www, and redirect the WKWebView from file:// to
// http://127.0.0.1:PORT. Over http, sync AND async XHR work natively at any
// time — no shims, no embedding, no races. Only saves need special handling
// (they must persist to documentsDirectory, not the read-only bundle).
//=============================================================================

(function () {
    "use strict";
    if (typeof cordova === "undefined" || cordova.platformId !== "ios") return;

    var PORT = 8081;
    var noop = function () {};
    var statusLines = [];
    function stat(s) { statusLines.push("[" + location.protocol + "] " + s); console.log("[ios_compat] " + s); try { writeStatus(); } catch (e) {} }
    function writeStatus() {
        if (!window.cordova || !cordova.file || !cordova.file.documentsDirectory) return;
        writeDocs(null, "ios_status.txt", statusLines.join("\n"));
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
                }, function () {});
            }
            if (subdir) root.getDirectory(subdir, { create: true }, put, function () {});
            else put(root);
        }, function () {});
    }

    // ---- Android-only API stubs (needed in both phases) ------------------
    window.AndroidFullScreen = {
        immersiveMode: noop, showSystemUI: noop, leanMode: noop, showUnderStatusBar: noop,
        showUnderSystemUI: noop, setSystemUiVisibility: noop, isSupported: noop
    };
    navigator.app = navigator.app || { exitApp: noop, overrideBackButton: noop };
    cordova.plugins = cordova.plugins || {};
    cordova.plugins.permissions = cordova.plugins.permissions || {
        WRITE_EXTERNAL_STORAGE: "",
        checkPermission: function (p, cb) { cb({ hasPermission: true }); },
        requestPermission: function (p, cb) { if (cb) cb({ hasPermission: true }); }
    };
    if (typeof SceneManager !== "undefined") SceneManager.terminate = noop;

    // =====================================================================
    //  PHASE 1 — file://  : start the server, redirect, run nothing else.
    // =====================================================================
    if (location.protocol === "file:") {
        stat("file phase: will start httpd + redirect");
        // don't let the throwaway file:// page load plugins / boot (they'd hit
        // blocked file:// XHR); the real run happens after the http redirect.
        if (typeof PluginManager !== "undefined") PluginManager.setup = noop;
        if (typeof SceneManager !== "undefined") SceneManager.run = noop;

        document.addEventListener("deviceready", function () {
            var httpd = (cordova.plugins && cordova.plugins.CorHttpd) || window.CorHttpd || window.cordovaHttpd;
            if (!httpd) { stat("ERROR: httpd plugin missing (cordova.plugins=" + Object.keys(cordova.plugins || {}).join(",") + ")"); return; }
            httpd.startServer({ www_root: "", port: PORT, localhost_only: true }, function (url) {
                var base = String(url).replace(/\/+$/, "");
                // force loopback host (plugin may report a LAN ip)
                base = base.replace(/https?:\/\/[^:/]+/, "http://127.0.0.1");
                stat("server up -> " + base + " ; redirecting");
                window.location.replace(base + "/index.html");
            }, function (e) { stat("startServer failed: " + e); });
        }, false);
        return;
    }

    // =====================================================================
    //  PHASE 2 — http://  : the real run. Sync/async XHR work natively.
    //  Only saves need help: persist to documentsDirectory (LiveContainer-safe).
    // =====================================================================
    stat("http phase: real run");

    // capture real errors (engine hides them behind its red screen)
    window.addEventListener("error", function (ev) {
        stat("JS ERR: " + (ev.message || "") + " @ " + (ev.filename || "").split("/").pop() + ":" + ev.lineno +
             (ev.error && ev.error.stack ? " | " + String(ev.error.stack).replace(/\n/g, " << ").slice(0, 300) : ""));
    });
    if (typeof SceneManager !== "undefined") {
        var _ce = SceneManager.catchException;
        SceneManager.catchException = function (e) { stat("SM.catch: " + (e && e.message ? e.message : e) + " | " + String(e && e.stack || "").replace(/\n/g, " << ").slice(0, 350)); return _ce ? _ce.apply(this, arguments) : undefined; };
        var _frames = 0, _um = SceneManager.updateMain;
        if (_um) SceneManager.updateMain = function () { _frames++; window.__iosFrames = _frames; return _um.apply(this, arguments); };
        // instrument changeScene: capture why it doesn't swap
        var _cs = SceneManager.changeScene;
        if (_cs) SceneManager.changeScene = function () {
            window.__csN = (window.__csN || 0) + 1;
            try {
                window.__csState = "chg=" + this.isSceneChanging() +
                    " sc=" + (this._scene && this._scene.constructor.name) +
                    " nx=" + (this._nextScene && this._nextScene.constructor.name) +
                    " busy=" + this.isCurrentSceneBusy();
            } catch (e) { window.__csState = "err:" + e.message; }
            return _cs.apply(this, arguments);
        };
        // trace goto (who requests the transition, how often)
        var _goto = SceneManager.goto;
        if (_goto) SceneManager.goto = function (sc) {
            window.__gotoN = (window.__gotoN || 0) + 1;
            window.__gotoLast = sc && sc.name;
            return _goto.apply(this, arguments);
        };
    }

    function baseName(p) { return String(p).replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop(); }
    window._SAYGEXES = window._SAYGEXES || {};
    function cacheSet(name, exists, content) {
        var e = window._SAYGEXES[name] || {};
        if (exists !== undefined) e.exists = exists;
        if (content !== undefined) e.content = content;
        window._SAYGEXES[name] = e;
    }
    function installNativeFunctions() {
        if (window.NativeFunctions && window.NativeFunctions.__ios) return;
        if (typeof StorageManager !== "undefined") StorageManager.isLocalMode = function () { return true; };
        var NF = { __ios: true,
            saveFileExists: function (p) { var e = window._SAYGEXES[baseName(p)]; return !!(e && e.exists); },
            readSaveFileUTF8: function (p) { var e = window._SAYGEXES[baseName(p)]; return (e && e.content != null) ? e.content : null; },
            writeSaveFileUTF8: function (p, d) { var n = baseName(p); cacheSet(n, true, d); writeDocs("save", n, d); },
            writeExternalFileUTF8: function (p, d) { writeDocs(null, baseName(p), d); } };
        window.NativeFunctions = NF; Object.freeze(window.NativeFunctions);
        stat("NativeFunctions installed (documentsDirectory)");
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

    // hold boot until the save cache is warm (StorageManager cold reads are sync)
    var ready = false, pendingBoot = null, _run = SceneManager.run.bind(SceneManager);
    SceneManager.run = function (sc) { if (ready) return _run(sc); pendingBoot = sc; };
    function releaseBoot() {
        if (ready) return; ready = true;
        installNativeFunctions(); hookImages();
        if (pendingBoot) { var s = pendingBoot; pendingBoot = null; _run(s); }
        [5000, 12000, 25000].forEach(function (ms) { setTimeout(probe.bind(null, ms / 1000 + "s"), ms); });
    }
    var imgStat = { err: 0, ok: 0, errURLs: {} };
    function hookImages() {
        if (typeof Bitmap === "undefined" || Bitmap.__iosHooked) return;
        var _e = Bitmap.prototype._onError, _l = Bitmap.prototype._onLoad;
        Bitmap.prototype._onError = function () { imgStat.err++; if (this._url) imgStat.errURLs[this._url] = (imgStat.errURLs[this._url] || 0) + 1; return _e && _e.apply(this, arguments); };
        Bitmap.prototype._onLoad = function () { imgStat.ok++; return _l && _l.apply(this, arguments); };
        Bitmap.__iosHooked = true;
    }
    function stuckImages() {
        var out = [];
        try {
            var items = ImageManager._imageCache && ImageManager._imageCache._items;
            for (var k in items) {
                var b = items[k].bitmap;
                if (b && b._loadingState && b._loadingState !== "loaded" && b._loadingState !== "none")
                    out.push((b._url || k).split("/").slice(-2).join("/") + ":" + b._loadingState);
            }
        } catch (e) { out.push("err:" + e.message); }
        return out.slice(0, 8);
    }
    function probe(tag) {
        try {
            var s = SceneManager._scene, sc = s && s.constructor && s.constructor.name;
            var imReady = (typeof ImageManager !== "undefined" && ImageManager.isReady) ? ImageManager.isReady() : "?";
            var sbReady = false; try { sbReady = Scene_Base.prototype.isReady.call(SceneManager._scene); } catch (e) {}
            stat("PROBE " + tag + ": scene=" + sc +
                 " db=" + ((typeof DataManager !== "undefined" && DataManager.isDatabaseLoaded) ? DataManager.isDatabaseLoaded() : "?") +
                 " font=" + (typeof Graphics !== "undefined" && Graphics.isFontLoaded ? Graphics.isFontLoaded("GameFont") : "?") +
                 " ImgReady=" + imReady + " SceneBaseReady=" + sbReady +
                 " started=" + SceneManager._sceneStarted +
                 " next=" + (SceneManager._nextScene && SceneManager._nextScene.constructor && SceneManager._nextScene.constructor.name) +
                 " changing=" + (SceneManager.isSceneChanging && SceneManager.isSceneChanging()) +
                 " realBusy=" + (SceneManager.isCurrentSceneBusy ? SceneManager.isCurrentSceneBusy() : "?") +
                 " reqQ=" + (typeof ImageManager !== "undefined" && ImageManager._requestQueue && ImageManager._requestQueue._queue ? ImageManager._requestQueue._queue.length : "?") +
                 " q0=" + (typeof ImageManager !== "undefined" && ImageManager._requestQueue && ImageManager._requestQueue._queue && ImageManager._requestQueue._queue[0] ? ImageManager._requestQueue._queue[0].key : "-") +
                 " nextAtlas=" + (SceneManager._nextScene && SceneManager._nextScene.areAllRequiredAtlasLoaded ? SceneManager._nextScene.areAllRequiredAtlasLoaded() : "?") +
                 " frames=" + (window.__iosFrames || 0) +
                 " csN=" + (window.__csN || 0) + " csState=[" + window.__csState + "]" +
                 " goto{n:" + (window.__gotoN || 0) + ",last:" + window.__gotoLast + "}" +
                 " mSafari=" + (typeof Utils !== "undefined" && Utils.isMobileSafari ? Utils.isMobileSafari() : "?") +
                 " imReadyNow=" + (typeof ImageManager !== "undefined" && ImageManager.isReady ? ImageManager.isReady() : "?") +
                 " stuck=" + JSON.stringify(stuckImages()) +
                 " img{ok:" + imgStat.ok + "}");
        } catch (e) { stat("probe err: " + e.message); }
    }

    document.addEventListener("deviceready", function () {
        stat("deviceready; docs=" + (cordova.file && cordova.file.documentsDirectory));
        installNativeFunctions();
        preloadSaves().then(function () { stat("saves=" + Object.keys(window._SAYGEXES).length); releaseBoot(); })
                      .catch(function (e) { stat("saves err: " + e); releaseBoot(); });
    }, false);
    setTimeout(releaseBoot, 15000); // safety net
})();
