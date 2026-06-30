import { KEEP_ALIVE_CONFIG } from "./config.js";
import { WEBSOCKET_RECONCILE_ALARM, WEBSOCKET_SESSION_PAGE_TABS_STORAGE_KEY } from "./constants.js";
import { formatTimestamp, logError, logInfo, logWarn, normalizeError } from "./logger.js";
import {
  executeWebSocketCommandFetchInPage,
  installWebSocketStorageWatcherInPage,
  readWebSocketStorageInPage,
  showLoginPromptInPage
} from "./page-scripts.js";
import {
  getWebSocketPageTarget,
  getWebSocketSessionPageTarget,
  getWebSocketTargets,
  normalizeLoginPrompt,
  normalizeWebSocketConfig,
  normalizeWebSocketReconcileIntervalMinutes,
  normalizeWebSocketWatcherConfig
} from "./target-config.js";
import {
  findMatchingTabs,
  getQueryUrlPatterns,
  matchesTargetUrl,
  sortPreferredTabs,
  waitForTabComplete
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
const webSocketSessionPageOpenPromises = new Map();
const webSocketSessionPageTabRecords = new Map();

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

  await clearDisabledWebSocketSessionPageTabRecords(enabledTargetIds);

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
  let sessionPageTabs = sessionPageTarget ? await findMatchingTabs(sessionPageTarget, { log: false }) : [];

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

  if (sessionPageTarget && !sessionPageTabs.length) {
    sessionPageTabs = await openWebSocketSessionPageIfMissing(target, sessionPageTarget, reason);
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

async function openWebSocketSessionPageIfMissing(target, sessionPageTarget, reason) {
  if (!target.pageUrl) {
    return [];
  }

  const recordedTab = await getRecordedWebSocketSessionPageTab(target);
  if (recordedTab) {
    if (recordedTab.url && matchesTargetUrl(recordedTab.url, sessionPageTarget)) {
      return [recordedTab];
    }

    logInfo("Skipping WebSocket pageUrl open because the previously opened tab is still alive.", {
      reason,
      targetId: target.id,
      tabId: recordedTab.id,
      currentUrl: recordedTab.url,
      status: recordedTab.status,
      pageUrl: target.pageUrl
    });

    return [];
  }

  const existingOpenPromise = webSocketSessionPageOpenPromises.get(target.id);
  if (existingOpenPromise) {
    logInfo("Waiting for existing WebSocket pageUrl open.", {
      reason,
      targetId: target.id,
      pageUrl: target.pageUrl
    });

    await existingOpenPromise;
    return findMatchingTabs(sessionPageTarget, { log: false });
  }

  const openPromise = openWebSocketSessionPage(target, reason);
  webSocketSessionPageOpenPromises.set(target.id, openPromise);

  try {
    await openPromise;
  } finally {
    if (webSocketSessionPageOpenPromises.get(target.id) === openPromise) {
      webSocketSessionPageOpenPromises.delete(target.id);
    }
  }

  return findMatchingTabs(sessionPageTarget, { log: false });
}

async function openWebSocketSessionPage(target, reason) {
  logInfo("TargetUrl is open but pageUrl is missing; opening pageUrl for WebSocket.", {
    reason,
    targetId: target.id,
    pageUrl: target.pageUrl,
    activeWhenOpened: target.activeWhenOpened !== false
  });

  try {
    const createdTab = await chrome.tabs.create({
      url: target.pageUrl,
      active: target.activeWhenOpened !== false
    });
    await rememberWebSocketSessionPageTab(target, createdTab);

    await waitForTabComplete(createdTab.id, target.pageLoadTimeoutMs ?? 30000);
    await showWebSocketLoginPrompt(createdTab, target);

    logInfo("Opened pageUrl for WebSocket.", {
      reason,
      targetId: target.id,
      tabId: createdTab.id,
      url: createdTab.url || target.pageUrl
    });
  } catch (error) {
    logWarn("Could not open pageUrl for WebSocket.", {
      reason,
      targetId: target.id,
      pageUrl: target.pageUrl,
      error
    });
  }
}

async function getRecordedWebSocketSessionPageTab(target) {
  const record = await readWebSocketSessionPageTabRecord(target.id);
  if (!record?.tabId) {
    return null;
  }

  if (record.pageUrl !== target.pageUrl) {
    await forgetWebSocketSessionPageTab(target.id);
    return null;
  }

  try {
    const tab = await chrome.tabs.get(record.tabId);
    if (!tab?.id) {
      await forgetWebSocketSessionPageTab(target.id);
      return null;
    }

    return tab;
  } catch (error) {
    await forgetWebSocketSessionPageTab(target.id);
    logInfo("Previously opened WebSocket pageUrl tab is gone.", {
      targetId: target.id,
      tabId: record.tabId,
      pageUrl: record.pageUrl,
      error: normalizeError(error)
    });
    return null;
  }
}

async function rememberWebSocketSessionPageTab(target, tab) {
  if (!tab?.id) {
    return;
  }

  const record = {
    tabId: tab.id,
    pageUrl: target.pageUrl,
    openedAt: Date.now()
  };
  webSocketSessionPageTabRecords.set(target.id, record);

  try {
    const records = await readStoredWebSocketSessionPageTabRecords();
    records[target.id] = record;
    await chrome.storage.local.set({
      [WEBSOCKET_SESSION_PAGE_TABS_STORAGE_KEY]: records
    });
  } catch (error) {
    logWarn("Could not persist opened WebSocket pageUrl tab.", {
      targetId: target.id,
      tabId: tab.id,
      pageUrl: target.pageUrl,
      error
    });
  }
}

async function readWebSocketSessionPageTabRecord(targetId) {
  if (webSocketSessionPageTabRecords.has(targetId)) {
    return webSocketSessionPageTabRecords.get(targetId);
  }

  try {
    const records = await readStoredWebSocketSessionPageTabRecords();
    const record = records[targetId] || null;
    if (record) {
      webSocketSessionPageTabRecords.set(targetId, record);
    }
    return record;
  } catch (error) {
    logWarn("Could not read persisted WebSocket pageUrl tab.", {
      targetId,
      error
    });
    return null;
  }
}

async function forgetWebSocketSessionPageTab(targetId) {
  webSocketSessionPageTabRecords.delete(targetId);

  try {
    const records = await readStoredWebSocketSessionPageTabRecords();
    if (!records[targetId]) {
      return;
    }

    delete records[targetId];
    await chrome.storage.local.set({
      [WEBSOCKET_SESSION_PAGE_TABS_STORAGE_KEY]: records
    });
  } catch (error) {
    logWarn("Could not clear persisted WebSocket pageUrl tab.", {
      targetId,
      error
    });
  }
}

async function clearDisabledWebSocketSessionPageTabRecords(enabledTargetIds) {
  try {
    const records = await readStoredWebSocketSessionPageTabRecords();
    let changed = false;

    for (const targetId of Object.keys(records)) {
      if (enabledTargetIds.has(targetId)) {
        continue;
      }

      changed = true;
      webSocketSessionPageTabRecords.delete(targetId);
      delete records[targetId];
    }

    if (changed) {
      await chrome.storage.local.set({
        [WEBSOCKET_SESSION_PAGE_TABS_STORAGE_KEY]: records
      });
    }
  } catch (error) {
    logWarn("Could not clear disabled WebSocket pageUrl tab records.", {
      error
    });
  }
}

async function readStoredWebSocketSessionPageTabRecords() {
  const stored = await chrome.storage.local.get(WEBSOCKET_SESSION_PAGE_TABS_STORAGE_KEY);
  const records = stored[WEBSOCKET_SESSION_PAGE_TABS_STORAGE_KEY];
  if (!records || typeof records !== "object" || Array.isArray(records)) {
    return {};
  }

  return { ...records };
}

async function showWebSocketLoginPrompt(tab, target) {
  if (!tab.id || target.promptLoginWhenOpened === false) {
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: {
        tabId: tab.id,
        allFrames: false
      },
      func: showLoginPromptInPage,
      args: [normalizeLoginPrompt(target)]
    });

    logInfo("Displayed login prompt in WebSocket pageUrl.", {
      targetId: target.id,
      tabId: tab.id
    });
  } catch (error) {
    logWarn("Could not show login prompt in WebSocket pageUrl.", {
      targetId: target.id,
      tabId: tab.id,
      error
    });
  }
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
    existing.tabId = candidate.tabId;
    existing.pageUrl = candidate.pageUrl;
    existing.sessionTabId = candidate.sessionTabId;
    existing.sessionPageUrl = candidate.sessionPageUrl;
    syncWebSocketKeepAlive(existing, config, reason);

    logInfo("Keeping existing WebSocket connection.", {
      reason,
      targetId: target.id,
      tabId: existing.tabId,
      sessionTabId: existing.sessionTabId,
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
    sessionTabId: candidate.sessionTabId,
    sessionPageUrl: candidate.sessionPageUrl,
    expectedClose: false,
    openedAt: null,
    keepAliveTimerId: null,
    keepAliveIntervalMs: 0,
    keepAlivePayload: null
  };
  webSocketConnections.set(target.id, connection);

  socket.addEventListener("open", () => {
    connection.openedAt = Date.now();
    syncWebSocketKeepAlive(connection, config, reason);
    logInfo("WebSocket connected.", {
      reason,
      targetId: target.id,
      tabId: candidate.tabId,
      pageUrl: candidate.pageUrl,
      webSocketUrl: redactWebSocketUrl(urlResult.url)
    });
  });

  socket.addEventListener("message", (event) => {
    void handleWebSocketMessage(target, config, connection, event);
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
    stopWebSocketKeepAlive(connection);

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

function syncWebSocketKeepAlive(connection, config, reason) {
  if (connection.socket.readyState !== WebSocket.OPEN) {
    return;
  }

  if (!config.keepAliveIntervalMs || config.keepAliveMessage == null) {
    stopWebSocketKeepAlive(connection);
    return;
  }

  const payloadResult = serializeWebSocketKeepAliveMessage(config.keepAliveMessage);
  if (!payloadResult.ok) {
    stopWebSocketKeepAlive(connection);
    logWarn("Could not serialize WebSocket keepalive message.", {
      targetId: connection.targetId,
      reason,
      error: payloadResult.error
    });
    return;
  }

  if (
    connection.keepAliveTimerId &&
    connection.keepAliveIntervalMs === config.keepAliveIntervalMs &&
    connection.keepAlivePayload === payloadResult.payload
  ) {
    return;
  }

  stopWebSocketKeepAlive(connection);
  connection.keepAliveIntervalMs = config.keepAliveIntervalMs;
  connection.keepAlivePayload = payloadResult.payload;
  connection.keepAliveTimerId = setInterval(() => {
    sendWebSocketKeepAlive(connection);
  }, config.keepAliveIntervalMs);

  logInfo("Started WebSocket keepalive.", {
    targetId: connection.targetId,
    reason,
    intervalMs: config.keepAliveIntervalMs
  });
}

function sendWebSocketKeepAlive(connection) {
  const current = webSocketConnections.get(connection.targetId);
  if (current?.socket !== connection.socket || connection.socket.readyState !== WebSocket.OPEN) {
    stopWebSocketKeepAlive(connection);
    return;
  }

  try {
    connection.socket.send(connection.keepAlivePayload);
  } catch (error) {
    logWarn("Failed to send WebSocket keepalive.", {
      targetId: connection.targetId,
      readyState: getWebSocketReadyStateName(connection.socket.readyState),
      error
    });
  }
}

function stopWebSocketKeepAlive(connection) {
  if (connection.keepAliveTimerId) {
    clearInterval(connection.keepAliveTimerId);
  }

  connection.keepAliveTimerId = null;
  connection.keepAliveIntervalMs = 0;
  connection.keepAlivePayload = null;
}

function serializeWebSocketKeepAliveMessage(message) {
  if (typeof message === "string") {
    return {
      ok: true,
      payload: message
    };
  }

  try {
    return {
      ok: true,
      payload: JSON.stringify(message)
    };
  } catch (error) {
    return {
      ok: false,
      error: normalizeError(error)
    };
  }
}

async function handleWebSocketMessage(target, config, connection, event) {
  if (config.logMessages) {
    logInfo("WebSocket message received.", {
      targetId: target.id,
      tabId: connection.tabId,
      sessionTabId: connection.sessionTabId,
      dataType: getWebSocketMessageDataType(event.data),
      dataLength: getWebSocketMessageLength(event.data)
    });
  }

  const parsed = await parseWebSocketJsonMessage(event.data);
  if (!parsed.ok) {
    if (config.logMessages) {
      logWarn("Ignored non-JSON WebSocket message.", {
        targetId: target.id,
        tabId: connection.tabId,
        reason: parsed.reason,
        error: parsed.error
      });
    }
    return;
  }

  const message = parsed.value;
  if (!message || typeof message !== "object" || Array.isArray(message) || message.type !== "command") {
    return;
  }

  await handleWebSocketCommandMessage(target, config, connection, message);
}

async function handleWebSocketCommandMessage(target, config, connection, message) {
  logInfo("WebSocket command received.", {
    targetId: target.id,
    tabId: connection.tabId,
    sessionTabId: connection.sessionTabId,
    action: message.action,
    method: message.method || "POST",
    id: message.id
  });

  const result = await executeWebSocketCommandFetch(target, config, connection, message);
  const responseMessage = {
    type: "event",
    action: "client_response",
    payload: result.ok
      ? result.payload
      : {
          ok: false,
          reason: result.reason || "command-fetch-failed",
          error: result.error
        },
    id: message.id
  };

  const sent = sendWebSocketJson(connection, responseMessage);
  logInfo(sent ? "WebSocket command result sent." : "WebSocket command result not sent.", {
    targetId: target.id,
    tabId: connection.tabId,
    sessionTabId: connection.sessionTabId,
    action: message.action,
    id: message.id,
    sent,
    commandOk: result.ok,
    status: result.status,
    responseOk: result.responseOk,
    reason: result.reason
  });
}

async function executeWebSocketCommandFetch(target, config, connection, message) {
  const tabResult = await resolveWebSocketCommandTab(target, connection);
  if (!tabResult.ok) {
    return tabResult;
  }

  const command = {
    action: message.action,
    method: message.method,
    csrfTokenUrl: config.csrfTokenUrl,
    gpmpCsrfTokenUrl: config.gpmpCsrfTokenUrl,
    headers: config.commandHeaders
  };
  if (methodSupportsRequestBody(message.method)) {
    command.payload = message.payload;
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: {
        tabId: tabResult.tab.id,
        allFrames: false
      },
      world: "MAIN",
      func: executeWebSocketCommandFetchInPage,
      args: [command]
    });

    const result = results.find((item) => item.result)?.result;
    if (!result) {
      return {
        ok: false,
        reason: "command-fetch-no-result",
        tabId: tabResult.tab.id
      };
    }

    return {
      ...result,
      tabId: tabResult.tab.id
    };
  } catch (error) {
    return {
      ok: false,
      reason: "command-fetch-execute-script-failed",
      tabId: tabResult.tab.id,
      error: normalizeError(error)
    };
  }
}

function methodSupportsRequestBody(method) {
  const normalizedMethod = String(method || "POST").trim().toUpperCase();
  return normalizedMethod !== "GET" && normalizedMethod !== "HEAD";
}

async function resolveWebSocketCommandTab(target, connection) {
  const sessionPageTarget = getWebSocketSessionPageTarget(target);
  if (!sessionPageTarget) {
    return {
      ok: false,
      reason: "missing-page-url-target"
    };
  }

  if (connection.sessionTabId) {
    try {
      const tab = await chrome.tabs.get(connection.sessionTabId);
      if (tab?.id && tab.url && matchesTargetUrl(tab.url, sessionPageTarget)) {
        return {
          ok: true,
          tab
        };
      }
    } catch (error) {
      logWarn("Stored WebSocket pageUrl tab is unavailable.", {
        targetId: target.id,
        sessionTabId: connection.sessionTabId,
        error
      });
    }
  }

  const tabs = await findMatchingTabs(sessionPageTarget, { log: false });
  const tab = sortPreferredTabs(tabs)[0];
  if (!tab?.id) {
    return {
      ok: false,
      reason: "no-page-url-tab-for-command"
    };
  }

  connection.sessionTabId = tab.id;
  connection.sessionPageUrl = tab.url;

  return {
    ok: true,
    tab
  };
}

function sendWebSocketJson(connection, message) {
  const current = webSocketConnections.get(connection.targetId);
  if (current?.socket !== connection.socket || connection.socket.readyState !== WebSocket.OPEN) {
    return false;
  }

  try {
    connection.socket.send(JSON.stringify(message));
    return true;
  } catch (error) {
    logWarn("Failed to send WebSocket message.", {
      targetId: connection.targetId,
      readyState: getWebSocketReadyStateName(connection.socket.readyState),
      error
    });
    return false;
  }
}

async function parseWebSocketJsonMessage(data) {
  const textResult = await readWebSocketMessageText(data);
  if (!textResult.ok) {
    return textResult;
  }

  try {
    return {
      ok: true,
      value: JSON.parse(textResult.text)
    };
  } catch (error) {
    return {
      ok: false,
      reason: "invalid-json-message",
      error: normalizeError(error)
    };
  }
}

async function readWebSocketMessageText(data) {
  if (typeof data === "string") {
    return {
      ok: true,
      text: data
    };
  }

  try {
    if (typeof Blob !== "undefined" && data instanceof Blob) {
      return {
        ok: true,
        text: await data.text()
      };
    }

    if (data instanceof ArrayBuffer) {
      return {
        ok: true,
        text: new TextDecoder().decode(data)
      };
    }

    if (ArrayBuffer.isView(data)) {
      return {
        ok: true,
        text: new TextDecoder().decode(data)
      };
    }
  } catch (error) {
    return {
      ok: false,
      reason: "message-read-failed",
      error: normalizeError(error)
    };
  }

  return {
    ok: false,
    reason: "unsupported-message-data"
  };
}

function getWebSocketMessageDataType(data) {
  if (data === null) {
    return "null";
  }

  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return "Blob";
  }

  if (data instanceof ArrayBuffer) {
    return "ArrayBuffer";
  }

  if (ArrayBuffer.isView(data)) {
    return data.constructor?.name || "TypedArray";
  }

  return typeof data;
}

function disconnectWebSocket(targetId, reason) {
  const connection = webSocketConnections.get(targetId);
  clearWebSocketReconnectTimer(targetId);

  if (!connection) {
    return;
  }

  connection.expectedClose = true;
  webSocketConnections.delete(targetId);
  stopWebSocketKeepAlive(connection);

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
