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

let S, host = null;
const persist = () => chrome.storage.local.set(S);
const profile = () => S.profiles.find(p => p.id === S.activeProfile) || S.profiles[0];

function status(msg, kind = "") {
  const el = $("#status");
  el.textContent = msg;
  el.className = kind;
}

async function inPage(name, arg) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const res = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: (n, a) => (window.__acf ? window.__acf[n](a) : null),
      args: [name, arg ?? null]
    });
    return res.map(r => r.result).filter(Boolean);
  } catch { return []; }
}

/* ---------- tabs ---------- */
function showTab(name) {
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
    class: "answer", value: rule.value, placeholder: "Answer (e.g. Male, yes, 09123…)",
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
$("#scan").onclick = async () => {
  const found = (await inPage("scan")).flat();
  const ul = $("#found");
  if (!found.length) {
    ul.replaceChildren(h("li", { class: "empty" }, "Nothing found. Reload the page once, or open a normal website."));
    return;
  }
  ul.replaceChildren(...found.map(f => {
    const action = f.matched
      ? h("span", { class: "tag" }, "matched")
      : h("button", { class: "mini", onclick: e => {
          const r = { id: uid(), keys: [f.label], value: "", enabled: true };
          profile().rules.push(r);
          persist();
          renderRules();
          e.target.replaceWith(h("span", { class: "tag" }, "added"));
          showTab("rules");
          $("#rules").lastElementChild.querySelector(".answer").focus();
        } }, "+ Rule");
    return h("li", {},
      h("span", { class: "dot" + (f.matched ? " ok" : "") }),
      h("div", { class: "meta" }, h("b", {}, f.label),
        h("small", {}, f.type + (f.options ? " · " + f.options.join(", ") : ""))),
      action);
  }));
};

/* ---------- fill / undo ---------- */
$("#fill").onclick = async () => {
  status("Filling…");
  const res = await inPage("fill");
  if (!res.length) return status("Can't run here. Reload the page once, or open a normal website.", "warn");
  const n = res.reduce((s, r) => s + (r.count || 0), 0);
  n ? status(`Filled ${n} field${n > 1 ? "s" : ""}`, "ok")
    : status("No matching fields. Check the Detected tab.", "warn");
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
$("#skipFilled").onchange = e => { S.skipFilled = e.target.checked; persist(); };
$("#highlight").onchange = e => { S.highlight = e.target.checked; persist(); };

$("#export").onclick = async () => {
  const json = JSON.stringify({ profiles: S.profiles }, null, 2);
  $("#io").value = json;
  try { await navigator.clipboard.writeText(json); status("Exported and copied to clipboard", "ok"); }
  catch { status("Exported. Copy the text below.", "ok"); }
};
$("#import").onclick = () => {
  try {
    const data = JSON.parse($("#io").value);
    const list = Array.isArray(data) ? data : data.profiles;
    if (!Array.isArray(list)) throw 0;
    list.forEach(p => S.profiles.push({
      id: uid(), name: String(p.name || "Imported"),
      rules: (p.rules || []).map(r => ({
        id: uid(), keys: (r.keys || []).map(String), value: String(r.value ?? ""), enabled: r.enabled !== false
      }))
    }));
    persist(); renderProfiles(); renderRules();
    status(`Imported ${list.length} profile(s)`, "ok");
  } catch { status("That doesn't look like valid export JSON", "warn"); }
};

/* ---------- init ---------- */
(async () => {
  S = await chrome.storage.local.get(null);
  if (!S.profiles?.length) { S = defaults(); await persist(); }
  S.autoSites ||= [];
  S.skipFilled ??= false;
  S.highlight ??= true;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const u = new URL(tab.url);
    if (/^https?:$/.test(u.protocol)) host = u.hostname;
  } catch {}
  if (host) $("#siteLabel").textContent = `Auto-fill on ${host}`;
  else { $("#siteLabel").textContent = "Auto-fill (open a website first)"; $(".site-row").classList.add("disabled"); }

  $("#skipFilled").checked = S.skipFilled;
  $("#highlight").checked = S.highlight;
  renderProfiles(); renderRules(); renderSites(); syncSite();
})();
