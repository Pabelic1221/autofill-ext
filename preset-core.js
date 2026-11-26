// Pure logic for importing presets (no DOM), used by presets.html
(() => {
  const root = typeof self !== "undefined" ? self : window;
  const uid = () => Math.random().toString(36).slice(2, 9);
  const sig = r => r.keys.map(k => k.toLowerCase().trim()).sort().join("|");
  const sameRule = (a, b) => sig(a) === sig(b) && a.value.trim().toLowerCase() === b.value.trim().toLowerCase();

  // accepts { profiles, flows }, a bare array of profiles, or a single profile { name, rules }
  function normalize(data) {
    let list = Array.isArray(data) ? data : data && (data.profiles || (data.rules ? [data] : null));
    if (!Array.isArray(list) || !list.length) throw new Error("This file doesn't contain any profiles.");
    let duplicates = 0;
    const profiles = list.map(p => {
      const rules = [];
      for (const r of p.rules || []) {
        const nr = {
          keys: [].concat(r.keys || []).map(k => String(k).trim()).filter(Boolean),
          value: String(r.value ?? ""),
          enabled: r.enabled !== false
        };
        if (!nr.keys.length) continue;
        if (rules.some(x => sameRule(x, nr))) { duplicates++; continue; }   // same field names and answer twice
        rules.push(nr);
      }
      return { id: p.id, name: String(p.name || "Imported"), rules };
    });
    const flows = data && Array.isArray(data.flows) ? data.flows : [];
    return { profiles, flows, duplicates };
  }

  // mode: "add" (new profiles), "merge" (into the active profile), "replace" (everything)
  function apply(state, imp, mode, opts = {}) {
    const clone = p => ({ ...p, rules: p.rules.map(r => ({ ...r, keys: [...r.keys] })) });
    const profiles = mode === "replace" ? [] : (state.profiles || []).map(clone);
    const flows = mode === "replace" ? [] : (state.flows || []).slice();
    const rep = { profilesAdded: 0, rulesAdded: 0, rulesUpdated: 0, rulesSkipped: 0, flowsAdded: 0 };
    const idMap = {};
    let active = state.activeProfile;

    if (mode === "merge") {
      if (!profiles.length) profiles.push({ id: uid(), name: "Default", rules: [] });
      const target = profiles.find(p => p.id === active) || profiles[0];
      active = target.id;
      for (const p of imp.profiles) {
        idMap[p.id] = target.id;
        for (const r of p.rules) {
          const ex = target.rules.find(x => sig(x) === sig(r));
          if (!ex) { target.rules.push({ id: uid(), ...r }); rep.rulesAdded++; }
          else if (ex.value !== r.value) { ex.value = r.value; rep.rulesUpdated++; }
          else rep.rulesSkipped++;
        }
      }
    } else {
      imp.profiles.forEach((p, i) => {
        const id = p.id && !profiles.some(x => x.id === p.id) ? p.id : uid();
        idMap[p.id] = id;
        const names = new Set(profiles.map(x => x.name));
        let name = p.name;
        for (let n = 2; names.has(name); n++) name = `${p.name} (${n})`;
        profiles.push({ id, name, rules: p.rules.map(r => ({ id: uid(), ...r })) });
        rep.profilesAdded++; rep.rulesAdded += p.rules.length;
        if (i === 0 && (opts.activate !== false || mode === "replace")) active = id;
      });
    }

    for (const f of imp.flows) {
      flows.push({
        id: uid(), name: String(f.name || "Imported flow"), site: String(f.site || ""), enabled: f.enabled !== false,
        steps: (f.steps || []).map(st => ({
          id: uid(), url: String(st.url || ""), click: String(st.click || ""), delay: +st.delay || 1000,
          profileId: idMap[st.profileId] || (profiles.some(x => x.id === st.profileId) ? st.profileId : "")
        }))
      });
      rep.flowsAdded++;
    }
    return { profiles, activeProfile: active, flows, report: rep };
  }

  root.PresetCore = { normalize, apply, uid };
})();
