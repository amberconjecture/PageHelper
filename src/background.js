import {
  handleKeepAliveAlarm,
  isKeepAliveAlarm,
  setupAlarms
} from "./keep-alive.js";
import {
  handleWebSocketReconcileAlarm,
  handleWebSocketStorageChangedMessage,
  isWebSocketReconcileAlarm,
  reconcileWebSockets,
  setupWebSocketSupport
} from "./websocket.js";

function setupExtension(reason) {
  void setupAlarms(reason);
  void setupWebSocketSupport(reason);
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

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === "pagehelper.websocket.storage-changed") {
    void handleWebSocketStorageChangedMessage(message, sender);
  }
});

// MV3 Service Worker 可能在空闲时被挂起；每次模块重新加载都重新对齐
// 定时器和已打开页面，覆盖“安装/重载时目标页已经打开”的情况。
setupExtension("service-worker-start");
