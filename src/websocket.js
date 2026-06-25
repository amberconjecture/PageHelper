import { KEEP_ALIVE_CONFIG } from "./config.js";
import { WEBSOCKET_RECONCILE_ALARM } from "./constants.js";
import { formatTimestamp, logError, logInfo, logWarn, normalizeError } from "./logger.js";
import {
  installWebSocketStorageWatcherInPage,
  readWebSocketStorageInPage
} from "./page-scripts.js";
import {
  getWebSocketPageTarget,
  getWebSocketSessionPageTarget,
  getWebSocketTargets,
  normalizeWebSocketConfig,
  normalizeWebSocketReconcileIntervalMinutes,
  normalizeWebSocketWatcherConfig
} from "./target-config.js";
import {
  findMatchingTabs,
  getQueryUrlPatterns,
  matchesTargetUrl,
  sortPreferredTabs
} from "./tabs.js";
import {
  buildWebSocketUrl,
  extractJsonPathValue,
  getWebSocketMessageLength,
  getWebSocketReadyStateName,
  isNonEmptyValue,
  isWebSocketUsable,
  redactWebSocketUrl,
  safeCloseReason,
  serializeWebSocketEvent,
  stringifyQueryValue
} from "./websocket-utils.js";

// Service Worker 会被 Chrome 挂起；这些 Map 只代表本次唤醒期间的连接状态。
// 每次唤醒都会通过 reconcileWebSockets 重新扫描已打开 Tab，恢复应有连接。
const webSocketConnections = new Map();
const webSocketReconnectTimers = new Map();

export function isWebSocketReconcileAlarm(alarm) {
  return alarm.name === WEBSOCKET_RECONCILE_ALARM;
}

export async function handleWebSocketReconcileAlarm(alarm) {
  logInfo("WebSocket reconcile alarm fired.", {
    alarmName: alarm.name,
    scheduledTime: formatTimestamp(alarm.scheduledTime),
    periodInMinutes: alarm.periodInMinutes
  });
  await reconcileWebSockets("websocket-reconcile-alarm");
}

export async function setupWebSocketSupport(reason) {
  await setupWebSocketReconcileAlarm(reason);
  await reconcileWebSockets(reason);
}

async function setupWebSocketReconcileAlarm(reason) {
  const targets = getWebSocketTargets();
  const existingAlarm = await chrome.alarms.get(WEBSOCKET_RECONCILE_ALARM);

  if (!targets.length) {
    if (existingAlarm) {
      await chrome.alarms.clear(WEBSOCKET_RECONCILE_ALARM);
      logInfo("Cleared WebSocket reconcile alarm because no WebSocket targets are enabled.", {
        reason,
        alarmName: WEBSOCKET_RECONCILE_ALARM
      });
    }
    return;
  }

  const intervalMinutes = normalizeWebSocketReconcileIntervalMinutes(
    KEEP_ALIVE_CONFIG.defaultWebSocketReconcileIntervalMinutes
  );

  if (existingAlarm?.periodInMinutes === intervalMinutes) {
    logInfo("Keeping existing WebSocket reconcile alarm.", {
      reason,
      alarmName: WEBSOCKET_RECONCILE_ALARM,
      nextRunAt: formatTimestamp(existingAlarm.scheduledTime),
      intervalMinutes,
      enabledTargetIds: targets.map((target) => target.id)
    });
    return;
  }

  const firstRunAt = Date.now() + 1000;
  await chrome.alarms.create(WEBSOCKET_RECONCILE_ALARM, {
    when: firstRunAt,
    periodInMinutes: intervalMinutes
  });

  logInfo("Created WebSocket reconcile alarm.", {
    reason,
    alarmName: WEBSOCKET_RECONCILE_ALARM,
    firstRunAt: formatTimestamp(firstRunAt),
    intervalMinutes,
    enabledTargetIds: targets.map((target) => target.id)
  });
}

export async function reconcileWebSockets(reason) {
  const targets = getWebSocketTargets();
  const enabledTargetIds = new Set(targets.map((target) => target.id));

  for (const targetId of webSocketConnections.keys()) {
    if (!enabledTargetIds.has(targetId)) {
      disconnectWebSocket(targetId, "target-disabled-or-removed");
    }
  }

  for (const targetId of webSocketReconnectTimers.keys()) {
    if (!enabledTargetIds.has(targetId)) {
      clearWebSocketReconnectTimer(targetId);
    }
  }

  if (!targets.length) {
    return;
  }

  logInfo("Reconciling WebSocket targets.", {
    reason,
    enabledTargetIds: targets.map((target) => target.id),
    activeConnectionTargetIds: [...webSocketConnections.keys()]
  });

  await Promise.all(targets.map((target) => reconcileWebSocketTarget(target, reason)));
}

async function reconcileWebSocketTarget(target, reason) {
  const config = normalizeWebSocketConfig(target);
  const targetUrlPageTarget = getWebSocketPageTarget(target, config);
  const sessionPageTarget = getWebSocketSessionPageTarget(target);
  const targetUrlTabs = await findMatchingTabs(targetUrlPageTarget, { log: false });
  const sessionPageTabs = sessionPageTarget ? await findMatchingTabs(sessionPageTarget, { log: false }) : [];

  logInfo("Queried WebSocket target tabs.", {
    reason,
    targetId: target.id,
    targetUrlQueryPatterns: getQueryUrlPatterns(targetUrlPageTarget),
    targetUrlMatchingCount: targetUrlTabs.length,
    targetUrlTabIds: targetUrlTabs.map((tab) => tab.id),
    pageUrl: target.pageUrl,
    pageUrlQueryPatterns: sessionPageTarget ? getQueryUrlPatterns(sessionPageTarget) : [],
    pageUrlMatchingCount: sessionPageTabs.length,
    pageUrlTabIds: sessionPageTabs.map((tab) => tab.id)
  });

  if (!targetUrlTabs.length) {
    disconnectWebSocket(target.id, "no-matching-tabs");
    return;
  }

  // TargetUrl 负责 localStorage token；pageUrl 负责 sessionStorage client_id。
  // 两边都装 watcher，任意一侧登录态变化都触发一次完整重扫。
  await Promise.all([
    ...targetUrlTabs.map((tab) => installWebSocketStorageWatcher(tab, target, config)),
    ...sessionPageTabs.map((tab) => installWebSocketStorageWatcher(tab, target, config))
  ]);

  const candidate = await findWebSocketConnectionCandidate(targetUrlTabs, sessionPageTabs, config);
  if (!candidate.ok) {
    logInfo("WebSocket prerequisites are not ready.", {
      reason,
      targetId: target.id,
      currentConnectionState: getExistingWebSocketState(target.id),
      failures: candidate.failures
    });
    return;
  }

  connectOrUpdateWebSocket(target, config, candidate, reason);
}

async function installWebSocketStorageWatcher(tab, target, config) {
  if (!tab.id) {
    return;
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: {
        tabId: tab.id,
        allFrames: false
      },
      func: installWebSocketStorageWatcherInPage,
      args: [normalizeWebSocketWatcherConfig(target, config)]
    });

    const result = results.find((item) => item.result)?.result;
    if (!result?.ok) {
      logWarn("Could not install WebSocket storage watcher.", {
        targetId: target.id,
        tabId: tab.id,
        result
      });
    }
  } catch (error) {
    logWarn("Failed to install WebSocket storage watcher.", {
      targetId: target.id,
      tabId: tab.id,
      error
    });
  }
}

async function findWebSocketConnectionCandidate(targetUrlTabs, sessionPageTabs, config) {
  const localStorageResult = await findLocalStorageCandidate(targetUrlTabs, config);
  const sessionStorageResult = await findSessionStorageCandidate(sessionPageTabs, config);

  if (!localStorageResult.ok || !sessionStorageResult.ok) {
    return {
      ok: false,
      failures: {
        localStorage: localStorageResult.failures,
        sessionStorage: sessionStorageResult.failures
      }
    };
  }

  return buildWebSocketConnectionCandidate(config, localStorageResult, sessionStorageResult);
}

async function findLocalStorageCandidate(tabs, config) {
  if (!tabs.length) {
    return {
      ok: false,
      failures: [
        {
          reason: "no-target-url-tabs"
        }
      ]
    };
  }

  const failures = [];

  for (const tab of sortPreferredTabs(tabs)) {
    const snapshot = await readWebSocketStorageSnapshot(tab, config);
    if (!snapshot.ok) {
      failures.push({
        tabId: tab.id,
        reason: snapshot.reason,
        error: snapshot.error
      });
      continue;
    }

    if (isNonEmptyValue(snapshot.localStorageValue)) {
      return {
        ok: true,
        tab,
        snapshot,
        localStorageValue: String(snapshot.localStorageValue)
      };
    }

    failures.push({
      tabId: tab.id,
      reason: "missing-local-storage-value",
      localStorageKey: config.localStorageKey
    });
  }

  return {
    ok: false,
    failures
  };
}

async function findSessionStorageCandidate(tabs, config) {
  if (!tabs.length) {
    return {
      ok: false,
      failures: [
        {
          reason: "no-page-url-tabs",
          sessionStorageKey: config.sessionStorageKey,
          sessionStorageJsonPath: config.sessionStorageJsonPath
        }
      ]
    };
  }

  const failures = [];

  for (const tab of sortPreferredTabs(tabs)) {
    const snapshot = await readWebSocketStorageSnapshot(tab, config);
    if (!snapshot.ok) {
      failures.push({
        tabId: tab.id,
        reason: snapshot.reason,
        error: snapshot.error
      });
      continue;
    }

    const clientIdResult = extractJsonPathValue(snapshot.sessionStorageValue, config.sessionStorageJsonPath);
    if (!clientIdResult.ok) {
      failures.push({
        tabId: tab.id,
        reason: clientIdResult.reason,
        sessionStorageKey: config.sessionStorageKey,
        sessionStorageJsonPath: config.sessionStorageJsonPath
      });
      continue;
    }

    const clientIdValue = stringifyQueryValue(clientIdResult.value);
    if (isNonEmptyValue(clientIdValue)) {
      return {
        ok: true,
        tab,
        snapshot,
        clientIdValue
      };
    }

    failures.push({
      tabId: tab.id,
      reason: "missing-client-id",
      sessionStorageKey: config.sessionStorageKey,
      sessionStorageJsonPath: config.sessionStorageJsonPath
    });
  }

  return {
    ok: false,
    failures
  };
}

async function readWebSocketStorageSnapshot(tab, config) {
  if (!tab.id) {
    return {
      ok: false,
      reason: "missing-tab-id"
    };
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: {
        tabId: tab.id,
        allFrames: false
      },
      func: readWebSocketStorageInPage,
      args: [normalizeWebSocketWatcherConfig(config)]
    });

    const result = results.find((item) => item.result)?.result;
    if (!result?.ok) {
      return {
        ok: false,
        reason: result?.reason || "storage-read-failed",
        error: result?.error
      };
    }

    return result;
  } catch (error) {
    return {
      ok: false,
      reason: "execute-script-failed",
      error: normalizeError(error)
    };
  }
}

function buildWebSocketConnectionCandidate(config, localStorageResult, sessionStorageResult) {
  return {
    ok: true,
    tabId: localStorageResult.tab.id,
    pageUrl: localStorageResult.snapshot.href || localStorageResult.tab.url,
    sessionTabId: sessionStorageResult.tab.id,
    sessionPageUrl: sessionStorageResult.snapshot.href || sessionStorageResult.tab.url,
    localStorageKey: config.localStorageKey,
    localStorageValue: localStorageResult.localStorageValue,
    sessionStorageKey: config.sessionStorageKey,
    clientIdValue: sessionStorageResult.clientIdValue
  };
}

function connectOrUpdateWebSocket(target, config, candidate, reason) {
  const urlResult = buildWebSocketUrl(config, candidate);
  if (!urlResult.ok) {
    logError("Could not build WebSocket URL.", {
      reason,
      targetId: target.id,
      webSocketUrl: redactWebSocketUrl(config.url),
      error: urlResult.error
    });
    return;
  }

  const existing = webSocketConnections.get(target.id);
  if (existing?.url === urlResult.url && isWebSocketUsable(existing.socket)) {
    logInfo("Keeping existing WebSocket connection.", {
      reason,
      targetId: target.id,
      tabId: existing.tabId,
      readyState: getWebSocketReadyStateName(existing.socket.readyState),
      webSocketUrl: redactWebSocketUrl(existing.url)
    });
    return;
  }

  disconnectWebSocket(
    target.id,
    existing ? "websocket-query-changed-or-stale" : "preparing-new-websocket-connection"
  );
  clearWebSocketReconnectTimer(target.id);

  let socket;
  try {
    socket = new WebSocket(urlResult.url);
  } catch (error) {
    logError("Failed to create WebSocket.", {
      reason,
      targetId: target.id,
      tabId: candidate.tabId,
      webSocketUrl: redactWebSocketUrl(urlResult.url),
      error
    });
    scheduleWebSocketReconnect(target.id, config.reconnectDelayMs, "websocket-constructor-failed");
    return;
  }

  const connection = {
    socket,
    url: urlResult.url,
    targetId: target.id,
    tabId: candidate.tabId,
    pageUrl: candidate.pageUrl,
    expectedClose: false,
    openedAt: null
  };
  webSocketConnections.set(target.id, connection);

  socket.addEventListener("open", () => {
    connection.openedAt = Date.now();
    logInfo("WebSocket connected.", {
      reason,
      targetId: target.id,
      tabId: candidate.tabId,
      pageUrl: candidate.pageUrl,
      webSocketUrl: redactWebSocketUrl(urlResult.url)
    });
  });

  socket.addEventListener("message", (event) => {
    if (!config.logMessages) {
      return;
    }

    logInfo("WebSocket message received.", {
      targetId: target.id,
      tabId: candidate.tabId,
      dataType: typeof event.data,
      dataLength: getWebSocketMessageLength(event.data)
    });
  });

  socket.addEventListener("error", (event) => {
    logError("WebSocket error.", {
      targetId: target.id,
      tabId: candidate.tabId,
      readyState: getWebSocketReadyStateName(socket.readyState),
      webSocketUrl: redactWebSocketUrl(urlResult.url),
      error: serializeWebSocketEvent(event)
    });
  });

  socket.addEventListener("close", (event) => {
    const current = webSocketConnections.get(target.id);
    const isCurrentConnection = current?.socket === socket;
    if (isCurrentConnection) {
      webSocketConnections.delete(target.id);
    }

    logInfo(connection.expectedClose ? "WebSocket closed." : "WebSocket closed unexpectedly.", {
      targetId: target.id,
      tabId: candidate.tabId,
      code: event.code,
      reason: event.reason,
      wasClean: event.wasClean,
      expectedClose: connection.expectedClose,
      webSocketUrl: redactWebSocketUrl(urlResult.url)
    });

    if (!connection.expectedClose) {
      scheduleWebSocketReconnect(target.id, config.reconnectDelayMs, `websocket-close:${event.code}`);
    }
  });

  logInfo("WebSocket connecting.", {
    reason,
    targetId: target.id,
    tabId: candidate.tabId,
    pageUrl: candidate.pageUrl,
    sessionTabId: candidate.sessionTabId,
    sessionPageUrl: candidate.sessionPageUrl,
    webSocketUrl: redactWebSocketUrl(urlResult.url)
  });
}

function disconnectWebSocket(targetId, reason) {
  const connection = webSocketConnections.get(targetId);
  clearWebSocketReconnectTimer(targetId);

  if (!connection) {
    return;
  }

  connection.expectedClose = true;
  webSocketConnections.delete(targetId);

  try {
    if (connection.socket.readyState === WebSocket.CONNECTING || connection.socket.readyState === WebSocket.OPEN) {
      connection.socket.close(1000, safeCloseReason(reason));
    }
  } catch (error) {
    logWarn("Failed to close WebSocket cleanly.", {
      targetId,
      reason,
      error
    });
  }

  logInfo("Closing WebSocket connection.", {
    targetId,
    reason,
    readyState: getWebSocketReadyStateName(connection.socket.readyState),
    webSocketUrl: redactWebSocketUrl(connection.url)
  });
}

function scheduleWebSocketReconnect(targetId, delayMs, reason) {
  clearWebSocketReconnectTimer(targetId);

  const timerId = setTimeout(() => {
    webSocketReconnectTimers.delete(targetId);
    const target = getWebSocketTargets().find((item) => item.id === targetId);
    if (!target) {
      return;
    }

    void reconcileWebSocketTarget(target, reason);
  }, delayMs);

  webSocketReconnectTimers.set(targetId, timerId);
  logInfo("Scheduled WebSocket reconnect.", {
    targetId,
    reason,
    delayMs
  });
}

function clearWebSocketReconnectTimer(targetId) {
  const timerId = webSocketReconnectTimers.get(targetId);
  if (!timerId) {
    return;
  }

  clearTimeout(timerId);
  webSocketReconnectTimers.delete(targetId);
}

export async function handleWebSocketStorageChangedMessage(message, sender) {
  const target = getWebSocketTargets().find((item) => item.id === message.targetId);
  if (!target || !sender.tab?.id) {
    return;
  }

  const config = normalizeWebSocketConfig(target);
  const targetUrlPageTarget = getWebSocketPageTarget(target, config);
  const sessionPageTarget = getWebSocketSessionPageTarget(target);
  const tabUrl = sender.tab.url || message.href;
  const isTargetUrlTab = tabUrl && matchesTargetUrl(tabUrl, targetUrlPageTarget);
  const isSessionPageTab = tabUrl && sessionPageTarget && matchesTargetUrl(tabUrl, sessionPageTarget);
  if (!isTargetUrlTab && !isSessionPageTab) {
    return;
  }

  logInfo("WebSocket storage watcher triggered reconcile.", {
    targetId: target.id,
    tabId: sender.tab.id,
    href: message.href,
    reason: message.reason,
    source: isTargetUrlTab ? "targetUrl" : "pageUrl"
  });

  await reconcileWebSocketTarget(target, `storage-watcher:${message.reason || "changed"}`);
}

function getExistingWebSocketState(targetId) {
  const connection = webSocketConnections.get(targetId);
  if (!connection) {
    return "none";
  }

  return getWebSocketReadyStateName(connection.socket.readyState);
}
