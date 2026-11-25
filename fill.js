(() => {
  if (window.__acf) return;

  const norm = s => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const txt = el => (el?.textContent || "").replace(/\s+/g, " ").trim();
  const SKIP = ["hidden", "submit", "button", "file", "password", "image", "reset"];
  let filled = new WeakSet();
  let undoStack = [];

  // ---------- storage ----------
  const store = () => new Promise(r => chrome.storage.local.get(null, r));
  async function load() {
    const d = await store();
    const ps = d.profiles || [];
    const p = ps.find(p => p.id === d.activeProfile) || ps[0];
    const rules = (p?.rules || [])
      .filter(r => r.enabled !== false && r.keys?.length)
      .map(r => ({ keys: r.keys, value: r.value ?? "" }));
    return { rules, d };
  }

  // ---------- describing fields ----------
  const labelsOf = el => (el.labels ? [...el.labels].map(txt) : []);
  const byIds = ids => (ids || "").split(" ").map(id => txt(document.getElementById(id)));

  function fieldText(el) {
    return [el.id, el.name, el.placeholder, el.title, el.autocomplete,
      el.getAttribute("aria-label"), ...labelsOf(el), ...byIds(el.getAttribute("aria-labelledby"))]
      .map(norm).join(" ");
  }
  function groupText(el) {
    const rg = el.closest('[role="radiogroup"]');
    return [el.name, txt(el.closest("fieldset")?.querySelector("legend")),
      rg?.getAttribute("aria-label"), ...byIds(rg?.getAttribute("aria-labelledby"))]
      .map(norm).join(" ");
  }
  const labelOf = el =>
    (labelsOf(el).find(Boolean) || el.getAttribute("aria-label") || el.placeholder ||
      el.name || el.id || "field").slice(0, 60);
  const groupLabelOf = el =>
    (txt(el.closest("fieldset")?.querySelector("legend")) ||
      el.closest('[role="radiogroup"]')?.getAttribute("aria-label") || el.name || "radio group").slice(0, 60);
  const optLabel = r => labelsOf(r).find(Boolean) || r.value;

  // ---------- targets ----------
  function eligible(el) {
    if (el.disabled || el.readOnly) return false;
    const t = (el.type || "").toLowerCase();
    if (SKIP.includes(t)) return false;
    // skip invisible text fields (often bot honeypots)
    if (t !== "radio" && t !== "checkbox" && !el.getClientRects().length) return false;
    return true;
  }

  function targets() {
    const out = [], seen = new Set();
    for (const el of document.querySelectorAll("input, select, textarea")) {
      if (!eligible(el)) continue;
      const type = (el.type || "").toLowerCase();
      if (type === "radio") {
        if (!el.name) continue;
        const key = [...document.forms].indexOf(el.form) + "|" + el.name;
        if (seen.has(key)) continue;
        seen.add(key);
        const els = [...document.querySelectorAll('input[type="radio"]')]
          .filter(r => r.name === el.name && r.form === el.form);
        out.push({ kind: "radio", el, els, hay: groupText(el), label: groupLabelOf(el), options: els.map(optLabel) });
      } else {
        const kind = type === "checkbox" ? "checkbox" : el.tagName === "SELECT" ? "select" : "text";
        out.push({ kind, el, hay: fieldText(el), label: labelOf(el) });
      }
    }
    return out;
  }

  function matches(rule, el, hay) {
    return rule.keys.some(k => {
      if (k.toLowerCase().startsWith("css:")) {
        try { return el.matches(k.slice(4).trim()); } catch { return false; }
      }
      const n = norm(k);
      return n && hay.includes(n);
    });
  }

  // ---------- applying ----------
  function pickBest(items, answer) {
    const a = norm(answer);
    if (!a) return null;
    return items.find(i => i.names.includes(a)) ||
      items.find(i => i.names.some(n => n && (n.includes(a) || a.includes(n))));
  }

  function setValue(el, value) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function flash(el, d) {
    if (d.highlight === false) return;
    const o = el.style.outline, off = el.style.outlineOffset;
    el.style.outline = "2px solid #6366f1";
    el.style.outlineOffset = "2px";
    setTimeout(() => { el.style.outline = o; el.style.outlineOffset = off; }, 1500);
  }

  function apply(t, value, d) {
    const skip = !!d.skipFilled;

    if (t.kind === "text" || t.kind === "select") {
      const el = t.el, prev = el.value;
      if (skip && t.kind === "text" && prev.trim()) return false;
      if (t.kind === "select") {
        const best = pickBest([...el.options].map(o => ({ o, names: [norm(o.value), norm(o.text)] })), value);
        if (!best) return false;
        setValue(el, best.o.value);
      } else setValue(el, value);
      undoStack.push(() => setValue(el, prev));
      flash(el, d);
      return true;
    }

    if (t.kind === "checkbox") {
      const el = t.el;
      const want = /^(yes|true|1|on|check|checked)$/i.test(value.trim());
      if (skip && el.checked) return false;
      if (el.checked !== want) {
        el.click();
        undoStack.push(() => el.click());
      }
      flash(el.labels?.[0] || el, d);
      return true;
    }

    // radio group
    if (skip && t.els.some(r => r.checked)) return false;
    const best = pickBest(
      t.els.map(r => ({ r, names: [norm(r.value), ...labelsOf(r).map(norm)] })), value);
    if (!best) return false;
    const prev = t.els.find(r => r.checked);
    best.r.click();
    undoStack.push(() => {
      if (prev) prev.click();
      else { best.r.checked = false; best.r.dispatchEvent(new Event("change", { bubbles: true })); }
    });
    flash(best.r.labels?.[0] || best.r, d);
    return true;
  }

  // ---------- public API ----------
  async function fill(opts) {
    const auto = !!opts?.auto;
    const { rules, d } = await load();
    let count = 0;
    for (const t of targets()) {
      if (auto && filled.has(t.el)) continue;
      const rule = rules.find(r => matches(r, t.el, t.hay));
      if (rule && apply(t, rule.value, d)) { filled.add(t.el); count++; }
    }
    return { count };
  }

  function undo() {
    let count = 0;
    while (undoStack.length) { try { undoStack.pop()(); count++; } catch {} }
    filled = new WeakSet();
    return { count };
  }

  async function scan() {
    const { rules } = await load();
    return targets().map(t => ({
      label: t.label, type: t.kind, options: t.options || null,
      matched: rules.some(r => matches(r, t.el, t.hay))
    }));
  }

  window.__acf = { fill, undo, scan };

  // ---------- auto-fill on chosen sites ----------
  function topHost() {
    try {
      const o = location.ancestorOrigins;
      return new URL(o && o.length ? o[o.length - 1] : location.href).hostname;
    } catch { return location.hostname; }
  }
  function siteHit(site) {
    site = (site || "").trim();
    if (!site) return false;
    if (site.includes("/")) return location.href.includes(site);
    const h = topHost();
    return h === site || h.endsWith("." + site);
  }

  (async () => {
    const { d } = await load();
    if (!(d.autoSites || []).some(siteHit)) return;
    await fill({ auto: true });
    let t;
    new MutationObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => fill({ auto: true }), 400); // catches late-loading fields
    }).observe(document.documentElement, { childList: true, subtree: true });
  })();
})();
