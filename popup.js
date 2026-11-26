const $ = s => document.querySelector(s);
const uid = () => Math.random().toString(36).slice(2, 9);
const h = (tag, props = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v);
  }
  kids.flat().forEach(c => el.append(c));
  return el;
};

const defaults = () => {
  const id = uid();
  const r = (keys, value) => ({ id: uid(), keys, value, enabled: true });
  return {
    activeProfile: id, autoSites: [], skipFilled: false, highlight: true,
    profiles: [{ id, name: "Default", rules: [
      r(["first name", "fname", "given name"], "Juan"),
      r(["last name", "lname", "surname"], "Dela Cruz"),
      r(["email", "e-mail"], "juan@example.com"),
      r(["phone", "mobile", "contact number"], "09123456789"),
      r(["gender", "sex"], "Male"),
      r(["newsletter", "subscribe"], "yes")
    ] }]
  };
};

let S, host = null, tabUrl = "";
const persist = () => chrome.storage.local.set(S);
const profile = () => S.profiles.find(p => p.id === S.activeProfile) || S.profiles[0];

function status(msg, kind = "") {
  const el = $("#status");
  el.textContent = msg;
  el.className = kind;
}

let frameSel = "all";
async function inPage(name, arg) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const res = await Frames.run(tab.id, name, arg, frameSel);
    return res.filter(r => r.status === "ok").map(r => r.value);
  } catch { return []; }
}

// "3/4 frames reachable (modal: timeout)" so you can see why something wasn't found
function frameNote() {
  const rs = Frames.last || [];
  if (!rs.length) return "";
  const bad = rs.filter(r => r.status !== "ok");
  return `${rs.length - bad.length}/${rs.length} frames reachable` +
    (bad.length ? ` (${bad.map(r => `${r.frame.name}: ${r.status}`).join(", ")})` : "");
}

/* ---------- tabs ---------- */
let scanned = false;
function showTab(name) {
  if (name === "detected" && !scanned) { scanned = true; setTimeout(() => $("#scan").click(), 0); }   // auto-scan on first open
  document.querySelectorAll(".tabs button").forEach(b => b.classList.toggle("on", b.dataset.tab === name));
  document.querySelectorAll("main > section").forEach(s => (s.hidden = s.id !== "tab-" + name));
}
document.querySelectorAll(".tabs button").forEach(b => (b.onclick = () => showTab(b.dataset.tab)));

/* ---------- rules ---------- */
function ruleCard(rule) {
  const chips = h("div", { class: "chips" });
  const chip = text => h("span", { class: "chip" }, text,
    h("button", { title: "Remove", onclick: e => {
      rule.keys = rule.keys.filter(k => k !== text);
      e.target.parentElement.remove();
      persist();
    } }, "×"));
  const input = h("input", {
    class: "chip-input", placeholder: "add field name…",
    onkeydown: e => {
      if (e.key === "Enter" || e.key === ",") { e.preventDefault(); commit(); }
    },
    onblur: () => commit()
  });
  function commit() {
    const t = input.value.trim().replace(/,$/, "");
    input.value = "";
    if (!t || rule.keys.includes(t)) return;
    rule.keys.push(t);
    chips.insertBefore(chip(t), input);
    persist();
  }
  chips.append(...rule.keys.map(chip), input);

  const answer = h("input", {
    class: "answer", value: rule.value, placeholder: "Answer (e.g. Male, yes, Asthma, Cancer)",
    oninput: e => { rule.value = e.target.value; persist(); }
  });
  const toggle = h("span", { class: "switch", title: "Enable / disable rule" },
    h("input", { type: "checkbox", checked: rule.enabled !== false, onchange: e => {
      rule.enabled = e.target.checked;
      card.classList.toggle("off", !rule.enabled);
      persist();
    } }), h("i"));
  const del = h("button", { class: "del", title: "Delete rule", onclick: () => {
    const p = profile();
    p.rules = p.rules.filter(r => r !== rule);
    card.remove();
    persist();
  } }, "🗑");

  const card = h("div", { class: "rule" + (rule.enabled === false ? " off" : "") },
    chips,
    h("div", { class: "answer-row" }, h("span", { class: "arrow" }, "→"), answer, toggle, del));
  card.answerEl = answer;
  return card;
}

function renderRules() {
  const box = $("#rules");
  box.replaceChildren(...profile().rules.map(ruleCard));
  if (!profile().rules.length) box.append(h("ul", { class: "list" }, h("li", { class: "empty" }, "No rules yet")));
}

$("#addRule").onclick = () => {
  const r = { id: uid(), keys: [], value: "", enabled: true };
  profile().rules.push(r);
  persist();
  renderRules();
  showTab("rules");
  $("#rules").lastElementChild.querySelector(".chip-input").focus();
};

/* ---------- detected fields ---------- */
const HOW = {
  selector: "your CSS selector", name: "field name", synonym: "known synonym",
  autocomplete: "autocomplete hint", type: "input type", similar: "similar wording"
};
const nk = x => String(x).toLowerCase().replace(/[^a-z0-9]/g, "");

// answers worth offering for a free-text field, taken from the rules you already have
function suggestionsFor(f) {
  const rules = profile().rules.filter(r => r.value);
  const lab = nk(f.label), out = [];
  const add = v => { if (v && !out.includes(v)) out.push(v); };
  rules.forEach(r => {
    if (r.keys.some(k => { const n = nk(k); return n && lab && (lab.includes(n) || n.includes(lab)); })) add(r.value);
  });
  const pat = {
    email: /@/, tel: /^[+\d][\d\s()-]{6,}$/, url: /^https?:/,
    number: /^-?\d+([.,]\d+)?$/, date: /^\d{4}-\d{2}-\d{2}$|^\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}$/
  }[f.itype];
  if (pat) rules.forEach(r => pat.test(r.value) && add(r.value));
  return out.slice(0, 5);
}

function foundItem(f) {
  const save = value => {
    const p = profile();
    let r = f.ruleId && p.rules.find(x => x.id === f.ruleId);
    if (r) r.value = value;
    else {
      r = { id: uid(), keys: [f.ruleKey || f.label], value, enabled: true };
      p.rules.push(r);
      f.ruleId = r.id; f.matched = true;
    }
    f.value = value; f.resolved = true; f.how = f.how || "name";
    persist(); renderRules();
    li.replaceWith(foundItem(f));
    status(`Saved: ${f.label} → ${value}`, "ok");
  };

  const bad = f.matched && f.resolved === false;
  const dot = h("span", { class: "dot" + (bad ? " bad" : f.matched ? " ok" : "") });
  const meta = h("div", { class: "meta" }, h("b", { title: f.label }, f.label),
    h("small", {}, f.type + (f.itype && f.itype !== f.type && f.type === "text" ? " · " + f.itype : "") +
      (!f.matched && f.concept ? " · looks like: " + f.concept : "") +
      ((f.type === "radio" || f.type === "checks") && f.current ? " · selected now: " + f.current : "") +
      (f.frame && f.frame !== "Top page" ? " · in " + f.frame : "")));

  const right = f.matched
    ? h("span", { class: "tag" + (bad ? " bad" : "") }, bad ? "no option match" : "matched")
    : h("button", { class: "mini", onclick: () => {
        const r = { id: uid(), keys: [f.ruleKey || f.label], value: "", enabled: true };
        profile().rules.push(r); persist(); renderRules();
        showTab("rules");
        $("#rules").lastElementChild.querySelector(".answer").focus();
      } }, "+ Rule");

  const li = h("li", { class: "found" }, h("div", { class: "top" }, dot, meta, right));

  if (f.matched) {
    li.append(h("div", { class: "line" + (bad ? " bad" : "") },
      bad ? (f.missing && f.missing.length ? `Not found on this page: ${f.missing.join(", ")}` : `“${f.value}” isn’t one of the options, pick one below`)
          : f.value === "" ? "Rule has no answer yet" : `Will fill: “${f.value}”` + (HOW[f.how] ? ` · via ${HOW[f.how]}` : "")));
  }

  if (!f.matched && f.partial) li.append(h("div", { class: "line" }, `${f.partial} option(s) matched by their own rules`));

  const choices = f.options || suggestionsFor(f);
  const multi = f.type === "checks";
  const parts = () => String(f.value ?? "").split(/[,;|\n]+/).map(s => s.trim()).filter(Boolean);
  const toggle = v => {
    const p = parts(), i = p.findIndex(x => nk(x) === nk(v));
    i >= 0 ? p.splice(i, 1) : p.push(v);
    save(p.join(", "));
  };
  if (choices.length) {
    const LIMIT = 10;
    const row = h("div", { class: "opts" },
      h("small", {}, multi ? "Options (pick several):" : f.options ? "Options:" : "Suggestions:"));
    const chip = v => h("button", {
      class: "opt" + (multi ? (f.matched && parts().some(x => nk(x) === nk(v)) ? " on" : "")
        : (f.matched && f.value != null && nk(f.value) === nk(v) ? " on" : "")),
      title: multi ? "Add or remove from the answer" : "Use this as the answer",
      onclick: () => (multi ? toggle(v) : save(v))
    }, v);
    choices.slice(0, LIMIT).forEach(v => row.append(chip(v)));
    if (choices.length > LIMIT) {
      const more = h("button", { class: "opt more", onclick: () => {
        more.remove();
        choices.slice(LIMIT).forEach(v => row.append(chip(v)));
      } }, `+${choices.length - LIMIT} more`);
      row.append(more);
    }
    li.append(row);
  }
  return li;
}

$("#scan").onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let res = [];
  try { res = await Frames.run(tab.id, "scan", null, frameSel); } catch {}
  annotateFrames(res);
  const found = res.filter(r => r.status === "ok")
    .flatMap(r => r.value.map(f => ({ ...f, frame: res.length > 1 ? r.frame.name : "" })));
  const ul = $("#found");
  if (!found.length) {
    ul.replaceChildren(h("li", { class: "empty" }, `Nothing found. ${frameNote()}`));
    return;
  }
  ul.replaceChildren(...found.map(foundItem), h("li", { class: "empty" }, frameNote()));
};

/* ---------- fill / undo ---------- */
$("#fill").onclick = async () => {
  status("Filling…");
  const res = await inPage("fill");
  if (!res.length) return status(`Couldn't run on this page. ${frameNote()}`, "warn");
  const n = res.reduce((s, r) => s + (r.count || 0), 0);
  n ? status(`Filled ${n} field${n > 1 ? "s" : ""}`, "ok")
    : status(`No matching fields. Check the Detected tab. ${frameNote()}`, "warn");
};
$("#undo").onclick = async () => {
  const res = await inPage("undo");
  const n = res.reduce((s, r) => s + (r.count || 0), 0);
  status(n ? `Reverted ${n} change${n > 1 ? "s" : ""}` : "Nothing to undo");
};

/* ---------- auto-fill sites ---------- */
function syncSite() {
  $("#siteAuto").checked = !!host && S.autoSites.includes(host);
}
$("#siteAuto").onchange = e => {
  S.autoSites = S.autoSites.filter(s => s !== host);
  if (e.target.checked) S.autoSites.push(host);
  persist(); renderSites();
  status(e.target.checked ? `Will auto-fill on ${host}` : "Auto-fill off for this site");
};
function renderSites() {
  const ul = $("#sites");
  ul.replaceChildren(...S.autoSites.map(s =>
    h("li", {}, h("span", {}, s),
      h("button", { class: "x", title: "Remove", onclick: () => {
        S.autoSites = S.autoSites.filter(x => x !== s);
        persist(); renderSites(); syncSite();
      } }, "×"))));
  if (!S.autoSites.length) ul.append(h("li", { class: "empty" }, "No sites yet"));
}
$("#siteAdd").onclick = () => {
  const v = $("#siteInput").value.trim().replace(/^https?:\/\//, "");
  if (!v || S.autoSites.includes(v)) return;
  S.autoSites.push(v);
  $("#siteInput").value = "";
  persist(); renderSites(); syncSite();
};

/* ---------- profiles ---------- */
function renderProfiles() {
  $("#profile").replaceChildren(...S.profiles.map(p =>
    h("option", { value: p.id, textContent: p.name, selected: p.id === S.activeProfile })));
  $("#pname").value = profile().name;
  renderFlows();
}
$("#profile").onchange = e => {
  S.activeProfile = e.target.value;
  persist(); renderProfiles(); renderRules();
};
$("#rename").onclick = () => {
  const n = $("#pname").value.trim();
  if (!n) return;
  profile().name = n;
  persist(); renderProfiles();
};
$("#newp").onclick = () => {
  const p = { id: uid(), name: `Profile ${S.profiles.length + 1}`, rules: [] };
  S.profiles.push(p); S.activeProfile = p.id;
  persist(); renderProfiles(); renderRules();
  $("#pname").focus(); $("#pname").select();
};
$("#dupp").onclick = () => {
  const cur = profile();
  const p = { id: uid(), name: cur.name + " copy",
    rules: cur.rules.map(r => ({ ...r, id: uid(), keys: [...r.keys] })) };
  S.profiles.push(p); S.activeProfile = p.id;
  persist(); renderProfiles(); renderRules();
};
let armed;
$("#delp").onclick = e => {
  if (S.profiles.length < 2) return status("Keep at least one profile", "warn");
  if (!armed) {
    e.target.textContent = "Sure?";
    armed = setTimeout(() => { armed = null; e.target.textContent = "Delete"; }, 3000);
    return;
  }
  clearTimeout(armed); armed = null; e.target.textContent = "Delete";
  const cur = profile();
  S.profiles = S.profiles.filter(p => p !== cur);
  S.activeProfile = S.profiles[0].id;
  persist(); renderProfiles(); renderRules();
};

/* ---------- behaviour + backup ---------- */
$("#smart").onchange = e => { S.smart = e.target.checked; persist(); };
$("#skipFilled").onchange = e => { S.skipFilled = e.target.checked; persist(); };
$("#highlight").onchange = e => { S.highlight = e.target.checked; persist(); };

$("#export").onclick = async () => {
  const json = JSON.stringify({ profiles: S.profiles, flows: S.flows }, null, 2);
  $("#io").value = json;
  try { await navigator.clipboard.writeText(json); status("Exported and copied to clipboard", "ok"); }
  catch { status("Exported. Copy the text below.", "ok"); }
};
$("#import").onclick = () => {
  try {
    const data = JSON.parse($("#io").value);
    const list = Array.isArray(data) ? data : data.profiles;
    if (!Array.isArray(list)) throw 0;
    const idMap = {};
    list.forEach(p => {
      const id = !p.id || S.profiles.some(x => x.id === p.id) ? uid() : p.id;
      idMap[p.id] = id;
      S.profiles.push({
        id, name: String(p.name || "Imported"),
        rules: (p.rules || []).map(r => ({
          id: uid(), keys: (r.keys || []).map(String), value: String(r.value ?? ""), enabled: r.enabled !== false
        }))
      });
    });
    const flows = Array.isArray(data.flows) ? data.flows : [];
    flows.forEach(f => S.flows.push({
      id: uid(), name: String(f.name || "Imported flow"), site: String(f.site || ""), enabled: f.enabled !== false,
      steps: (f.steps || []).map(st => ({
        id: uid(), url: String(st.url || ""), click: String(st.click || ""), delay: +st.delay || 1000,
        profileId: idMap[st.profileId] || (S.profiles.some(x => x.id === st.profileId) ? st.profileId : "")
      }))
    }));
    persist(); renderProfiles(); renderRules();
    status(`Imported ${list.length} profile(s), ${flows.length} flow(s)`, "ok");
  } catch { status("That doesn't look like valid export JSON", "warn"); }
};

/* ---------- flows ---------- */
const pagePath = () => { try { const u = new URL(tabUrl); return u.host + u.pathname; } catch { return ""; } };
const newStep = url => ({ id: uid(), url, profileId: "", click: "", delay: 1000 });

function stepCard(flow, step, idx) {
  const picks = h("div", { class: "opts" });
  const clickIn = h("input", {
    placeholder: "Then click… e.g. Next (blank = none)", value: step.click || "",
    oninput: e => { step.click = e.target.value; persist(); }
  });
  const pick = h("button", { class: "mini", title: "Choose from this page's buttons", onclick: async () => {
    const btns = [...new Set((await inPage("buttons")).flat())];
    picks.replaceChildren(
      h("small", {}, btns.length ? "Buttons on this page:" : "No buttons found on this page"),
      ...btns.map(b => h("button", { class: "opt", onclick: () => {
        clickIn.value = b; step.click = b; persist(); picks.replaceChildren();
      } }, b)));
  } }, "Pick");

  const delay = h("select", { title: "Wait before clicking", onchange: e => { step.delay = +e.target.value; persist(); } },
    ...[[500, "0.5s"], [1000, "1s"], [2000, "2s"], [3000, "3s"]].map(([v, l]) =>
      h("option", { value: String(v), textContent: "wait " + l })));
  delay.value = String(step.delay ?? 1000);

  const prof = h("select", { class: "grow", title: "Answers to use on this page",
    onchange: e => { step.profileId = e.target.value; persist(); } },
    h("option", { value: "", textContent: "Use active profile" }),
    ...S.profiles.map(p => h("option", { value: p.id, textContent: "Use: " + p.name })));
  prof.value = step.profileId || "";

  return h("div", { class: "step" },
    h("div", { class: "row" },
      h("span", { class: "num" }, String(idx + 1)),
      h("input", { placeholder: "Page URL contains… (blank = any page)", value: step.url || "",
        oninput: e => { step.url = e.target.value; persist(); } }),
      h("button", { class: "del", title: "Remove step", onclick: () => {
        flow.steps = flow.steps.filter(s => s !== step); persist(); renderFlows();
      } }, "×")),
    h("div", { class: "row" }, prof),
    h("div", { class: "row" }, clickIn, pick, delay),
    picks);
}

function flowCard(flow) {
  const card = h("div", { class: "flow" + (flow.enabled === false ? " off" : "") },
    h("div", { class: "row" },
      h("input", { value: flow.name, placeholder: "Flow name", oninput: e => { flow.name = e.target.value; persist(); } }),
      h("span", { class: "switch", title: "Enable / disable flow" },
        h("input", { type: "checkbox", checked: flow.enabled !== false, onchange: e => {
          flow.enabled = e.target.checked; card.classList.toggle("off", !flow.enabled); persist();
        } }), h("i")),
      h("button", { class: "del", title: "Delete flow", onclick: () => {
        S.flows = S.flows.filter(f => f !== flow); persist(); renderFlows();
      } }, "🗑")),
    h("div", { class: "row" },
      h("input", { value: flow.site, placeholder: "Site, e.g. example.com",
        oninput: e => { flow.site = e.target.value.trim(); persist(); } })),
    ...flow.steps.map((s, i) => stepCard(flow, s, i)),
    h("div", { class: "row" },
      h("button", { class: "ghost", onclick: () => { flow.steps.push(newStep("")); persist(); renderFlows(); } }, "+ Add step"),
      h("button", { class: "ghost", disabled: !host, title: "Add a step for the page you're on",
        onclick: () => { flow.steps.push(newStep(pagePath())); persist(); renderFlows(); } }, "+ This page")));
  return card;
}

function renderFlows() {
  const box = $("#flows");
  if (!box) return;
  box.replaceChildren(...S.flows.map(flowCard));
  if (!S.flows.length) box.append(h("ul", { class: "list" }, h("li", { class: "empty" }, "No flows yet")));
}

$("#newFlow").onclick = () => {
  S.flows.push({ id: uid(), name: host || "New flow", site: host || "", enabled: true,
    steps: host ? [newStep(pagePath())] : [] });
  persist(); renderFlows(); showTab("flows");
  status("Flow created. Add a step for each page of the form.", "ok");
};

/* ---------- updates (GitHub) ---------- */
function renderUpdate(info) {
  const when = info?.checkedAt ? ` · checked ${new Date(info.checkedAt).toLocaleString()}` : "";
  $("#verLine").textContent = `Installed v${chrome.runtime.getManifest().version}${when}`;
  const on = !!info?.available;
  $("#updBanner").hidden = !on;
  if (on) $("#updText").textContent = `Version ${info.remote} is available (you have ${info.local})`;
}

function initUpdates(info) {
  const text = (id, key, fix = v => v) => {
    $(id).value = S.gh[key] || "";
    $(id).oninput = e => { S.gh[key] = fix(e.target.value); persist(); };
  };
  const flag = (id, key) => {
    $(id).checked = !!S.gh[key];
    $(id).onchange = e => { S.gh[key] = e.target.checked; persist(); };
  };
  text("#ghRepo", "repo", v => v.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/+$/, ""));
  text("#ghBranch", "branch", v => v.trim() || "main");
  text("#ghPath", "path", v => v.trim().replace(/^\/+|\/+$/g, ""));
  text("#ghToken", "token", v => v.trim());
  flag("#ghAutoCheck", "autoCheck");
  flag("#ghAutoApply", "autoApply");

  $("#updCheck").onclick = async () => {
    status("Checking GitHub…");
    try {
      const i = await Updater.check();
      renderUpdate(i);
      status(i.available ? `Version ${i.remote} is available` : "You're up to date", i.available ? "ok" : "");
    } catch (e) { status(e.message, "warn"); }
  };
  $("#updOpen").onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL("update.html") });
  $("#updNow").onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL("update.html?apply=1") });
  renderUpdate(info);
}

/* ---------- frames (modals, iframes) ---------- */
async function loadFrames() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const list = await Frames.list(tab.id);
    const sel = $("#frameSel"), keep = sel.value;
    sel.replaceChildren(h("option", { value: "all", textContent: "All frames" }),
      ...list.map(f => h("option", { value: String(f.id), textContent: f.id === 0 ? f.name : `${f.name} (#${f.id})`, title: f.url })));
    sel.value = [...sel.options].some(o => o.value === keep) ? keep : "all";
    frameSel = sel.value;
    $("#frameRow").hidden = list.length < 2;
  } catch {}
}
function annotateFrames(res) {
  const sel = $("#frameSel");
  for (const r of res) {
    const o = [...sel.options].find(o => o.value === String(r.frame.id));
    if (!o) continue;
    const base = r.frame.id === 0 ? r.frame.name : `${r.frame.name} (#${r.frame.id})`;
    o.textContent = base + (r.status === "ok" && Array.isArray(r.value) ? ` · ${r.value.length} fields` : ` · ${r.status}`);
  }
}
$("#frameSel").onchange = e => { frameSel = e.target.value; };
$("#frameRefresh").onclick = loadFrames;

/* ---------- init ---------- */
(async () => {
  S = await chrome.storage.local.get(null);
  if (!S.profiles?.length) { S = defaults(); await persist(); }
  S.autoSites ||= [];
  S.flows ||= [];
  S.skipFilled ??= false;
  S.highlight ??= true;
  S.smart ??= true;
  const updateInfo = S.updateInfo; delete S.updateInfo;   // owned by the updater, don't overwrite
  S.gh = { ...Updater.DEFAULTS, ...(S.gh || {}) };

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabUrl = tab.url || "";
    const u = new URL(tab.url);
    if (/^https?:$/.test(u.protocol)) host = u.hostname;
  } catch {}
  if (host) $("#siteLabel").textContent = `Auto-fill on ${host}`;
  else { $("#siteLabel").textContent = "Auto-fill (open a website first)"; $(".site-row").classList.add("disabled"); }

  $("#smart").checked = S.smart;
  $("#skipFilled").checked = S.skipFilled;
  $("#highlight").checked = S.highlight;
  renderProfiles(); renderRules(); renderSites(); syncSite();
  initUpdates(updateInfo);
  loadFrames();
})();
