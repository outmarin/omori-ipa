# OMORI (RU) — iOS / LiveContainer port

RPG Maker MV + Cordova game repackaged from the Android APK into an unsigned iOS `.ipa`.

- Game assets (`www/`) are extracted from the APK at build time (APK lives in release `v1`, not in git).
- `ios-patches/ios_compat.js` — iOS save layer (cordova-plugin-file, `documentsDirectory`) + Android-API stubs.
- `.github/workflows/build.yml` — builds on a macOS runner, verifies in the iOS Simulator (screenshots + logs), and packages an unsigned `OMORI.ipa` for LiveContainer.

Trigger a build: **Actions → build-ios → Run workflow**. Download `OMORI.ipa` from the run artifacts.
