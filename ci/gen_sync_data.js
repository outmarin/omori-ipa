// Generates www/js/porting/ios_sync_data.js — the data the engine reads
// SYNCHRONOUSLY (readFileSync/readdirSync), which on iOS means blocked file://
// XHR. Embedded as JS so the sync caches are warm before any plugin runs.
//
//  * every _DIRECTORY.json (41 tiny files) -> readdirSync works for any dir.
//    VND_OmoriFixes hooks Bitmap._requestImage -> cachedAlternativeName ->
//    readdirSync(imageDir) for EVERY image, so all image dirs need listings.
//  * data/*.yaml + Languages/<lang>/*.yaml -> read at plugin-load.
const fs = require("fs"), path = require("path");
const WWW = process.argv[2] || "www";
const rd = (rel) => fs.readFileSync(path.join(WWW, rel), "utf8");
const dirOf = (rel) => rel.slice(0, rel.lastIndexOf("/")); // forward-slash keys

const files = {}, dirs = {};
function addFile(rel) { try { files[rel] = rd(rel); } catch (e) { console.error("gen: MISS " + rel); } }

// 1. walk www, embed every _DIRECTORY.json + its parsed listing
function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(path.join(WWW, dir || "."), { withFileTypes: true }); }
  catch (e) { return; }
  for (const e of entries) {
    const rel = dir ? dir + "/" + e.name : e.name;
    if (e.isDirectory()) walk(rel);
    else if (e.name === "_DIRECTORY.json") {
      addFile(rel);
      try { dirs[dirOf(rel)] = JSON.parse(rd(rel)); } catch (_) {}
    }
  }
}
walk("");

// 2. yaml files read synchronously at plugin-load time
["data/Notes.yaml", "data/Quests.yaml", "data/Atlas.yaml"].forEach(addFile);
try {
  JSON.parse(rd("Languages/_DIRECTORY.json")).forEach((lang) => {
    const dir = "Languages/" + lang;
    JSON.parse(rd(dir + "/_DIRECTORY.json"))
      .filter((f) => /\.yaml$/i.test(f)).forEach((f) => addFile(dir + "/" + f));
  });
} catch (e) { console.error("gen: languages failed " + e); }

const out = "window.__IOS_SYNC_FILES=" + JSON.stringify(files) + ";\n" +
            "window.__IOS_SYNC_DIRS=" + JSON.stringify(dirs) + ";\n";
fs.writeFileSync(path.join(WWW, "js/porting/ios_sync_data.js"), out);
console.error("gen_sync_data: files=" + Object.keys(files).length +
              " dirs=" + Object.keys(dirs).length + " bytes=" + out.length);
