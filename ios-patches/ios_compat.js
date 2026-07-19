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
    function stat(s) {
        statusLines.push("[" + location.protocol + "] " + s);
        if (statusLines.length > 80) statusLines.shift(); // bounded: no unbounded growth over a long session
        console.log("[ios_compat] " + s);
        try { writeStatus(); } catch (e) {}
    }
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

    // ---------------------------------------------------------------------
    //  Screen fit: on a notched iPhone in landscape the webview reports its
    //  real size only after it settles, so RPG MV's one-shot layout leaves the
    //  canvas mis-scaled / shifted. Force a re-layout after settle + on rotate.
    //  Universal (no per-device values); a no-op when already correct.
    // ---------------------------------------------------------------------
    function relayout() {
        try {
            if (window.Graphics && Graphics._updateAllElements) {
                Graphics._updateAllElements();
                stat("relayout innerW=" + window.innerWidth + " innerH=" + window.innerHeight +
                     " scale=" + (Graphics._realScale != null ? Graphics._realScale.toFixed(3) : "?") +
                     " safe=[" + safeInsets() + "]");
            }
        } catch (e) {}
    }
    function safeInsets() {
        try {
            var s = getComputedStyle(document.documentElement);
            return ["top", "right", "bottom", "left"].map(function (k) {
                var d = document.createElement("div");
                d.style.cssText = "position:fixed;padding:env(safe-area-inset-" + k + ")";
                document.body.appendChild(d);
                var v = getComputedStyle(d).paddingTop; document.body.removeChild(d); return v;
            }).join(",");
        } catch (e) { return "?"; }
    }
    window.addEventListener("resize", function () { setTimeout(relayout, 60); setTimeout(relayout, 300); });
    window.addEventListener("orientationchange", function () { [100, 400, 900].forEach(function (m) { setTimeout(relayout, m); }); });
    [400, 1000, 2000, 3500].forEach(function (m) { setTimeout(relayout, m); });

    // capture real errors (engine hides them behind its red screen)
    window.addEventListener("error", function (ev) {
        stat("JS ERR: " + (ev.message || "") + " @ " + (ev.filename || "").split("/").pop() + ":" + ev.lineno +
             (ev.error && ev.error.stack ? " | " + String(ev.error.stack).replace(/\n/g, " << ").slice(0, 300) : ""));
    });
    if (typeof SceneManager !== "undefined") {
        var _ce = SceneManager.catchException;
        SceneManager.catchException = function (e) { stat("SM.catch: " + (e && e.message ? e.message : e) + " | " + String(e && e.stack || "").replace(/\n/g, " << ").slice(0, 350)); return _ce ? _ce.apply(this, arguments) : undefined; };
        var _frames = 0, _um = SceneManager.updateMain;
        if (_um) SceneManager.updateMain = function () {
            _frames++; window.__iosFrames = _frames;
            if (_frames === 1 || (_frames === 30 && !window.__loopLogged)) {
                window.__loopLogged = true;
                try { stat("LOOP@" + _frames + " this===winSM:" + (this === window.SceneManager) +
                    " this===closureSM:" + (this === SceneManager) +
                    " thisScene:" + (this._scene && this._scene.constructor.name) +
                    " winScene:" + (window.SceneManager._scene && window.SceneManager._scene.constructor.name) +
                    " winSM===closureSM:" + (window.SceneManager === SceneManager)); } catch (e) {}
            }
            return _um.apply(this, arguments);
        };
        // instrument changeScene: capture why it doesn't swap
        var _cs = SceneManager.changeScene;
        if (_cs) SceneManager.changeScene = function () {
            window.__csN = (window.__csN || 0) + 1;
            try {
                window.__csState = "chg=" + this.isSceneChanging() +
                    " sc=" + (this._scene && this._scene.constructor.name) +
                    " nx=" + (this._nextScene && this._nextScene.constructor.name) +
                    " busy=" + this.isCurrentSceneBusy() +
                    " sameSM=" + (this === window.SceneManager) +
                    " gnx=" + (window.SceneManager && window.SceneManager._nextScene && window.SceneManager._nextScene.constructor.name);
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

    // hold boot until the save cache is warm (StorageManager cold reads are sync).
    // IMPORTANT: run on the CURRENT window.SceneManager at release time, not a
    // reference bound now — the engine's global SceneManager identity can change
    // between this script's evaluation and deviceready, and binding early made the
    // render loop run on a stale object while scene logic used the live global.
    var ready = false, pendingBoot = null, _origRun = SceneManager.run;
    try { SceneManager.__iosMark = "EVAL"; } catch (e) {}
    SceneManager.run = function (sc) { if (ready) return _origRun.call(this, sc); pendingBoot = sc; };
    function hookScenes() {
        function wrap(cls, methods) {
            if (typeof cls === "undefined" || !cls) return;
            methods.forEach(function (m) {
                var o = cls.prototype[m];
                if (o && !o.__ioshook) {
                    cls.prototype[m] = function () { if (m !== "update" || !this.__u) { this.__u = 1; stat("LIFE " + cls.name + "." + m); } return o.apply(this, arguments); };
                    cls.prototype[m].__ioshook = true;
                }
            });
        }
        try { wrap(Scene_Boot, ["start", "terminate"]); } catch (e) {}
        try { wrap(window.Scene_SplashScreens, ["create", "start", "terminate"]); } catch (e) {}
        try { wrap(window.Scene_OmoriTitleScreen, ["create", "start"]); } catch (e) {}
        try { wrap(window.Scene_Title, ["create", "start"]); } catch (e) {}
    }
    // Separate iOS-port credit on the title screen (does NOT touch the original
    // RU porters' "ported by" button — they keep their credit/link).
    function hookTitleCredit() {
        var T = window.Scene_OmoriTitleScreen;
        if (!T || T.prototype.__creditHook) return;
        T.prototype.__creditHook = true;
        var _start = T.prototype.start;
        T.prototype.start = function () {
            if (_start) _start.apply(this, arguments);
            try {
                if (this.__credit) return;
                var w = Graphics.width;
                var bmp = new Bitmap(w, 22);
                bmp.fontSize = 13;
                bmp.textColor = "#ffffff";
                bmp.outlineColor = "rgba(0,0,0,0.9)";
                bmp.outlineWidth = 4;
                bmp.drawText("iOS port: nanomolydev  ·  @nanomolydev", 4, 2, w - 8, 20, "left");
                var sp = new Sprite(bmp);
                sp.x = 0; sp.y = 2;
                this.addChild(sp);
                this.__credit = sp;
                stat("title credit added");
            } catch (e) { stat("credit err: " + e.message); }
        };
    }
    function firstNotReady() {
        try {
            var items = ImageManager._imageCache && ImageManager._imageCache._items;
            for (var k in items) {
                var b = items[k].bitmap;
                if (b && !b.isRequestOnly() && !b.isReady())
                    return (b._url || k).split("/").slice(-2).join("/") + ":" + b._loadingState;
            }
        } catch (e) { return "err:" + e.message; }
        return "-";
    }
    // Passive monitor (NO state mutation). Logs every state transition and, when
    // a transition/start stalls >2s, logs exactly which gate blocks it.
    function monitor() {
        var lastKey = null, stuckSince = 0, stuckLogged = false, ticks = 0, iv;
        iv = setInterval(function () {
            ticks++;
            if (ticks > 240) { clearInterval(iv); return; } // stop after ~60s; boot is long done, no ongoing overhead
            var SM = SceneManager, s = SM._scene;
            var busy = false, ready = false;
            try { busy = SM.isCurrentSceneBusy(); } catch (e) {}
            try { ready = s && s.isReady(); } catch (e) {}
            var changing = SM.isSceneChanging && SM.isSceneChanging();
            var key = (s && s.constructor.name) + "|st=" + SM._sceneStarted + "|chg=" + changing + "|busy=" + busy + "|rdy=" + ready;
            if (key !== lastKey) {
                stat("STATE " + key + " f=" + (window.__iosFrames || 0));
                lastKey = key; stuckSince = ticks; stuckLogged = false;
                return;
            }
            // same state persisting
            var pending = changing || (s && !SM._sceneStarted);
            if (pending && !stuckLogged && ticks - stuckSince >= 8) { // ~2s
                stuckLogged = true;
                if (changing && busy) stat("STUCK-SWAP busy fadeDur=" + (s && s._fadeDuration) + " nx=" + (SM._nextScene && SM._nextScene.constructor.name));
                else if (changing && !busy) stat("STUCK-SWAP not-busy-but-no-swap nx=" + (SM._nextScene && SM._nextScene.constructor.name) + " f=" + (window.__iosFrames || 0));
                else if (!SM._sceneStarted && !ready) stat("STUCK-START notReady first=" + firstNotReady());
                else if (!SM._sceneStarted && ready) stat("STUCK-START ready-but-not-started (loop dead?) f=" + (window.__iosFrames || 0));
            }
            // Nudge via the ENGINE's own methods with explicit this=global SceneManager.
            // If the loop's `this` is the wrong object, this swaps correctly (proper
            // create + Graphics load sequencing). If not, it's a harmless no-op.
            if (pending && ticks - stuckSince >= 8) {
                try {
                    var before = SM._scene && SM._scene.constructor.name;
                    window.SceneManager.changeScene.call(window.SceneManager);
                    window.SceneManager.updateScene.call(window.SceneManager);
                    var after = window.SceneManager._scene && window.SceneManager._scene.constructor.name;
                    if (before !== after) { stat("NUDGE " + before + " -> " + after); lastKey = null; }
                } catch (e) { stat("nudge err: " + e.message); }
            }
        }, 250);
    }
    // CI-only smoke test: once the title screen is up, press OK to start a new
    // game and confirm the game advances past the title. Gated on a flag the CI
    // appends to this file after build; the shipped device IPA never sets it.
    function ciAutotest() {
        if (!window.__OMORI_CI_AUTOTEST) return;
        var fired = false;
        var iv = setInterval(function () {
            var s = window.SceneManager._scene, n = s && s.constructor.name;
            if (!fired && n === "Scene_OmoriTitleScreen" && window.SceneManager._sceneStarted) {
                fired = true; clearInterval(iv);
                stat("CI: title up -> starting New Game in 4s (let intro settle)");
                setTimeout(function () {
                    var s2 = window.SceneManager._scene;
                    try {
                        // Try realistic input first ('ok' selects the highlighted New Game)
                        if (window.Input && Input._onKeyDown) {
                            Input._onKeyDown({ keyCode: 13, preventDefault: function () {} });
                            setTimeout(function () { try { Input._onKeyUp({ keyCode: 13 }); } catch (e) {} }, 120);
                            stat("CI: pressed OK");
                        }
                    } catch (e) { stat("CI press err: " + e.message); }
                    // Fallback: if still on title 2.5s later, invoke New Game directly
                    setTimeout(function () {
                        var s3 = window.SceneManager._scene;
                        if (s3 && s3.constructor.name === "Scene_OmoriTitleScreen") {
                            try {
                                s3._commandIndex = 0;
                                if (s3.commandNewGame) { s3.commandNewGame(); stat("CI: commandNewGame() called directly"); }
                            } catch (e) { stat("CI newgame err: " + e.message); }
                        }
                        setTimeout(function () { stat("CI: post-newgame scene=" + (window.SceneManager._scene && window.SceneManager._scene.constructor.name)); }, 3000);
                    }, 2500);
                }, 4000);
            }
        }, 300);
    }
    function releaseBoot() {
        if (ready) return; ready = true;
        installNativeFunctions(); hookImages(); hookScenes(); hookTitleCredit(); monitor(); ciAutotest();
        if (pendingBoot) {
            var g = window.SceneManager, s = pendingBoot; pendingBoot = null;
            stat("release: global===evalSM=" + (g === SceneManager) + " gMark=" + g.__iosMark);
            g.run = _origRun;            // un-gate the live global
            _origRun.call(g, s);         // start the loop on the CURRENT global
        }
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
