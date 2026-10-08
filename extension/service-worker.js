const NATIVE_HOST = 'com.resourcehub.launcher';

let wakePromise;

function wakeLocalService() {
  if (wakePromise) return wakePromise;
  wakePromise = new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, { action: 'start' }, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else if (!response?.ok) reject(new Error(response?.error || '本地服务启动失败'));
      else resolve(response);
    });
  }).finally(() => {
    wakePromise = undefined;
  });
  return wakePromise;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'ensure-local-service') return false;
  wakeLocalService()
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
