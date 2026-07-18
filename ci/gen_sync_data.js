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

try {
  JSON.parse(rd("Languages/_DIRECTORY.json")).forEach((lang) => {
    const dir = "Languages/" + lang;
    const list = JSON.parse(rd(dir + "/_DIRECTORY.json"));
    dirs[dir] = list;
    list.filter((f) => /\.yaml$/i.test(f)).forEach((f) => addFile(dir + "/" + f));
  });
} catch (e) { console.error("gen: languages failed " + e); }

try { dirs["img/atlases"] = JSON.parse(rd("img/atlases/_DIRECTORY.json")); } catch (e) { console.error("gen: img/atlases dir MISS"); }

const out = "window.__IOS_SYNC_FILES=" + JSON.stringify(files) + ";\n" +
            "window.__IOS_SYNC_DIRS=" + JSON.stringify(dirs) + ";\n";
fs.writeFileSync(path.join(WWW, "js/porting/ios_sync_data.js"), out);
console.error("gen_sync_data: files=" + Object.keys(files).length +
              " dirs=" + Object.keys(dirs).length + " bytes=" + out.length);
