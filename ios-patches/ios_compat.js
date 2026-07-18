//=============================================================================
// ios_compat.js  — iOS / LiveContainer compatibility layer for OMORI (Cordova)
//
// Injected into index.html as a plain <script> right after js/main.js.
//
// Fixes three iOS-only problems (all no-ops on other platforms):
//   1. Android-only API stubs so the port layer doesn't throw.
//   2. Save I/O (NativeFunctions) on cordova-plugin-file @ documentsDirectory,
//      LiveContainer-safe, with a preloaded synchronous cache.
//   3. The boot crash: GTP_OmoriFixes reads data/*.yaml and Languages/<lang>/*
//      via require('fs').readFileSync / readdirSync == SYNCHRONOUS XHR to
//      file://, which WKWebView forbids ("send@[native code]"). We preload
//      that bounded set from the app bundle via cordova-plugin-file (native
//      read, not XHR) and serve readFileSync/readdirSync from a cache.
//=============================================================================

(function () {
    "use strict";

    var isIOS = (typeof cordova !== "undefined" && cordova.platformId === "ios");
    if (!isIOS) return;
    console.log("[ios_compat] active");

    var noop = function () {};
    var statusLines = [];
    function stat(s) { statusLines.push(s); console.log("[ios_compat] " + s); }

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
    function norm(p) { // "./data/Notes.yaml" | "/x/Languages/en" -> "data/Notes.yaml"
        return String(p).replace(/\\/g, "/").replace(/^\.?\/+/, "").replace(/\/+$/, "");
    }
    function baseName(p) { return norm(p).split("/").pop(); }

    // =====================================================================
    //  cordova-plugin-file readers (native, bypass WKWebView XHR entirely)
    // =====================================================================
    function readBundleText(relPath) { // Promise<string>
        var url = cordova.file.applicationDirectory + "www/" + relPath;
        return new Promise(function (resolve, reject) {
            window.resolveLocalFileSystemURL(url, function (entry) {
                entry.file(function (file) {
                    var r = new FileReader();
                    r.onloadend = function () { resolve(r.result); };
                    r.onerror = function () { reject(new Error("read " + relPath)); };
                    r.readAsText(file);
                }, reject);
            }, reject);
        });
    }

    // =====================================================================
    //  3. Synchronous-read cache + fs override
    // =====================================================================
    var syncCache = {};   // "data/Notes.yaml" -> text
    var dirCache = {};    // "Languages/en"    -> ["a.yaml", ...]

    function installFsOverride() {
        var fs = (typeof require === "function") && require.libs && require.libs.fs;
        if (!fs || fs.__iosPatched) return;
        var _rfs = fs.readFileSync, _rds = fs.readdirSync;

        fs.readFileSync = function (path) {
            var k = norm(path);
            if (Object.prototype.hasOwnProperty.call(syncCache, k)) return syncCache[k];
            return _rfs.apply(fs, arguments); // saves route here -> NativeFunctions
        };
        fs.readdirSync = function (path) {
            var k = norm(path);
            if (Object.prototype.hasOwnProperty.call(dirCache, k)) return dirCache[k].slice();
            return _rds.apply(fs, arguments);
        };
        fs.__iosPatched = true;
        stat("fs.readFileSync/readdirSync overridden");
    }

    // preload the exact bounded set GTP_OmoriFixes reads synchronously
    function preloadSyncReads() {
        var jobs = [];
        ["data/Notes.yaml", "data/Quests.yaml", "data/Atlas.yaml"].forEach(function (rel) {
            jobs.push(readBundleText(rel).then(function (t) { syncCache[rel] = t; })
                .catch(function () { stat("MISS " + rel); }));
        });
        // Languages: top _DIRECTORY.json -> langs -> each lang's listing + yaml
        var langJob = readBundleText("Languages/_DIRECTORY.json").then(function (t) {
            var langs = JSON.parse(t);
            return Promise.all(langs.map(function (lang) {
                var dir = "Languages/" + lang;
                return readBundleText(dir + "/_DIRECTORY.json").then(function (lt) {
                    var files = JSON.parse(lt);
                    dirCache[dir] = files;
                    return Promise.all(files.filter(function (f) { return /\.yaml$/i.test(f); })
                        .map(function (f) {
                            var rel = dir + "/" + f;
                            return readBundleText(rel).then(function (c) { syncCache[rel] = c; })
                                .catch(function () {});
                        }));
                });
            }));
        }).catch(function (e) { stat("lang preload failed: " + e); });
        jobs.push(langJob);
        return Promise.all(jobs).then(function () {
            stat("preloaded syncFiles=" + Object.keys(syncCache).length +
                 " dirs=" + Object.keys(dirCache).length);
        });
    }

    // quick probe: does async XHR to file:// work? (informs future fixes)
    function probeAsyncXHR() {
        return new Promise(function (resolve) {
            try {
                var x = new XMLHttpRequest();
                x.open("GET", "data/System.json", true);
                x.onload = function () { stat("asyncXHR file:// OK status=" + x.status); resolve(); };
                x.onerror = function () { stat("asyncXHR file:// FAILED"); resolve(); };
                x.send();
            } catch (e) { stat("asyncXHR threw: " + e); resolve(); }
        });
    }

    // =====================================================================
    //  2. Save I/O on documentsDirectory
    // =====================================================================
    function saveName(path) { return baseName(path); }
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
        var NF = {
            __ios: true,
            saveFileExists: function (p) { var e = window._SAYGEXES[saveName(p)]; return !!(e && e.exists); },
            readSaveFileUTF8: function (p) { var e = window._SAYGEXES[saveName(p)]; return (e && e.content != null) ? e.content : null; },
            writeSaveFileUTF8: function (p, data) { var n = saveName(p); cacheSet(n, true, data); writeDocs("save", n, data); },
            writeExternalFileUTF8: function (p, data) { writeDocs(null, saveName(p), data); }
        };
        window.NativeFunctions = NF;
        Object.freeze(window.NativeFunctions);
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

    function preloadSaves() { // Promise
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

    function writeStatus() {
        try { writeDocs(null, "ios_status.txt", statusLines.join("\n")); } catch (e) {}
    }

    // =====================================================================
    //  Boot gate: hold SceneManager.run until caches are warm
    // =====================================================================
    installFsOverride(); // install ASAP (require.libs.fs exists by now)

    var savesReady = false, pendingBoot = null;
    var _run = SceneManager.run.bind(SceneManager);
    SceneManager.run = function (sceneClass) {
        if (savesReady) return _run(sceneClass);
        stat("holding boot until preload done");
        pendingBoot = sceneClass;
    };
    function releaseBoot() {
        if (savesReady) return;
        savesReady = true;
        installFsOverride();
        installNativeFunctions();
        writeStatus();
        if (pendingBoot) { var s = pendingBoot; pendingBoot = null; _run(s); }
    }
    SceneManager.terminate = noop;

    document.addEventListener("deviceready", function () {
        stat("deviceready; docs=" + (cordova.file && cordova.file.documentsDirectory));
        installNativeFunctions();
        installFsOverride();
        Promise.all([preloadSaves(), preloadSyncReads(), probeAsyncXHR()])
            .then(function () { stat("preload complete; saves=" + Object.keys(window._SAYGEXES).length); releaseBoot(); })
            .catch(function (e) { stat("preload error: " + e); releaseBoot(); });
    }, false);

    setTimeout(releaseBoot, 40000); // safety net (preload ~213 lang files)
})();
