// Shared by the background worker, the popup and update.html
(() => {
  const root = typeof self !== "undefined" ? self : window;
  const DEFAULTS = { repo: "", branch: "main", path: "", token: "", autoCheck: true, autoApply: true };

  const getCfg = async () => ({ ...DEFAULTS, ...((await chrome.storage.local.get("gh")).gh || {}) });
  const clean = p => (p || "").replace(/^\/+|\/+$/g, "");
  const repoOk = r => /^[\w.-]+\/[\w.-]+$/.test(r || "");
  const enc = p => p.split("/").map(encodeURIComponent).join("/");

  function cmp(a, b) {
    const x = String(a).split(".").map(n => parseInt(n, 10) || 0);
    const y = String(b).split(".").map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const d = (x[i] || 0) - (y[i] || 0);
      if (d) return d > 0 ? 1 : -1;
    }
    return 0;
  }

  async function gh(cfg, url, raw = false) {
    const headers = {
      Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    };
    if (cfg.token) headers.Authorization = "Bearer " + cfg.token;
    const r = await fetch("https://api.github.com" + url, { headers, cache: "no-store" });
    if (!r.ok) {
      const hint = r.status === 404 ? " (check repo, branch and folder, or add a token for a private repo)"
        : r.status === 403 ? " (rate limited, or the token lacks access)"
        : r.status === 401 ? " (bad token)" : "";
      throw new Error(`GitHub ${r.status}${hint}`);
    }
    return r;
  }
  const contentsUrl = (cfg, path) => `/repos/${cfg.repo}/contents/${enc(path)}?ref=${encodeURIComponent(cfg.branch)}`;

  // ---- is there a newer version in the repo? ----
  async function check() {
    const cfg = await getCfg();
    if (!repoOk(cfg.repo)) throw new Error("Enter your repository as owner/name");
    const local = chrome.runtime.getManifest().version;
    const path = [clean(cfg.path), "manifest.json"].filter(Boolean).join("/");
    const remote = await (await gh(cfg, contentsUrl(cfg, path), true)).json();
    const info = { local, remote: remote.version, available: cmp(remote.version, local) > 0, checkedAt: Date.now() };
    await chrome.storage.local.set({ updateInfo: info });
    try {
      await chrome.action.setBadgeText({ text: info.available ? "↑" : "" });
      if (info.available) await chrome.action.setBadgeBackgroundColor({ color: "#d97706" });
    } catch {}
    return info;
  }

  // ---- remembered extension folder (File System Access handle in IndexedDB) ----
  const idb = () => new Promise((res, rej) => {
    const r = indexedDB.open("autofill-updater", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("h");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const getHandle = async () => {
    const db = await idb();
    return new Promise((res, rej) => {
      const q = db.transaction("h").objectStore("h").get("dir");
      q.onsuccess = () => res(q.result || null);
      q.onerror = () => rej(q.error);
    });
  };
  const setHandle = async h => {
    const db = await idb();
    return new Promise((res, rej) => {
      const q = db.transaction("h", "readwrite").objectStore("h").put(h, "dir");
      q.onsuccess = () => res();
      q.onerror = () => rej(q.error);
    });
  };
  async function ensurePermission(h, ask) {
    const opt = { mode: "readwrite" };
    if ((await h.queryPermission(opt)) === "granted") return true;
    return ask ? (await h.requestPermission(opt)) === "granted" : false;
  }
  async function pickFolder() {                       // window context only
    const h = await showDirectoryPicker({ id: "autofill-ext", mode: "readwrite" });
    let mf;
    try { mf = JSON.parse(await (await (await h.getFileHandle("manifest.json")).getFile()).text()); }
    catch { throw new Error("That folder has no manifest.json. Pick the folder you used for “Load unpacked”."); }
    if (mf.name !== chrome.runtime.getManifest().name) throw new Error("That folder belongs to a different extension.");
    await setHandle(h);
    return h;
  }

  async function writeFile(dir, rel, data) {
    if (rel.split("/").includes("..")) throw new Error("Unsafe path in repo: " + rel);
    const parts = rel.split("/"), name = parts.pop();
    let d = dir;
    for (const p of parts) d = await d.getDirectoryHandle(p, { create: true });
    const w = await (await d.getFileHandle(name, { create: true })).createWritable();
    await w.write(data);
    await w.close();
  }

  // ---- download the repo files, write them into the folder, reload ----
  async function apply(opts = {}) {
    const { interactive = false, force = false, onProgress = () => {} } = opts;
    const cfg = await getCfg();
    if (!repoOk(cfg.repo)) throw new Error("Enter your repository as owner/name");
    const dir = opts.dir || await getHandle();
    if (!dir) throw new Error("NEED_FOLDER");
    if (!(await ensurePermission(dir, interactive))) throw new Error("NEED_PERMISSION");

    onProgress("Listing files…");
    const prefix = clean(cfg.path);
    const tree = await (await gh(cfg, `/repos/${cfg.repo}/git/trees/${encodeURIComponent(cfg.branch)}?recursive=1`)).json();
    if (tree.truncated) throw new Error("Repository is too large to list");
    const files = tree.tree
      .filter(n => n.type === "blob" && (!prefix || n.path.startsWith(prefix + "/")))
      .map(n => ({ path: n.path, rel: prefix ? n.path.slice(prefix.length + 1) : n.path }))
      .filter(f => !/(^|\/)\./.test(f.rel) && !/^(README|LICENSE)/i.test(f.rel));
    if (!files.some(f => f.rel === "manifest.json")) throw new Error("manifest.json not found in the repo folder");

    // download everything first, so a failed download never leaves a half-updated folder
    const got = [];
    for (const f of files) {
      onProgress(`Downloading ${f.rel}`);
      got.push({ rel: f.rel, data: await (await gh(cfg, contentsUrl(cfg, f.path), true)).arrayBuffer() });
    }
    const mfFile = got.find(g => g.rel === "manifest.json");
    const newMf = JSON.parse(new TextDecoder().decode(mfFile.data));
    const cur = chrome.runtime.getManifest();
    if (newMf.name !== cur.name) throw new Error("The repo's manifest is for a different extension");
    if (!force && cmp(newMf.version, cur.version) <= 0) return { updated: false, version: cur.version };

    for (const g of got.filter(g => g !== mfFile)) { onProgress(`Writing ${g.rel}`); await writeFile(dir, g.rel, g.data); }
    onProgress("Writing manifest.json");
    await writeFile(dir, "manifest.json", mfFile.data);          // manifest last
    await chrome.storage.local.set({ updateInfo: { local: newMf.version, remote: newMf.version, available: false, checkedAt: Date.now() } });
    try { await chrome.action.setBadgeText({ text: "" }); } catch {}
    onProgress("Reloading…");
    setTimeout(() => chrome.runtime.reload(), 300);
    return { updated: true, version: newMf.version };
  }

  root.Updater = { getCfg, check, apply, pickFolder, getHandle, ensurePermission, cmp, repoOk, DEFAULTS };
})();
