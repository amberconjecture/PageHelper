import {
  handleKeepAliveAlarm,
  isKeepAliveAlarm,
  setupAlarms
} from "./keep-alive.js";
import { SITE_SELECTIONS_STORAGE_KEY } from "./constants.js";
import { logError } from "./logger.js";
import { applySiteSelections, loadSiteSelections, setSiteSelection } from "./site-selection.js";
import {
  handleWebSocketReconcileAlarm,
  handleWebSocketStorageChangedMessage,
  invalidateWebSocketReconciles,
  isWebSocketReconcileAlarm,
  reconcileWebSockets,
  setupWebSocketSupport
} from "./websocket.js";

let setupQueue = Promise.resolve();

function setupExtension(reason) {
  setupQueue = setupQueue
    .catch(() => undefined)
    .then(async () => {
      await loadSiteSelections();
      await Promise.all([setupAlarms(reason), setupWebSocketSupport(reason)]);
    })
    .catch((error) => {
      logError("Failed to set up extension.", { reason, error });
    });

  return setupQueue;
}

chrome.runtime.onInstalled.addListener((details) => {
  setupExtension(`runtime.onInstalled:${details.reason}`);
});

chrome.runtime.onStartup.addListener(() => {
  setupExtension("runtime.onStartup");
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (isWebSocketReconcileAlarm(alarm)) {
    void handleWebSocketReconcileAlarm(alarm);
    return;
  }

  if (isKeepAliveAlarm(alarm)) {
    void handleKeepAliveAlarm(alarm, {
      onPageOpened: reconcileWebSockets
    });
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === "complete") {
    void reconcileWebSockets(`tabs.onUpdated:${tabId}`);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void reconcileWebSockets(`tabs.onRemoved:${tabId}`);
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  void reconcileWebSockets(`tabs.onReplaced:${removedTabId}->${addedTabId}`);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "pagehelper.site-selection.set") {
    void setSiteSelection(message.targetId, message.enabled)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "pagehelper.websocket.storage-changed") {
    void handleWebSocketStorageChangedMessage(message, sender);
  }

  return undefined;
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[SITE_SELECTIONS_STORAGE_KEY]) {
    // 先同步更新内存快照，使已经在 await 中的旧任务能立即看到“已停用”。
    applySiteSelections(changes[SITE_SELECTIONS_STORAGE_KEY].newValue);
    invalidateWebSocketReconciles();
    void setupExtension("storage.onChanged:site-selections");
  }
});

// MV3 Service Worker 可能在空闲时被挂起；每次模块重新加载都重新对齐
// 定时器和已打开页面，覆盖“安装/重载时目标页已经打开”的情况。
setupExtension("service-worker-start");
