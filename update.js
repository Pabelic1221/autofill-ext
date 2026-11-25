const $ = s => document.querySelector(s);
const log = t => { $("#log").textContent += t + "\n"; };

async function refresh() {
  const cfg = await Updater.getCfg();
  const info = (await chrome.storage.local.get("updateInfo")).updateInfo;
  $("#repo").textContent = Updater.repoOk(cfg.repo)
    ? `${cfg.repo} (${cfg.branch}${cfg.path ? "/" + cfg.path : ""})`
    : "not set. Add it in the popup under Settings → Updates";
  $("#ver").textContent = chrome.runtime.getManifest().version +
    (info?.available ? `  →  ${info.remote} available` : "");
  const h = await Updater.getHandle();
  $("#folder").textContent = h ? `Folder: ${h.name}` : "No folder chosen yet";
  let ok = false;
  if (h) { try { ok = (await h.queryPermission({ mode: "readwrite" })) === "granted"; } catch {} }
  $("#perm").textContent = h ? (ok ? "Write access granted" : "Write access needed. Click “Allow write access”.") : "";
  return { h, ok };
}

$("#pick").onclick = async () => {
  try { await Updater.pickFolder(); log("Folder saved."); }
  catch (e) { if (e.name !== "AbortError") log("⚠ " + e.message); }
  refresh();
};
$("#grant").onclick = async () => {
  const h = await Updater.getHandle();
  if (!h) return log("Choose the folder first.");
  log((await Updater.ensurePermission(h, true)) ? "Access granted." : "Access denied.");
  refresh();
};

async function run(force) {
  try {
    log("Checking GitHub…");
    const info = await Updater.check();
    log(`Installed ${info.local}, latest ${info.remote}`);
    if (!info.available && !force) return log("Already up to date.");
    const r = await Updater.apply({ interactive: true, force, onProgress: log });
    if (r.updated) log(`✔ Updated to ${r.version}. The extension will reload.`);
    else log("Nothing to update.");
  } catch (e) {
    log("⚠ " + (e.message === "NEED_FOLDER" ? "Choose your extension folder first."
      : e.message === "NEED_PERMISSION" ? "Allow write access first." : e.message));
  }
  refresh();
}
$("#update").onclick = () => run(false);
$("#force").onclick = () => run(true);

(async () => {
  const { h, ok } = await refresh();
  if (new URLSearchParams(location.search).get("apply") && h && ok) run(false);
})();
