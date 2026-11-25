chrome.commands.onCommand.addListener(async cmd => {
  if (cmd !== "fill-page") return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const res = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => (window.__acf ? window.__acf.fill() : null)
    });
    const n = res.reduce((s, r) => s + (r.result?.count || 0), 0);
    await chrome.action.setBadgeBackgroundColor({ color: "#4f46e5", tabId: tab.id });
    await chrome.action.setBadgeText({ text: String(n), tabId: tab.id });
    setTimeout(() => chrome.action.setBadgeText({ text: "", tabId: tab.id }), 3000);
  } catch (e) { /* restricted page */ }
});
