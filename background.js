importScripts("updater.js", "frames.js");

// ---- check GitHub every 6 hours; install automatically if folder access was set up ----
const schedule = () => chrome.alarms.create("acf-update", { periodInMinutes: 360, delayInMinutes: 1 });
chrome.runtime.onInstalled.addListener(schedule);
chrome.runtime.onStartup.addListener(schedule);
chrome.alarms.get("acf-update", a => { if (!a) schedule(); });

chrome.alarms.onAlarm.addListener(async a => {
  if (a.name !== "acf-update") return;
  try {
    const cfg = await Updater.getCfg();
    if (!Updater.repoOk(cfg.repo) || cfg.autoCheck === false) return;
    const info = await Updater.check();
    if (info.available && cfg.autoApply !== false) {
      try { await Updater.apply({ interactive: false }); }
      catch (e) { /* needs you: open the popup and click "Update now" */ }
    }
  } catch (e) { /* offline or bad settings, try again next time */ }
});

chrome.commands.onCommand.addListener(async cmd => {
  if (cmd !== "fill-page") return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const res = await Frames.run(tab.id, "fill", null, "all");
    const n = res.reduce((s, r) => s + (r.value?.count || 0), 0);
    await chrome.action.setBadgeBackgroundColor({ color: "#4f46e5", tabId: tab.id });
    await chrome.action.setBadgeText({ text: String(n), tabId: tab.id });
    setTimeout(() => chrome.action.setBadgeText({ text: "", tabId: tab.id }), 3000);
  } catch (e) { /* restricted page */ }
});

// badge from auto-fill / flows running inside a page
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== "badge" || !sender.tab) return;
  const id = sender.tab.id;
  chrome.action.setBadgeBackgroundColor({ color: "#4f46e5", tabId: id });
  chrome.action.setBadgeText({ text: String(msg.n), tabId: id });
  setTimeout(() => chrome.action.setBadgeText({ text: "", tabId: id }), 3000);
});
