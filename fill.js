(() => {
  if (window.__acf) return;

  const norm = s => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const txt = el => (el?.textContent || "").replace(/\s+/g, " ").trim();
  const SKIP = ["hidden", "submit", "button", "file", "password", "image", "reset"];
  let filled = new WeakSet();
  let undoStack = [];

  // ---------- storage ----------
  const store = () => new Promise(r => chrome.storage.local.get(null, r));
  async function load(profileId) {
    const d = await store();
    const ps = d.profiles || [];
    const p = ps.find(p => p.id === profileId) || ps.find(p => p.id === d.activeProfile) || ps[0];
    const rules = (p?.rules || [])
      .filter(r => r.enabled !== false && r.keys?.length)
      .map(r => ({ id: r.id, keys: r.keys, value: r.value ?? "", concepts: conceptsOfRule(r.keys) }));
    return { rules, d };
  }

  // ---------- describing fields ----------
  const labelsOf = el => (el.labels ? [...el.labels].map(txt) : []);
  const byIds = ids => (ids || "").split(" ").filter(Boolean).map(id => txt(document.getElementById(id)));

  // raw strings that describe a field / a radio group (id, name, label, placeholder…)
  const fieldRaw = el => [el.id, el.name, el.placeholder, el.title, el.autocomplete,
    el.getAttribute("aria-label"), ...labelsOf(el), ...byIds(el.getAttribute("aria-labelledby"))].filter(Boolean);
  const groupRaw = el => {
    const rg = el.closest('[role="radiogroup"]');
    return [el.name, txt(el.closest("fieldset")?.querySelector("legend")),
      rg?.getAttribute("aria-label"), ...byIds(rg?.getAttribute("aria-labelledby"))].filter(Boolean);
  };
  const labelOf = el =>
    (labelsOf(el).find(Boolean) || el.getAttribute("aria-label") || el.placeholder ||
      el.name || el.id || "field").slice(0, 60);
  const groupLabelOf = el =>
    (txt(el.closest("fieldset")?.querySelector("legend")) ||
      el.closest('[role="radiogroup"]')?.getAttribute("aria-label") || el.name || "radio group").slice(0, 60);
  const optLabel = r => labelsOf(r).find(Boolean) || r.value;
  const mk = raw => { const pieces = raw.map(norm); return { raw, pieces, hay: pieces.join(" ") }; };

  // ---------- smart matching: synonyms, autocomplete hints, typos ----------
  const CONCEPTS = {
    firstname:   { label: "first name",     syn: ["firstname","namefirst","fname","givenname","forename","firstnm"], ac: ["given-name"] },
    middlename:  { label: "middle name",    syn: ["middlename","namemiddle","mname","middleinitial","middleinit"], ac: ["additional-name"] },
    lastname:    { label: "last name",      syn: ["lastname","namelast","lname","surname","familyname","lastnm"], ac: ["family-name"] },
    fullname:    { label: "full name",      syn: ["name","fullname","completename","yourname","applicantname","customername","contactname"], ac: ["name"] },
    email:       { label: "email",          syn: ["email","emailaddress","emailid","eaddress","emailadd"], ac: ["email"], types: ["email"] },
    phone:       { label: "phone",          syn: ["phone","phonenumber","phoneno","mobile","mobilenumber","mobileno","cellphone","cellnumber","contactnumber","contactno","telephone","telephonenumber","telno","tel"], ac: ["tel","tel-national"], types: ["tel"] },
    address:     { label: "address",        syn: ["address","streetaddress","address1","addressline1","addr","homeaddress","residentialaddress","street"], ac: ["street-address","address-line1"] },
    address2:    { label: "address line 2", syn: ["address2","addressline2","apartment","apt","suite"], ac: ["address-line2"] },
    barangay:    { label: "barangay",       syn: ["barangay","brgy"] },
    city:        { label: "city",           syn: ["city","town","municipality","cityortown","citymunicipality"], ac: ["address-level2"] },
    state:       { label: "state / province", syn: ["state","province","region","stateprovince","stateorprovince"], ac: ["address-level1"] },
    zip:         { label: "postal code",    syn: ["zip","zipcode","postal","postalcode","postcode"], ac: ["postal-code"] },
    country:     { label: "country",        syn: ["country","nation","countryregion"], ac: ["country","country-name"] },
    birthdate:   { label: "birth date",     syn: ["birthdate","dateofbirth","dob","birthday","bday","birthdaydate"], ac: ["bday"] },
    age:         { label: "age",            syn: ["age"] },
    gender:      { label: "gender",         syn: ["gender","sex"], ac: ["sex"] },
    civilstatus: { label: "civil status",   syn: ["civilstatus","maritalstatus","marital"] },
    nationality: { label: "nationality",    syn: ["nationality","citizenship"] },
    company:     { label: "company",        syn: ["company","companyname","organization","organisation","employer","businessname"], ac: ["organization"] },
    jobtitle:    { label: "job title",      syn: ["jobtitle","position","occupation","designation","profession"], ac: ["organization-title"] },
    username:    { label: "username",       syn: ["username","userid","loginname","handle"], ac: ["username"] },
    website:     { label: "website",        syn: ["website","websiteurl","url","homepage"], ac: ["url"], types: ["url"] },
    message:     { label: "message",        syn: ["message","comments","comment","remarks","notes","additionalinformation"] },
    subject:     { label: "subject",        syn: ["subject","topic"] }
  };
  // never auto-match these by synonym (payment / security fields)
  const SENSITIVE = ["card","cardnumber","creditcard","cvv","cvc","ccnumber","iban","ssn","otp","captcha","securitycode","expiry","expiration"];

  // split "firstName", "first_name", "ctl00_txtFirstName" into words
  const tokens = s => (s || "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

  // every run of up to 4 neighbouring words, joined: "enter your first name" -> "firstname", "yourfirst"…
  function runsOf(strs) {
    const runs = new Set();
    for (const s of strs) {
      const tk = tokens(s);
      for (let i = 0; i < tk.length; i++) {
        let acc = "";
        for (let j = i; j < tk.length && j < i + 4; j++) { acc += tk[j]; runs.add(acc); }
      }
    }
    return runs;
  }

  // which concept(s) fit best? (longest synonym wins, so "email address" is email, not address)
  function scoreConcepts(runs, ac, itype, isText) {
    const score = new Map(), via = new Map();
    const bump = (c, sc, how) => { if (sc > (score.get(c) || 0)) { score.set(c, sc); via.set(c, how); } };
    for (const [c, def] of Object.entries(CONCEPTS)) {
      if (def.ac && def.ac.some(x => ac.includes(x))) bump(c, 100, "autocomplete");
      if (isText && def.types && def.types.includes(itype)) bump(c, 90, "type");
      for (const syn of def.syn) if (runs.has(syn)) bump(c, syn.length, "synonym");
    }
    const max = Math.max(0, ...score.values());
    const win = new Set([...score].filter(([, v]) => v === max).map(([c]) => c));
    return { win, via };
  }

  function conceptsOf(t) {
    if (t.fc) return t.fc;
    const runs = runsOf(t.raw);
    if (SENSITIVE.some(x => runs.has(x))) return (t.fc = { win: new Set(), via: new Map() });
    const ac = (t.el.getAttribute("autocomplete") || "").toLowerCase().split(/\s+/);
    return (t.fc = scoreConcepts(runs, ac, (t.el.type || "").toLowerCase(), t.kind === "text"));
  }

  function conceptsOfRule(keys) {
    const out = new Set();
    for (const k of keys) {
      if (/^css:/i.test(k)) continue;
      scoreConcepts(runsOf([k]), [], "", false).win.forEach(c => out.add(c));
    }
    return out;
  }

  function lev(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i]; let rowMin = i;
      for (let j = 1; j <= b.length; j++) {
        const c = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        cur[j] = c; if (c < rowMin) rowMin = c;
      }
      if (rowMin > max) return max + 1;
      prev = cur;
    }
    return prev[b.length];
  }

  // key (≥6 chars) appears in piece allowing 1–2 typos; first letter must agree ("gender" ≠ "sender")
  function fuzzyIn(key, piece) {
    const max = key.length >= 11 ? 2 : 1;
    for (let L = key.length - max; L <= key.length + max; L++)
      for (let i = 0; i + L <= piece.length; i++) {
        if (piece[i] !== key[0]) continue;
        if (lev(key, piece.slice(i, i + L), max) <= max) return true;
      }
    return false;
  }

  const directHit = (r, t) => r.keys.some(k => !/^css:/i.test(k) && norm(k) && t.hay.includes(norm(k)));

  function similarHit(r, t) {
    const fieldToks = new Set(t.raw.flatMap(tokens));
    return r.keys.some(k => {
      if (/^css:/i.test(k)) return false;
      const tk = tokens(k), n = norm(k);
      if (tk.length >= 2 && tk.every(x => fieldToks.has(x))) return true;   // same words, other order
      return n.length >= 6 && t.pieces.some(p => fuzzyIn(n, p));            // small typos
    });
  }

  // the field is clearly something else than what the rule is about
  const conflicts = (r, fc) => r.concepts.size && fc.win.size && ![...r.concepts].some(c => fc.win.has(c));

  // returns { rule, how } where how = selector | autocomplete | type | name | synonym | similar
  function findRule(rules, t, smart) {
    for (const r of rules)
      for (const k of r.keys)
        if (/^css:/i.test(k)) { try { if (t.el.matches(k.slice(4).trim())) return { rule: r, how: "selector" }; } catch {} }

    if (!smart) {
      const r = rules.find(r => directHit(r, t));
      return r ? { rule: r, how: "name" } : null;
    }
    const fc = conceptsOf(t);
    for (const r of rules)
      for (const c of r.concepts)
        if (fc.win.has(c)) return { rule: r, how: directHit(r, t) ? "name" : fc.via.get(c) };
    for (const r of rules) if (!conflicts(r, fc) && directHit(r, t)) return { rule: r, how: "name" };
    for (const r of rules) if (!conflicts(r, fc) && similarHit(r, t)) return { rule: r, how: "similar" };
    return null;
  }

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
        out.push({ kind: "radio", el, els, ...mk(groupRaw(el)), label: groupLabelOf(el), options: els.map(optLabel) });
      } else {
        const kind = type === "checkbox" ? "checkbox" : el.tagName === "SELECT" ? "select" : "text";
        const t = { kind, el, ...mk(fieldRaw(el)), label: labelOf(el), itype: type || el.tagName.toLowerCase() };
        if (kind === "select")
          t.options = [...el.options].filter(o => o.value !== "" && !o.disabled).map(o => txt(o)).filter(Boolean);
        if (kind === "checkbox") t.options = ["Yes", "No"];
        out.push(t);
      }
    }
    return out;
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

  // would this answer pick a real option? (dry run, changes nothing)
  function resolves(t, value) {
    if (t.kind === "select")
      return !!pickBest([...t.el.options].map(o => ({ names: [norm(o.value), norm(o.text)] })), value);
    if (t.kind === "radio")
      return !!pickBest(t.els.map(r => ({ names: [norm(r.value), ...labelsOf(r).map(norm)] })), value);
    return true;
  }

  // ---------- public API ----------
  async function fill(opts) {
    const auto = !!opts?.auto;
    const { rules, d } = await load(opts?.profileId);
    let count = 0;
    for (const t of targets()) {
      if (auto && filled.has(t.el)) continue;
      const hit = findRule(rules, t, d.smart !== false);
      if (hit && apply(t, hit.rule.value, d)) { filled.add(t.el); count++; }
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
    const { rules, d } = await load();
    return targets().map(t => {
      const hit = findRule(rules, t, d.smart !== false);
      const c = [...conceptsOf(t).win][0];
      return {
        label: t.label, type: t.kind, itype: t.itype || "", options: t.options || null,
        concept: c ? CONCEPTS[c].label : null,
        matched: !!hit, how: hit?.how || null, ruleId: hit?.rule.id || null,
        value: hit ? hit.rule.value : null,
        resolved: hit ? resolves(t, hit.rule.value) : null
      };
    });
  }

  window.__acf = { fill, undo, scan, buttons: listButtons };

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

  // ---------- clickable buttons (for "then click Next") ----------
  const CLICKABLE = 'button, input[type=submit], input[type=button], [role=button], a';
  const clickLabel = el =>
    (txt(el) || el.value || el.getAttribute("aria-label") || el.title || "").trim();

  function findClickable(spec) {
    spec = (spec || "").trim();
    if (!spec) return null;
    if (spec.toLowerCase().startsWith("css:")) {
      try { return document.querySelector(spec.slice(4).trim()); } catch { return null; }
    }
    const q = norm(spec);
    const els = [...document.querySelectorAll(CLICKABLE)].filter(e => e.getClientRects().length && !e.disabled);
    return els.find(e => norm(clickLabel(e)) === q) || els.find(e => norm(clickLabel(e)).includes(q));
  }

  function listButtons() {
    const seen = new Set();
    return [...document.querySelectorAll('button, input[type=submit], input[type=button], [role=button]')]
      .filter(e => e.getClientRects().length)
      .map(clickLabel)
      .filter(l => l && l.length <= 40 && !seen.has(l) && seen.add(l))
      .slice(0, 15);
  }

  // ---------- flows: fill each page in turn, optionally click Next ----------
  const sget = k => { try { return sessionStorage.getItem(k); } catch { return null; } };
  const sset = (k, v) => { try { sessionStorage.setItem(k, v); } catch {} };
  const badge = n => { try { chrome.runtime.sendMessage({ type: "badge", n }); } catch {} };

  function scheduleClick(flow, step) {
    const key = `acf:${flow.id}:${step.id}`;
    let st; try { st = JSON.parse(sget(key)) || {}; } catch { st = {}; }
    const now = Date.now();
    if (now - (st.t || 0) > 60000) st.n = 0;                    // fresh attempt after a pause
    if (now - (st.t || 0) < 4000 || (st.n || 0) >= 3) return;   // loop guards
    sset(key, JSON.stringify({ t: now, n: (st.n || 0) + 1 }));
    setTimeout(() => {
      const b = findClickable(step.click);
      if (b && !b.disabled) b.click();
    }, Math.max(200, +step.delay || 1000));
  }

  async function tick() {
    const { d } = await load();
    const flow = (d.flows || []).find(f => f.enabled !== false && (f.steps || []).length && siteHit(f.site));
    // most specific matching step wins (longest URL fragment)
    const step = flow && flow.steps
      .filter(s => !s.url || location.href.includes(s.url))
      .sort((a, b) => (b.url || "").length - (a.url || "").length)[0];
    let count = 0;
    if (step) {
      count = (await fill({ auto: true, profileId: step.profileId })).count;
      if (count && step.click) scheduleClick(flow, step);
    } else if ((d.autoSites || []).some(siteHit)) {
      count = (await fill({ auto: true })).count;
    }
    if (count) badge(count);
  }

  (async () => {
    const { d } = await load();
    const watch = (d.autoSites || []).some(siteHit) ||
      (d.flows || []).some(f => f.enabled !== false && siteHit(f.site));
    if (!watch) return;
    await tick();
    let t;
    const later = () => { clearTimeout(t); t = setTimeout(tick, 400); };
    new MutationObserver(later).observe(document.documentElement, { childList: true, subtree: true });
    addEventListener("popstate", later);
    addEventListener("hashchange", later);
  })();
})();
