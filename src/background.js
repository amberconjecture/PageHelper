import { KEEP_ALIVE_CONFIG } from "./config.js";

const ALARM_PREFIX = "pagehelper.keepAlive.";
const WEBSOCKET_RECONCILE_ALARM = "pagehelper.webSocket.reconcile";
const DEFAULT_INTERVAL_MINUTES = 50;
const MIN_INTERVAL_MINUTES = 1;
const DEFAULT_WAIT_FOR_SELECTOR_MS = 10000;
const DEFAULT_WEBSOCKET_STORAGE_CHECK_INTERVAL_MS = 3000;
const DEFAULT_WEBSOCKET_RECONNECT_DELAY_MS = 5000;
const DEFAULT_WEBSOCKET_RECONCILE_INTERVAL_MINUTES = 1;
const LOG_STORAGE_KEY = "pagehelper.logs";
const LOG_LIMIT = 300;
const webSocketConnections = new Map();
const webSocketReconnectTimers = new Map();

chrome.runtime.onInstalled.addListener((details) => {
  void setupAlarms(`runtime.onInstalled:${details.reason}`);
  void setupWebSocketSupport(`runtime.onInstalled:${details.reason}`);
});

chrome.runtime.onStartup.addListener(() => {
  void setupAlarms("runtime.onStartup");
  void setupWebSocketSupport("runtime.onStartup");
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === WEBSOCKET_RECONCILE_ALARM) {
    logInfo("WebSocket reconcile alarm fired.", {
      alarmName: alarm.name,
      scheduledTime: formatTimestamp(alarm.scheduledTime),
      periodInMinutes: alarm.periodInMinutes
    });
    void reconcileWebSockets("websocket-reconcile-alarm");
    return;
  }

  if (!alarm.name.startsWith(ALARM_PREFIX)) {
    return;
  }

  logInfo("Alarm fired.", {
    alarmName: alarm.name,
    scheduledTime: formatTimestamp(alarm.scheduledTime),
    periodInMinutes: alarm.periodInMinutes
  });

  const targetId = alarm.name.slice(ALARM_PREFIX.length);
  const target = getEnabledTargets().find((item) => item.id === targetId);
  if (!target) {
    logWarn("Alarm target is no longer enabled; clearing stale alarm.", {
      alarmName: alarm.name,
      targetId
    });
    void chrome.alarms.clear(alarm.name);
    return;
  }

  void runTarget(target, "alarm");
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

// Reconcile alarms whenever the MV3 service worker wakes. This makes unpacked
// extension reloads and edited developer config much easier to diagnose.
void setupAlarms("service-worker-start");
void setupWebSocketSupport("service-worker-start");

async function setupAlarms(reason) {
  const targets = getEnabledTargets();
  const expectedNames = new Set(targets.map((target) => alarmNameFor(target)));
  const existingAlarms = await chrome.alarms.getAll();
  const existingPageHelperAlarms = existingAlarms.filter((alarm) => alarm.name.startsWith(ALARM_PREFIX));

  logInfo("Setting up alarms.", {
    reason,
    configuredTargetCount: normalizeArray(KEEP_ALIVE_CONFIG.targets).length,
    enabledTargetIds: targets.map((target) => target.id),
    existingAlarmNames: existingPageHelperAlarms.map((alarm) => alarm.name)
  });

  if (!targets.length) {
    const webSocketTargets = getWebSocketTargets();
    const details = {
      configuredTargets: summarizeTargets(normalizeArray(KEEP_ALIVE_CONFIG.targets)),
      enabledWebSocketTargetIds: webSocketTargets.map((target) => target.id)
    };

    if (webSocketTargets.length) {
      logInfo("No enabled keep-alive targets; WebSocket-only configuration is active.", details);
    } else {
      logWarn("No enabled keep-alive targets. Configure a selector to enable timed clicks, or enable webSocket for a target.", details);
    }
  }

  await Promise.all(
    existingPageHelperAlarms
      .filter((alarm) => !expectedNames.has(alarm.name))
      .map(async (alarm) => {
        await chrome.alarms.clear(alarm.name);
        logInfo("Cleared stale alarm.", { alarmName: alarm.name });
      })
  );

  await Promise.all(
    targets.map((target) =>
      createOrUpdateAlarm(
        target,
        existingPageHelperAlarms.find((alarm) => alarm.name === alarmNameFor(target))
      )
    )
  );
  logInfo("Alarm setup complete.", { enabledTargetIds: targets.map((target) => target.id) });
}

async function setupWebSocketSupport(reason) {
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

async function reconcileWebSockets(reason) {
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
  const pageTarget = getWebSocketPageTarget(target, config);
  const tabs = await findMatchingTabs(pageTarget, { log: false });

  logInfo("Queried WebSocket target tabs.", {
    reason,
    targetId: target.id,
    queryPatterns: getQueryUrlPatterns(pageTarget),
    matchingCount: tabs.length,
    tabIds: tabs.map((tab) => tab.id)
  });

  if (!tabs.length) {
    disconnectWebSocket(target.id, "no-matching-tabs");
    return;
  }

  await Promise.all(tabs.map((tab) => installWebSocketStorageWatcher(tab, target, config)));

  const candidate = await findWebSocketConnectionCandidate(tabs, config);
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

async function createOrUpdateAlarm(target, existingAlarm) {
  const intervalMinutes = normalizeIntervalMinutes(target.intervalMinutes);
  const startDelaySeconds = normalizeStartDelaySeconds(target.startDelaySeconds);
  const alarmName = alarmNameFor(target);

  if (existingAlarm?.periodInMinutes === intervalMinutes) {
    logInfo("Keeping existing alarm.", {
      targetId: target.id,
      alarmName,
      nextRunAt: formatTimestamp(existingAlarm.scheduledTime),
      intervalMinutes
    });
    return;
  }

  const firstRunAt = Date.now() + startDelaySeconds * 1000;
  await chrome.alarms.create(alarmName, {
    when: firstRunAt,
    periodInMinutes: intervalMinutes
  });

  logInfo("Created alarm.", {
    targetId: target.id,
    alarmName,
    firstRunAt: formatTimestamp(firstRunAt),
    intervalMinutes,
    startDelaySeconds,
    pageUrl: target.pageUrl,
    openIfMissing: target.openIfMissing !== false,
    urlPatterns: getQueryUrlPatterns(target),
    urlIncludes: normalizeArray(target.urlIncludes),
    urlRegexes: normalizeArray(target.urlRegexes),
    selectors: getSelectors(target)
  });
}

async function runTarget(target, trigger) {
  logInfo("Running target.", {
    trigger,
    targetId: target.id,
    pageUrl: target.pageUrl,
    queryUrlPatterns: getQueryUrlPatterns(target),
    openIfMissing: shouldOpenIfMissing(target),
    intervalMinutes: normalizeIntervalMinutes(target.intervalMinutes),
    selectors: getSelectors(target)
  });

  const tabs = await findMatchingTabs(target);
  let tabsToClick = tabs;

  if (!tabsToClick.length && shouldOpenIfMissing(target)) {
    logInfo("No matching tab found; opening configured page.", {
      targetId: target.id,
      pageUrl: target.pageUrl,
      activeWhenOpened: target.activeWhenOpened !== false
    });

    const createdTab = await chrome.tabs.create({
      url: target.pageUrl,
      active: target.activeWhenOpened !== false
    });

    await waitForTabComplete(createdTab.id, target.pageLoadTimeoutMs ?? 30000);
    await showLoginPrompt(createdTab, target);
    logInfo("Opened page and prompted the user to sign in.", {
      targetId: target.id,
      tabId: createdTab.id,
      url: createdTab.url
    });
    void reconcileWebSockets(`runTarget-opened-page:${target.id}`);
    return;
  }

  if (!tabsToClick.length) {
    logWarn("No matching tab and openIfMissing is disabled or pageUrl is missing.", {
      targetId: target.id,
      openIfMissing: target.openIfMissing,
      pageUrl: target.pageUrl
    });
    return;
  }

  if (!target.clickAllMatchingTabs) {
    tabsToClick = [selectPreferredTab(tabsToClick)];
  }

  logInfo("Clicking matching tabs.", {
    targetId: target.id,
    tabIds: tabsToClick.map((tab) => tab.id),
    clickAllMatchingTabs: Boolean(target.clickAllMatchingTabs)
  });

  await Promise.all(tabsToClick.map((tab) => clickTabTarget(tab, target)));
}

async function findMatchingTabs(target, options = {}) {
  const queryPatterns = getQueryUrlPatterns(target);
  const tabs = await chrome.tabs.query(queryPatterns.length ? { url: queryPatterns } : {});
  const matchingTabs = tabs.filter((tab) => tab.id && tab.url && matchesTargetUrl(tab.url, target));

  if (options.log !== false) {
    logInfo("Queried tabs.", {
      targetId: target.id,
      queryPatterns,
      candidateCount: tabs.length,
      matchingCount: matchingTabs.length,
      candidates: tabs.map((tab) => ({
        id: tab.id,
        active: tab.active,
        status: tab.status,
        url: tab.url
      }))
    });
  }

  return matchingTabs;
}

function selectPreferredTab(tabs) {
  return sortPreferredTabs(tabs)[0];
}

function sortPreferredTabs(tabs) {
  return [...tabs].sort((a, b) => {
    if (a.active !== b.active) {
      return a.active ? -1 : 1;
    }

    return (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0);
  });
}

async function clickTabTarget(tab, target) {
  try {
    const results = await chrome.scripting.executeScript({
      target: {
        tabId: tab.id,
        allFrames: target.allFrames !== false
      },
      world: "MAIN",
      func: clickElementInPage,
      args: [normalizeInjectionTarget(target)]
    });

    const success = results.find((item) => item.result?.ok);
    if (success) {
      logInfo("Clicked target element.", {
        targetId: target.id,
        tabId: tab.id,
        result: success.result
      });
      return;
    }

    logWarn("Could not click target element.", {
      targetId: target.id,
      tabId: tab.id,
      results
    });
  } catch (error) {
    logError("Failed to click target element.", {
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

async function findWebSocketConnectionCandidate(tabs, config) {
  const failures = [];

  for (const tab of sortPreferredTabs(tabs)) {
    const snapshot = await readWebSocketStorageSnapshot(tab, target, config);
    if (!snapshot.ok) {
      failures.push({
        tabId: tab.id,
        reason: snapshot.reason,
        error: snapshot.error
      });
      continue;
    }

    const candidate = buildWebSocketConnectionCandidate(tab, config, snapshot);
    if (candidate.ok) {
      return candidate;
    }

    failures.push({
      tabId: tab.id,
      reason: candidate.reason,
      localStorageKey: config.localStorageKey,
      sessionStorageKey: config.sessionStorageKey,
      sessionStorageJsonPath: config.sessionStorageJsonPath
    });
  }

  return {
    ok: false,
    failures
  };
}

async function readWebSocketStorageSnapshot(tab, target, config) {
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
      args: [normalizeWebSocketWatcherConfig(target, config)]
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

function buildWebSocketConnectionCandidate(tab, config, snapshot) {
  const localStorageValue = snapshot.localStorageValue;
  if (!isNonEmptyValue(localStorageValue)) {
    return {
      ok: false,
      reason: "missing-local-storage-value"
    };
  }

  const clientIdResult = extractJsonPathValue(snapshot.sessionStorageValue, config.sessionStorageJsonPath);
  if (!clientIdResult.ok) {
    return {
      ok: false,
      reason: clientIdResult.reason
    };
  }

  const clientIdValue = stringifyQueryValue(clientIdResult.value);
  if (!isNonEmptyValue(clientIdValue)) {
    return {
      ok: false,
      reason: "missing-client-id"
    };
  }

  return {
    ok: true,
    tabId: tab.id,
    pageUrl: snapshot.href || tab.url,
    localStorageValue: String(localStorageValue),
    clientIdValue
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

async function handleWebSocketStorageChangedMessage(message, sender) {
  const target = getWebSocketTargets().find((item) => item.id === message.targetId);
  if (!target || !sender.tab?.id) {
    return;
  }

  const config = normalizeWebSocketConfig(target);
  const pageTarget = getWebSocketPageTarget(target, config);
  const tabUrl = sender.tab.url || message.href;
  if (!tabUrl || !matchesTargetUrl(tabUrl, pageTarget)) {
    return;
  }

  const candidate = buildWebSocketConnectionCandidate(sender.tab, config, {
    ok: true,
    href: message.href,
    localStorageValue: message.localStorageValue,
    sessionStorageValue: message.sessionStorageValue
  });

  if (candidate.ok) {
    connectOrUpdateWebSocket(target, config, candidate, `storage-watcher:${message.reason || "changed"}`);
    return;
  }

  logInfo("WebSocket storage watcher reported incomplete prerequisites.", {
    targetId: target.id,
    tabId: sender.tab.id,
    reason: candidate.reason,
    localStorageKey: config.localStorageKey,
    sessionStorageKey: config.sessionStorageKey,
    sessionStorageJsonPath: config.sessionStorageJsonPath
  });
}

async function showLoginPrompt(tab, target) {
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

    logInfo("Displayed login prompt in page.", {
      targetId: target.id,
      tabId: tab.id
    });
  } catch (error) {
    logWarn("Could not show login prompt in page.", {
      targetId: target.id,
      tabId: tab.id,
      error
    });
  }
}

function normalizeLoginPrompt(target) {
  return {
    title: target.loginPromptTitle || "Page Helper opened this page",
    message:
      target.loginPromptMessage ||
      "Please finish signing in. After login, Page Helper will run the configured page action on schedule.",
    durationMs: Math.max(5000, Number(target.loginPromptDurationMs ?? 30000) || 30000)
  };
}

function normalizeInjectionTarget(target) {
  return {
    id: target.id,
    selector: target.selector,
    selectors: normalizeArray(target.selectors),
    waitForSelectorMs: normalizeWaitForSelectorMs(target.waitForSelectorMs),
    scrollIntoView: target.scrollIntoView !== false,
    requireVisible: target.requireVisible !== false,
    clickStrategy: target.clickStrategy || "mouse-events"
  };
}

async function waitForTabComplete(tabId, timeoutMs) {
  if (!tabId) {
    return;
  }

  const tab = await chrome.tabs.get(tabId);
  if (tab.status === "complete") {
    return;
  }

  await new Promise((resolve) => {
    const timeout = setTimeout(cleanup, timeoutMs);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        cleanup();
      }
    }

    function cleanup() {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

function getEnabledTargets() {
  return getConfiguredTargets().filter((target) => {
    if (!getSelectors(target).length) {
      if (!isWebSocketEnabled(target)) {
        logWarn("Ignored keep-alive target without selector.", { targetId: target.id });
      }
      return false;
    }

    return true;
  });
}

function getConfiguredTargets() {
  return normalizeArray(KEEP_ALIVE_CONFIG.targets).filter((target) => {
    if (!target || target.enabled === false) {
      return false;
    }

    if (!target.id) {
      logWarn("Ignored enabled target without id.", { target });
      return false;
    }

    return true;
  });
}

function getWebSocketTargets() {
  return getConfiguredTargets().filter((target) => {
    const config = normalizeWebSocketConfig(target);
    if (!config.enabled) {
      return false;
    }

    if (!config.url) {
      logWarn("Ignored WebSocket target without webSocket.url.", { targetId: target.id });
      return false;
    }

    if (!config.localStorageKey) {
      logWarn("Ignored WebSocket target without webSocket.localStorageKey.", { targetId: target.id });
      return false;
    }

    if (!config.sessionStorageKey) {
      logWarn("Ignored WebSocket target without webSocket.sessionStorageKey.", { targetId: target.id });
      return false;
    }

    return true;
  });
}

function isWebSocketEnabled(target) {
  return normalizeWebSocketConfig(target).enabled;
}

function getSelectors(target) {
  return [target.selector, ...normalizeArray(target.selectors)].filter(Boolean);
}

function normalizeWebSocketConfig(target) {
  const rawConfig = target.webSocket || {};
  const localStorageKey = rawConfig.localStorageKey ?? target.webSocketLocalStorageKey ?? "auth-token";

  return {
    enabled: rawConfig.enabled ?? target.webSocketEnabled ?? false,
    url: rawConfig.url ?? target.webSocketUrl ?? "",
    targetUrl: rawConfig.targetUrl ?? target.webSocketTargetUrl ?? target.pageUrl ?? "",
    targetUrlPatterns: getWebSocketArrayConfig(rawConfig, target, ["targetUrlPatterns", "urlPatterns"], "webSocketUrlPatterns"),
    targetUrlIncludes: getWebSocketArrayConfig(rawConfig, target, ["targetUrlIncludes", "urlIncludes"], "webSocketUrlIncludes"),
    targetUrlRegexes: getWebSocketArrayConfig(rawConfig, target, ["targetUrlRegexes", "urlRegexes"], "webSocketUrlRegexes"),
    localStorageKey,
    localStorageQueryKey: rawConfig.localStorageQueryKey ?? target.webSocketLocalStorageQueryKey ?? localStorageKey,
    sessionStorageKey: rawConfig.sessionStorageKey ?? target.webSocketSessionStorageKey ?? "",
    sessionStorageJsonPath:
      rawConfig.sessionStorageJsonPath ?? target.webSocketSessionStorageJsonPath ?? "$",
    storageCheckIntervalMs: normalizeWebSocketStorageCheckIntervalMs(rawConfig.storageCheckIntervalMs),
    reconnectDelayMs: normalizeWebSocketReconnectDelayMs(rawConfig.reconnectDelayMs),
    logMessages: rawConfig.logMessages === true
  };
}

function getWebSocketPageTarget(target, config = normalizeWebSocketConfig(target)) {
  return {
    ...target,
    pageUrl: config.targetUrl || target.pageUrl,
    urlPatterns: config.targetUrlPatterns ?? target.urlPatterns,
    urlIncludes: config.targetUrlIncludes ?? target.urlIncludes,
    urlRegexes: config.targetUrlRegexes ?? target.urlRegexes
  };
}

function getWebSocketArrayConfig(rawConfig, target, rawKeys, topLevelKey) {
  for (const key of rawKeys) {
    if (hasOwn(rawConfig, key)) {
      return normalizeArray(rawConfig[key]);
    }
  }

  if (hasOwn(target, topLevelKey)) {
    return normalizeArray(target[topLevelKey]);
  }

  return null;
}

function alarmNameFor(target) {
  return `${ALARM_PREFIX}${target.id}`;
}

function shouldOpenIfMissing(target) {
  return Boolean(target.pageUrl) && target.openIfMissing !== false;
}

function getQueryUrlPatterns(target) {
  const explicitPatterns = normalizeArray(target.urlPatterns);
  if (explicitPatterns.length) {
    return explicitPatterns;
  }

  const pattern = target.pageUrl ? hostPatternFromUrl(target.pageUrl) : null;
  return pattern ? [pattern] : [];
}

function hostPatternFromUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!["http:", "https:"].includes(url.protocol)) {
      return null;
    }

    return `${url.protocol}//${url.host}/*`;
  } catch {
    return null;
  }
}

function matchesTargetUrl(url, target) {
  const includes = normalizeArray(target.urlIncludes);
  const regexes = normalizeArray(target.urlRegexes);
  const explicitPatterns = normalizeArray(target.urlPatterns);

  if (includes.length && includes.some((item) => url.includes(item))) {
    return true;
  }

  if (regexes.length && regexes.some((pattern) => matchesRegex(url, pattern))) {
    return true;
  }

  if (includes.length || regexes.length) {
    return false;
  }

  if (explicitPatterns.length) {
    return true;
  }

  if (target.pageUrl && url.startsWith(target.pageUrl)) {
    return true;
  }

  return !target.pageUrl;
}

function matchesRegex(value, pattern) {
  try {
    return new RegExp(pattern).test(value);
  } catch (error) {
    logWarn("Invalid urlRegex.", { pattern, error });
    return false;
  }
}

function normalizeArray(value) {
  if (!value) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(Object(value), key);
}

function normalizeIntervalMinutes(value) {
  const interval = Number(value ?? KEEP_ALIVE_CONFIG.defaultIntervalMinutes ?? DEFAULT_INTERVAL_MINUTES);
  if (!Number.isFinite(interval)) {
    return DEFAULT_INTERVAL_MINUTES;
  }

  return Math.max(MIN_INTERVAL_MINUTES, interval);
}

function normalizeStartDelaySeconds(value) {
  const delay = Number(value ?? KEEP_ALIVE_CONFIG.defaultStartDelaySeconds ?? 10);
  if (!Number.isFinite(delay)) {
    return 10;
  }

  return Math.max(1, delay);
}

function normalizeWaitForSelectorMs(value) {
  const wait = Number(value ?? KEEP_ALIVE_CONFIG.defaultWaitForSelectorMs ?? DEFAULT_WAIT_FOR_SELECTOR_MS);
  if (!Number.isFinite(wait)) {
    return DEFAULT_WAIT_FOR_SELECTOR_MS;
  }

  return Math.max(0, wait);
}

function normalizeWebSocketStorageCheckIntervalMs(value) {
  const interval = Number(
    value ??
      KEEP_ALIVE_CONFIG.defaultWebSocketStorageCheckIntervalMs ??
      DEFAULT_WEBSOCKET_STORAGE_CHECK_INTERVAL_MS
  );
  if (!Number.isFinite(interval)) {
    return DEFAULT_WEBSOCKET_STORAGE_CHECK_INTERVAL_MS;
  }

  return Math.max(1000, interval);
}

function normalizeWebSocketReconnectDelayMs(value) {
  const delay = Number(value ?? KEEP_ALIVE_CONFIG.defaultWebSocketReconnectDelayMs ?? DEFAULT_WEBSOCKET_RECONNECT_DELAY_MS);
  if (!Number.isFinite(delay)) {
    return DEFAULT_WEBSOCKET_RECONNECT_DELAY_MS;
  }

  return Math.max(1000, delay);
}

function normalizeWebSocketReconcileIntervalMinutes(value) {
  const interval = Number(value ?? DEFAULT_WEBSOCKET_RECONCILE_INTERVAL_MINUTES);
  if (!Number.isFinite(interval)) {
    return DEFAULT_WEBSOCKET_RECONCILE_INTERVAL_MINUTES;
  }

  return Math.max(MIN_INTERVAL_MINUTES, interval);
}

function normalizeWebSocketWatcherConfig(target, config = normalizeWebSocketConfig(target)) {
  return {
    targetId: target.id,
    localStorageKey: config.localStorageKey,
    sessionStorageKey: config.sessionStorageKey,
    storageCheckIntervalMs: config.storageCheckIntervalMs
  };
}

function buildWebSocketUrl(config, candidate) {
  try {
    const url = new URL(config.url);
    if (!["ws:", "wss:"].includes(url.protocol)) {
      return {
        ok: false,
        error: `Unsupported WebSocket protocol: ${url.protocol}`
      };
    }

    url.searchParams.set(config.localStorageQueryKey, candidate.localStorageValue);
    url.searchParams.set("client_id", candidate.clientIdValue);

    return {
      ok: true,
      url: url.toString()
    };
  } catch (error) {
    return {
      ok: false,
      error: normalizeError(error)
    };
  }
}

function extractJsonPathValue(rawValue, jsonPath) {
  if (!isNonEmptyValue(rawValue)) {
    return {
      ok: false,
      reason: "missing-session-storage-value"
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    return {
      ok: false,
      reason: "invalid-session-storage-json"
    };
  }

  const pathTokens = parseJsonPath(jsonPath);
  if (!pathTokens.ok) {
    return pathTokens;
  }

  let current = parsed;
  for (const token of pathTokens.tokens) {
    if (current == null || !(token in Object(current))) {
      return {
        ok: false,
        reason: "session-storage-json-path-not-found"
      };
    }

    current = current[token];
  }

  return {
    ok: true,
    value: current
  };
}

function parseJsonPath(jsonPath) {
  const path = String(jsonPath || "$").trim();
  if (!path || path === "$") {
    return {
      ok: true,
      tokens: []
    };
  }

  const input = path.startsWith("$") ? path.slice(1) : path;
  const tokens = [];
  let buffer = "";
  let index = 0;

  while (index < input.length) {
    const char = input[index];

    if (char === ".") {
      pushBuffer();
      index += 1;
      continue;
    }

    if (char === "[") {
      pushBuffer();
      const closeIndex = input.indexOf("]", index);
      if (closeIndex === -1) {
        return {
          ok: false,
          reason: "invalid-json-path"
        };
      }

      const rawToken = input.slice(index + 1, closeIndex).trim();
      const quotedMatch = rawToken.match(/^["'](.*)["']$/);
      const token = quotedMatch ? quotedMatch[1] : rawToken;
      if (!token) {
        return {
          ok: false,
          reason: "invalid-json-path"
        };
      }

      tokens.push(/^\d+$/.test(token) ? Number(token) : token);
      index = closeIndex + 1;
      continue;
    }

    buffer += char;
    index += 1;
  }

  pushBuffer();

  return {
    ok: true,
    tokens
  };

  function pushBuffer() {
    const token = buffer.trim();
    if (token) {
      tokens.push(/^\d+$/.test(token) ? Number(token) : token);
    }
    buffer = "";
  }
}

function isNonEmptyValue(value) {
  return value !== undefined && value !== null && String(value).length > 0;
}

function stringifyQueryValue(value) {
  if (value === undefined || value === null) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return JSON.stringify(value);
}

function isWebSocketUsable(socket) {
  return socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN;
}

function getExistingWebSocketState(targetId) {
  const connection = webSocketConnections.get(targetId);
  if (!connection) {
    return "none";
  }

  return getWebSocketReadyStateName(connection.socket.readyState);
}

function getWebSocketReadyStateName(readyState) {
  switch (readyState) {
    case WebSocket.CONNECTING:
      return "CONNECTING";
    case WebSocket.OPEN:
      return "OPEN";
    case WebSocket.CLOSING:
      return "CLOSING";
    case WebSocket.CLOSED:
      return "CLOSED";
    default:
      return String(readyState);
  }
}

function getWebSocketMessageLength(data) {
  if (typeof data === "string") {
    return data.length;
  }

  if (data instanceof Blob) {
    return data.size;
  }

  if (data instanceof ArrayBuffer) {
    return data.byteLength;
  }

  if (ArrayBuffer.isView(data)) {
    return data.byteLength;
  }

  return null;
}

function serializeWebSocketEvent(event) {
  return {
    type: event.type,
    message: event.message
  };
}

function safeCloseReason(reason) {
  return String(reason || "closed").slice(0, 120);
}

function redactWebSocketUrl(rawUrl) {
  if (!rawUrl) {
    return null;
  }

  try {
    const url = new URL(rawUrl);
    for (const key of [...url.searchParams.keys()]) {
      url.searchParams.set(key, "redacted");
    }
    return url.toString();
  } catch {
    return "<invalid-websocket-url>";
  }
}

function summarizeTargets(targets) {
  return targets.map((target) => ({
    id: target?.id,
    enabled: target?.enabled,
    pageUrl: target?.pageUrl,
    intervalMinutes: target?.intervalMinutes,
    openIfMissing: target?.openIfMissing,
    urlPatterns: normalizeArray(target?.urlPatterns),
    urlIncludes: normalizeArray(target?.urlIncludes),
    urlRegexes: normalizeArray(target?.urlRegexes),
    selectors: target ? getSelectors(target) : [],
    webSocket: target ? summarizeWebSocketConfig(target) : null
  }));
}

function summarizeWebSocketConfig(target) {
  const config = normalizeWebSocketConfig(target);
  const pageTarget = getWebSocketPageTarget(target, config);
  return {
    enabled: config.enabled,
    url: redactWebSocketUrl(config.url),
    targetUrl: pageTarget.pageUrl,
    targetUrlPatterns: normalizeArray(pageTarget.urlPatterns),
    targetUrlIncludes: normalizeArray(pageTarget.urlIncludes),
    targetUrlRegexes: normalizeArray(pageTarget.urlRegexes),
    localStorageKey: config.localStorageKey,
    localStorageQueryKey: config.localStorageQueryKey,
    sessionStorageKey: config.sessionStorageKey,
    sessionStorageJsonPath: config.sessionStorageJsonPath,
    storageCheckIntervalMs: config.storageCheckIntervalMs,
    reconnectDelayMs: config.reconnectDelayMs,
    logMessages: config.logMessages
  };
}


function logInfo(message, details) {
  void writeLog("info", message, details);
}

function logWarn(message, details) {
  void writeLog("warn", message, details);
}

function logError(message, details) {
  void writeLog("error", message, details);
}

async function writeLog(level, message, details) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    details: normalizeLogDetails(details)
  };

  const consoleMethod = level === "error" ? "error" : level === "warn" ? "warn" : "info";
  console[consoleMethod](`[PageHelper] ${entry.ts} ${message}`, entry.details);

  try {
    const existing = await chrome.storage.local.get(LOG_STORAGE_KEY);
    const logs = Array.isArray(existing[LOG_STORAGE_KEY]) ? existing[LOG_STORAGE_KEY] : [];
    logs.push(entry);

    if (logs.length > LOG_LIMIT) {
      logs.splice(0, logs.length - LOG_LIMIT);
    }

    await chrome.storage.local.set({ [LOG_STORAGE_KEY]: logs });
  } catch (error) {
    console.warn("[PageHelper] Failed to persist log entry.", error);
  }
}

function normalizeLogDetails(value) {
  if (value instanceof Error) {
    return normalizeError(value);
  }

  try {
    return JSON.parse(
      JSON.stringify(value, (_key, nestedValue) => {
        if (nestedValue instanceof Error) {
          return normalizeError(nestedValue);
        }

        return nestedValue;
      })
    );
  } catch {
    return String(value);
  }
}

function normalizeError(error) {
  return {
    name: error.name,
    message: error.message,
    stack: error.stack
  };
}

function formatTimestamp(timestamp) {
  if (!timestamp) {
    return null;
  }

  return new Date(timestamp).toISOString();
}

async function clickElementInPage(target) {
  const selectors = [target.selector, ...(target.selectors || [])].filter(Boolean);
  const startedAt = Date.now();
  const deadline = startedAt + target.waitForSelectorMs;

  while (Date.now() <= deadline) {
    const element = findFirstElement(selectors, target.requireVisible);
    if (element) {
      clickElement(element, target);
      return {
        ok: true,
        targetId: target.id,
        selector: selectors.find((selector) => document.querySelector(selector)),
        tagName: element.tagName,
        text: (element.innerText || element.textContent || "").trim().slice(0, 80),
        href: element.href || null,
        url: location.href,
        title: document.title,
        waitedMs: Date.now() - startedAt
      };
    }

    await sleep(250);
  }

  return {
    ok: false,
    targetId: target.id,
    reason: "selector-not-found",
    selectors,
    url: location.href,
    title: document.title,
    waitedMs: Date.now() - startedAt
  };

  function findFirstElement(candidateSelectors, requireVisible) {
    for (const selector of candidateSelectors) {
      const candidate = document.querySelector(selector);
      if (candidate && (!requireVisible || isVisible(candidate))) {
        return candidate;
      }
    }

    return null;
  }

  function isVisible(element) {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      Number(style.opacity) !== 0 &&
      rect.width > 0 &&
      rect.height > 0
    );
  }

  function clickElement(element, clickTarget) {
    if (clickTarget.scrollIntoView && typeof element.scrollIntoView === "function") {
      element.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });
    }

    if (typeof element.focus === "function") {
      element.focus({ preventScroll: true });
    }

    const strategy = clickTarget.clickStrategy || "mouse-events";
    if (strategy === "native") {
      element.click();
      return;
    }

    dispatchMouseSequence(element);

    if (strategy === "both") {
      element.click();
    }
  }

  function dispatchMouseSequence(element) {
    const rect = element.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX,
      clientY,
      screenX: window.screenX + clientX,
      screenY: window.screenY + clientY,
      button: 0,
      buttons: 1
    };

    if (typeof PointerEvent === "function") {
      for (const type of ["pointerover", "pointerenter", "pointermove", "pointerdown", "pointerup"]) {
        element.dispatchEvent(
          new PointerEvent(type, {
            ...base,
            pointerId: 1,
            pointerType: "mouse",
            isPrimary: true
          })
        );
      }
    }

    for (const type of ["mouseover", "mouseenter", "mousemove", "mousedown", "mouseup", "click"]) {
      element.dispatchEvent(new MouseEvent(type, base));
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

function readWebSocketStorageInPage(config) {
  const result = {
    ok: true,
    href: location.href,
    title: document.title,
    localStorageValue: null,
    sessionStorageValue: null,
    errors: {}
  };

  try {
    result.localStorageValue = localStorage.getItem(config.localStorageKey);
  } catch (error) {
    result.errors.localStorage = {
      name: error.name,
      message: error.message
    };
  }

  try {
    result.sessionStorageValue = sessionStorage.getItem(config.sessionStorageKey);
  } catch (error) {
    result.errors.sessionStorage = {
      name: error.name,
      message: error.message
    };
  }

  if (result.errors.localStorage || result.errors.sessionStorage) {
    result.ok = false;
    result.reason = "storage-access-failed";
  }

  return result;
}

function installWebSocketStorageWatcherInPage(config) {
  const registryKey = "__pagehelper_websocket_storage_watchers__";
  const registry = window[registryKey] || {};
  window[registryKey] = registry;

  const signature = JSON.stringify({
    localStorageKey: config.localStorageKey,
    sessionStorageKey: config.sessionStorageKey,
    storageCheckIntervalMs: config.storageCheckIntervalMs
  });

  const previous = registry[config.targetId];
  if (previous?.signature === signature) {
    previous.notify("reconciled");
    return {
      ok: true,
      status: "already-installed",
      href: location.href
    };
  }

  if (previous?.stop) {
    previous.stop();
  }

  let lastSnapshotKey = "";

  function readSnapshot() {
    const snapshot = {
      href: location.href,
      localStorageValue: null,
      sessionStorageValue: null,
      errors: {}
    };

    try {
      snapshot.localStorageValue = localStorage.getItem(config.localStorageKey);
    } catch (error) {
      snapshot.errors.localStorage = {
        name: error.name,
        message: error.message
      };
    }

    try {
      snapshot.sessionStorageValue = sessionStorage.getItem(config.sessionStorageKey);
    } catch (error) {
      snapshot.errors.sessionStorage = {
        name: error.name,
        message: error.message
      };
    }

    return snapshot;
  }

  function notify(reason) {
    const snapshot = readSnapshot();
    const snapshotKey = JSON.stringify(snapshot);
    if (reason !== "installed" && snapshotKey === lastSnapshotKey) {
      return;
    }

    lastSnapshotKey = snapshotKey;

    try {
      const result = chrome.runtime.sendMessage({
        type: "pagehelper.websocket.storage-changed",
        targetId: config.targetId,
        reason,
        href: snapshot.href,
        localStorageValue: snapshot.localStorageValue,
        sessionStorageValue: snapshot.sessionStorageValue
      });

      if (result?.catch) {
        result.catch(() => {});
      }
    } catch {
      // The service worker may be restarting; the next poll will try again.
    }
  }

  function onStorageEvent() {
    notify("storage-event");
  }

  const intervalId = window.setInterval(() => {
    notify("poll");
  }, config.storageCheckIntervalMs);

  window.addEventListener("storage", onStorageEvent);
  registry[config.targetId] = {
    signature,
    notify,
    stop() {
      window.clearInterval(intervalId);
      window.removeEventListener("storage", onStorageEvent);
    }
  };

  notify("installed");

  return {
    ok: true,
    status: "installed",
    href: location.href
  };
}

function showLoginPromptInPage(prompt) {
  const existing = document.getElementById("__pagehelper_login_prompt__");
  if (existing) {
    existing.remove();
  }

  const host = document.createElement("div");
  host.id = "__pagehelper_login_prompt__";
  Object.assign(host.style, {
    position: "fixed",
    right: "16px",
    bottom: "16px",
    zIndex: "2147483647",
    maxWidth: "360px",
    padding: "14px 16px",
    borderRadius: "8px",
    background: "#111827",
    color: "#ffffff",
    boxShadow: "0 12px 32px rgba(0, 0, 0, 0.28)",
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    fontSize: "14px",
    lineHeight: "1.45"
  });

  const title = document.createElement("div");
  title.textContent = prompt.title;
  Object.assign(title.style, {
    marginBottom: "6px",
    fontWeight: "700"
  });

  const message = document.createElement("div");
  message.textContent = prompt.message;
  Object.assign(message.style, {
    paddingRight: "28px"
  });

  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "x";
  close.setAttribute("aria-label", "Close Page Helper prompt");
  Object.assign(close.style, {
    position: "absolute",
    top: "8px",
    right: "10px",
    width: "24px",
    height: "24px",
    border: "0",
    borderRadius: "999px",
    background: "rgba(255, 255, 255, 0.12)",
    color: "#ffffff",
    cursor: "pointer",
    fontSize: "16px",
    lineHeight: "22px"
  });
  close.addEventListener("click", () => host.remove());

  host.append(title, message, close);
  document.documentElement.appendChild(host);

  window.setTimeout(() => {
    host.remove();
  }, prompt.durationMs);
}
