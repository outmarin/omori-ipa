// Generates www/js/porting/ios_sync_data.js with the exact set of files the
// engine reads SYNCHRONOUSLY at plugin-load time (before cordova deviceready,
// so the file plugin can't serve them). Embedded so the sync cache is warm
// before any plugin runs.
const fs = require("fs"), path = require("path");
const WWW = process.argv[2] || "www";
const rd = (rel) => fs.readFileSync(path.join(WWW, rel), "utf8");

const files = {}, dirs = {};
function addFile(rel) { try { files[rel] = rd(rel); } catch (e) { console.error("gen: MISS " + rel); } }

["data/Notes.yaml", "data/Quests.yaml", "data/Atlas.yaml"].forEach(addFile);

// helper: record a directory listing in dirs AND embed its _DIRECTORY.json file
function addDir(rel) {
  const list = JSON.parse(rd(rel + "/_DIRECTORY.json"));
  dirs[rel] = list;
  addFile(rel + "/_DIRECTORY.json");
  return list;
}

try {
  addDir("Languages").forEach((lang) => {                 // top listing -> ["en", ...]
    const dir = "Languages/" + lang;
    addDir(dir).filter((f) => /\.yaml$/i.test(f)).forEach((f) => addFile(dir + "/" + f));
  });
} catch (e) { console.error("gen: languages failed " + e); }

try { addDir("img/atlases"); } catch (e) { console.error("gen: img/atlases dir MISS"); }

const out = "window.__IOS_SYNC_FILES=" + JSON.stringify(files) + ";\n" +
            "window.__IOS_SYNC_DIRS=" + JSON.stringify(dirs) + ";\n";
fs.writeFileSync(path.join(WWW, "js/porting/ios_sync_data.js"), out);
console.error("gen_sync_data: files=" + Object.keys(files).length +
              " dirs=" + Object.keys(dirs).length + " bytes=" + out.length);
