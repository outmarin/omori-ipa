//=============================================================================
// ios_compat.js  — iOS / LiveContainer compatibility layer for OMORI (Cordova)
//
// Injected into index.html as a plain <script> right after js/main.js, so it
// runs synchronously before window.onload -> the boot gate is installed before
// SceneManager.run() is ever called.
//
// Does three things on iOS only:
//   1. Stub Android-only APIs so the Android port layer doesn't throw.
//   2. Reimplement NativeFunctions (save I/O) on cordova-plugin-file using
//      cordova.file.documentsDirectory (LiveContainer-safe, visible in Files),
//      then FREEZE it so VND_CordovaFixes' Android impl can't clobber it.
//   3. Preload existing saves into the _SAYGEXES cache BEFORE the game boots,
//      so the engine's synchronous cold reads (title global info, slot load)
//      hit the cache instead of a blocked file:// XHR.
//=============================================================================

(function () {
    "use strict";

    var isIOS = (typeof cordova !== "undefined" && cordova.platformId === "ios");
    if (!isIOS) return;

    console.log("[ios_compat] active");

    var noop = function () {};

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

    // ---- save cache (flat, keyed by filename) ----------------------------
    function saveName(path) {
        // engine passes ".../save/file1.rpgsave" -> "file1.rpgsave"
        return String(path).split(/[\\/]/).filter(Boolean).pop();
    }
    window._SAYGEXES = window._SAYGEXES || {};
    function cacheGet(name) { return window._SAYGEXES[name]; }
    function cacheSet(name, exists, content) {
        var e = window._SAYGEXES[name] || {};
        if (exists !== undefined) e.exists = exists;
        if (content !== undefined) e.content = content;
        window._SAYGEXES[name] = e;
    }

    // ---- 2. iOS NativeFunctions ------------------------------------------
    function installNativeFunctions() {
        if (window.NativeFunctions && window.NativeFunctions.__ios) return;
        StorageManager.isLocalMode = function () { return true; };
        var NF = {
            __ios: true,
            saveFileExists: function (path) {
                var e = cacheGet(saveName(path));
                return !!(e && e.exists);
            },
            readSaveFileUTF8: function (path) {
                var e = cacheGet(saveName(path));
                return (e && e.content != null) ? e.content : null;
            },
            writeSaveFileUTF8: function (path, data) {
                var name = saveName(path);
                cacheSet(name, true, data);      // synchronous source of truth
                writeToDisk("save", name, data); // async persist
            },
            writeExternalFileUTF8: function (path, data) {
                writeToDisk(null, saveName(path), data);
            }
        };
        window.NativeFunctions = NF;
        Object.freeze(window.NativeFunctions); // block VND's Android override
        console.log("[ios_compat] NativeFunctions installed + frozen (documentsDirectory)");
    }

    // resolve documentsDirectory/[subdir]/name and write UTF-8 text
    function writeToDisk(subdir, name, data) {
        window.resolveLocalFileSystemURL(cordova.file.documentsDirectory, function (root) {
            function putFile(dir) {
                dir.getFile(name, { create: true, exclusive: false }, function (fileEntry) {
                    fileEntry.createWriter(function (w) {
                        var blob = new Blob([data], { type: "text/plain" });
                        var wrote = false;
                        w.onerror = function (e) { console.error("[ios_compat] write error", name, e); };
                        w.onwriteend = function () { if (!wrote) { wrote = true; w.write(blob); } };
                        w.truncate(0); // clear then write, so shorter saves leave no tail
                    });
                }, function (e) { console.error("[ios_compat] getFile error", name, e); });
            }
            if (subdir) {
                root.getDirectory(subdir, { create: true }, putFile,
                    function (e) { console.error("[ios_compat] getDirectory error", subdir, e); });
            } else {
                putFile(root);
            }
        }, function (e) { console.error("[ios_compat] resolve documentsDirectory failed", e); });
    }

    // ---- 3. Preload saves into cache, then release the boot gate ----------
    function preloadSaves(done) {
        window.resolveLocalFileSystemURL(cordova.file.documentsDirectory, function (root) {
            root.getDirectory("save", { create: true }, function (saveDir) {
                saveDir.createReader().readEntries(function (entries) {
                    var files = entries.filter(function (en) { return en.isFile; });
                    if (!files.length) { console.log("[ios_compat] no existing saves"); return done(); }
                    var pending = files.length;
                    files.forEach(function (fe) {
                        fe.file(function (file) {
                            var r = new FileReader();
                            r.onloadend = function () {
                                cacheSet(fe.name, true, r.result);
                                if (--pending === 0) { console.log("[ios_compat] preloaded", files.length, "saves"); done(); }
                            };
                            r.readAsText(file);
                        }, function () { if (--pending === 0) done(); });
                    });
                }, function (e) { console.error("[ios_compat] readEntries failed", e); done(); });
            }, function (e) { console.error("[ios_compat] save dir failed", e); done(); });
        }, function (e) { console.error("[ios_compat] resolve failed", e); done(); });
    }

    // ---- boot gate: defer SceneManager.run until saves are preloaded ------
    var savesReady = false;
    var pendingBoot = null;
    var _run = SceneManager.run.bind(SceneManager);
    SceneManager.run = function (sceneClass) {
        if (savesReady) return _run(sceneClass);
        console.log("[ios_compat] holding boot until saves preloaded");
        pendingBoot = sceneClass;
    };
    function releaseBoot() {
        if (savesReady) return;
        savesReady = true;
        installNativeFunctions(); // last-chance: ensure ours is live before first read
        var n = Object.keys(window._SAYGEXES).length;
        writeStatus("ios_compat OK; platform=" + cordova.platformId +
                    "; preloadedSaves=" + n + "; docs=" + (cordova.file && cordova.file.documentsDirectory));
        if (pendingBoot) { var s = pendingBoot; pendingBoot = null; _run(s); }
    }

    // single status file in documentsDirectory so CI can confirm we ran
    function writeStatus(text) {
        try { writeToDisk(null, "ios_status.txt", text); } catch (e) {}
    }

    SceneManager.terminate = noop; // iOS apps don't self-terminate

    document.addEventListener("deviceready", function () {
        installNativeFunctions();
        preloadSaves(releaseBoot);
    }, false);

    setTimeout(releaseBoot, 8000); // safety net: never hang on cordova failure
})();
