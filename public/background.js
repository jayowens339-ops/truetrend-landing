const VERIFY_URL = "https://YOURDOMAIN.com/api/gateway?action=verify";

async function getState() {
  const s = await chrome.storage.local.get(["licenseKey","deviceId","active","validUntil"]);
  if (!s.deviceId) {
    s.deviceId = crypto.getRandomValues(new Uint32Array(4)).join("-");
    await chrome.storage.local.set({ deviceId: s.deviceId });
  }
  return s;
}

async function verify() {
  const { licenseKey, deviceId, validUntil } = await getState();
  if (!licenseKey) { await chrome.storage.local.set({ active:false }); chrome.action.setBadgeText({text:"OFF"}); return; }

  try {
    const r = await fetch(VERIFY_URL, { method:"POST", headers:{ "content-type":"application/json" },
      body: JSON.stringify({ licenseKey, deviceId, productId:"truetrend-ai" }) });
    const data = await r.json();
    const active = !!data.active;
    await chrome.storage.local.set({ active, validUntil: data.validUntil||0, lastLicenseStatus: data.status });
    chrome.action.setBadgeText({ text: active ? "" : "OFF" });
  } catch {
    // offline fallback
    const ok = validUntil && Date.now() < validUntil;
    await chrome.storage.local.set({ active: !!ok });
    chrome.action.setBadgeText({ text: ok ? "" : "OFF" });
  }
}

chrome.runtime.onInstalled.addListener(verify);
chrome.runtime.onStartup.addListener(verify);
chrome.alarms.create("licensePoll", { periodInMinutes: 60 });
chrome.alarms.onAlarm.addListener(a => a.name==="licensePoll" && verify());
