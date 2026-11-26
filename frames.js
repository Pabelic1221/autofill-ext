// Runs a function from fill.js in every frame of a tab, one frame at a time with a timeout,
// so a slow or stuck frame (like a modal's iframe) can't freeze everything.
(() => {
  const root = typeof self !== "undefined" ? self : window;
  const timeout = (p, ms) => Promise.race([p, new Promise(res => setTimeout(() => res({ __timeout: true }), ms))]);
  const short = u => {
    try { const x = new URL(u); return x.protocol.startsWith("http") ? (x.pathname.length > 1 ? x.pathname : x.host) : u.slice(0, 30); }
    catch { return (u || "").slice(0, 30); }
  };

  async function list(tabId) {
    let frames = [];
    try { frames = (await chrome.webNavigation.getAllFrames({ tabId })) || []; } catch {}
    frames = frames.filter(f => !f.errorOccurred && !/^(chrome|chrome-extension|devtools|chrome-error):/.test(f.url || ""));
    if (!frames.length) frames = [{ frameId: 0, url: "" }];
    return frames.map(f => ({ id: f.frameId, url: f.url || "", name: f.frameId === 0 ? "Top page" : short(f.url) }));
  }

  async function runOne(tabId, f, name, arg) {
    const target = { tabId, frameIds: [f.id] };
    const call = () => chrome.scripting.executeScript({
      target, func: (n, a) => (window.__acf ? window.__acf[n](a) : null), args: [name, arg ?? null]
    });
    try {
      let r = await timeout(call(), 4000);
      if (r.__timeout) return { frame: f, status: "timeout" };
      let v = r[0]?.result;
      if (v == null) {   // script isn't in this frame yet (about:blank, written by script, or opened before an update)
        const inj = await timeout(chrome.scripting.executeScript({ target, files: ["fill.js"] }), 3000);
        if (inj.__timeout) return { frame: f, status: "timeout" };
        r = await timeout(call(), 4000);
        if (r.__timeout) return { frame: f, status: "timeout" };
        v = r[0]?.result;
      }
      return v == null ? { frame: f, status: "unavailable" } : { frame: f, status: "ok", value: v };
    } catch (e) {
      return { frame: f, status: "error", error: String((e && e.message) || e) };
    }
  }

  async function run(tabId, name, arg, onlyFrame) {
    let frames = await list(tabId);
    if (onlyFrame != null && onlyFrame !== "all") frames = frames.filter(f => String(f.id) === String(onlyFrame));
    const results = await Promise.all(frames.map(f => runOne(tabId, f, name, arg)));
    root.Frames.last = results;
    return results;
  }

  root.Frames = { list, run, last: [] };
})();
