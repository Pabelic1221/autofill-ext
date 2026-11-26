const $ = s => document.querySelector(s);
let imp = null, armed = null;

const msg = (t, kind = "") => { const m = $("#msg"); m.textContent = t; m.className = kind; };
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const getState = () => chrome.storage.local.get(["profiles", "activeProfile", "flows"]);

async function refreshCurrent() {
  const s = await getState(), ps = s.profiles || [];
  $("#current").textContent =
    `In the extension now: ${ps.length} profile(s), ${ps.reduce((n, p) => n + p.rules.length, 0)} rule(s), ${(s.flows || []).length} flow(s).`;
}

function show(text, name) {
  msg("");
  try { imp = PresetCore.normalize(JSON.parse(text)); }
  catch (e) { imp = null; $("#preview").hidden = true; return msg(e instanceof SyntaxError ? "That file isn't valid JSON." : e.message, "bad"); }

  const rules = imp.profiles.reduce((n, p) => n + p.rules.length, 0);
  $("#fname").textContent = name || "Pasted preset";
  const stats = $("#stats"); stats.replaceChildren(
    el("span", "stat", `${imp.profiles.length} profile(s)`), el("span", "stat", `${rules} rule(s)`),
    el("span", "stat", `${imp.flows.length} flow(s)`));
  if (imp.duplicates) stats.append(el("span", "stat warn", `${imp.duplicates} duplicate rule(s) will be skipped`));

  $("#plist").replaceChildren(...imp.profiles.map(p => el("p", "", `• ${p.name}: ${p.rules.length} rules`)));
  const all = imp.profiles.flatMap(p => p.rules);
  const ul = $("#rulePreview");
  ul.replaceChildren(...all.slice(0, 8).map(r => { const li = el("li"); li.append(el("code", "", r.keys.join(" | ")), document.createTextNode("  →  " + r.value)); return li; }));
  if (all.length > 8) ul.append(el("li", "", `…and ${all.length - 8} more`));
  $("#preview").hidden = false;
}

async function loadFile(file) {
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) return msg("That file is too large to be a preset.", "bad");
  show(await file.text(), file.name);
}

$("#choose").onclick = () => $("#file").click();
$("#file").onchange = e => loadFile(e.target.files[0]);
$("#loadPaste").onclick = () => show($("#paste").value, "Pasted preset");
const drop = $("#drop");
["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", e => loadFile(e.dataTransfer.files[0]));

$("#apply").onclick = async () => {
  if (!imp) return;
  const btn = $("#apply"), mode = document.querySelector('input[name="mode"]:checked').value;
  if (mode === "replace" && !armed) {
    btn.textContent = "Click again to replace everything";
    armed = setTimeout(() => { armed = null; btn.textContent = "Import preset"; }, 4000);
    return;
  }
  clearTimeout(armed); armed = null; btn.textContent = "Import preset";

  const s = await getState();
  const out = PresetCore.apply({ profiles: s.profiles || [], activeProfile: s.activeProfile, flows: s.flows || [] },
    imp, mode, { activate: $("#activate").checked });
  await chrome.storage.local.set({ profiles: out.profiles, activeProfile: out.activeProfile, flows: out.flows });

  const r = out.report, bits = [];
  if (r.profilesAdded) bits.push(`${r.profilesAdded} profile(s) added`);
  if (r.rulesAdded) bits.push(`${r.rulesAdded} rule(s) added`);
  if (r.rulesUpdated) bits.push(`${r.rulesUpdated} updated`);
  if (r.rulesSkipped) bits.push(`${r.rulesSkipped} already there`);
  if (r.flowsAdded) bits.push(`${r.flowsAdded} flow(s) added`);
  msg("✔ Imported: " + (bits.join(", ") || "nothing new") + ". Open the extension popup to use it.", "ok");
  refreshCurrent();
};

$("#download").onclick = async () => {
  const s = await getState();
  const blob = new Blob([JSON.stringify({ profiles: s.profiles || [], flows: s.flows || [] }, null, 2)], { type: "application/json" });
  const a = el("a"); a.href = URL.createObjectURL(blob);
  a.download = `autofill-preset-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};

refreshCurrent();
