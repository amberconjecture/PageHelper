import { KEEP_ALIVE_CONFIG } from "./config.js";
import {
  DEFAULT_INTERVAL_MINUTES,
  DEFAULT_WAIT_FOR_SELECTOR_MS,
  DEFAULT_WEBSOCKET_RECONNECT_DELAY_MS,
  DEFAULT_WEBSOCKET_RECONCILE_INTERVAL_MINUTES,
  DEFAULT_WEBSOCKET_STORAGE_CHECK_INTERVAL_MS,
  MIN_INTERVAL_MINUTES
} from "./constants.js";
import { logWarn } from "./logger.js";
import { hasOwn, normalizeArray } from "./utils.js";
import { redactWebSocketUrl } from "./websocket-utils.js";

// 配置归一化层：把 src/config.js 中偏开发者友好的写法，
// 转换成业务模块可以直接使用的结构，并集中处理默认值。

export function getEnabledTargets() {
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

export function getConfiguredTargets() {
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

export function getWebSocketTargets() {
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

    if (!target.pageUrl) {
      logWarn("Ignored WebSocket target without pageUrl for sessionStorage lookup.", { targetId: target.id });
      return false;
    }

    return true;
  });
}

export function isWebSocketEnabled(target) {
  return normalizeWebSocketConfig(target).enabled;
}

export function getSelectors(target) {
  return [target.selector, ...normalizeArray(target.selectors)].filter(Boolean);
}

export function normalizeLoginPrompt(target) {
  return {
    title: target.loginPromptTitle || "Page Helper opened this page",
    message:
      target.loginPromptMessage ||
      "Please finish signing in. After login, Page Helper will run the configured page action on schedule.",
    durationMs: Math.max(5000, Number(target.loginPromptDurationMs ?? 30000) || 30000)
  };
}

export function normalizeInjectionTarget(target) {
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

export function normalizeWebSocketConfig(target) {
  const rawConfig = target.webSocket || {};
  const localStorageKey = rawConfig.localStorageKey ?? target.webSocketLocalStorageKey ?? "auth-token";

  return {
    targetId: target.id,
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
    csrfTokenUrl: rawConfig.csrfTokenUrl ?? target.webSocketCsrfTokenUrl ?? "",
    commandHeaders: normalizeHeaderMap(rawConfig.commandHeaders ?? target.webSocketCommandHeaders),
    storageCheckIntervalMs: normalizeWebSocketStorageCheckIntervalMs(rawConfig.storageCheckIntervalMs),
    reconnectDelayMs: normalizeWebSocketReconnectDelayMs(rawConfig.reconnectDelayMs),
    logMessages: rawConfig.logMessages === true
  };
}

export function getWebSocketPageTarget(target, config = normalizeWebSocketConfig(target)) {
  return {
    ...target,
    pageUrl: config.targetUrl || target.pageUrl,
    urlPatterns: config.targetUrlPatterns ?? target.urlPatterns,
    urlIncludes: config.targetUrlIncludes ?? target.urlIncludes,
    urlRegexes: config.targetUrlRegexes ?? target.urlRegexes
  };
}

export function getWebSocketSessionPageTarget(target) {
  if (!target.pageUrl) {
    return null;
  }

  return {
    id: target.id,
    pageUrl: target.pageUrl,
    urlPatterns: [],
    urlIncludes: [],
    urlRegexes: []
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

function normalizeHeaderMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .map(([key, headerValue]) => [String(key || "").trim(), headerValue])
      .filter(([key, headerValue]) => key && headerValue !== undefined && headerValue !== null)
      .map(([key, headerValue]) => [key, String(headerValue)])
  );
}

export function shouldOpenIfMissing(target) {
  return Boolean(target.pageUrl) && target.openIfMissing !== false;
}

export function normalizeIntervalMinutes(value) {
  const interval = Number(value ?? KEEP_ALIVE_CONFIG.defaultIntervalMinutes ?? DEFAULT_INTERVAL_MINUTES);
  if (!Number.isFinite(interval)) {
    return DEFAULT_INTERVAL_MINUTES;
  }

  return Math.max(MIN_INTERVAL_MINUTES, interval);
}

export function normalizeStartDelaySeconds(value) {
  const delay = Number(value ?? KEEP_ALIVE_CONFIG.defaultStartDelaySeconds ?? 10);
  if (!Number.isFinite(delay)) {
    return 10;
  }

  return Math.max(1, delay);
}

export function normalizeWaitForSelectorMs(value) {
  const wait = Number(value ?? KEEP_ALIVE_CONFIG.defaultWaitForSelectorMs ?? DEFAULT_WAIT_FOR_SELECTOR_MS);
  if (!Number.isFinite(wait)) {
    return DEFAULT_WAIT_FOR_SELECTOR_MS;
  }

  return Math.max(0, wait);
}

export function normalizeWebSocketStorageCheckIntervalMs(value) {
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

export function normalizeWebSocketReconnectDelayMs(value) {
  const delay = Number(value ?? KEEP_ALIVE_CONFIG.defaultWebSocketReconnectDelayMs ?? DEFAULT_WEBSOCKET_RECONNECT_DELAY_MS);
  if (!Number.isFinite(delay)) {
    return DEFAULT_WEBSOCKET_RECONNECT_DELAY_MS;
  }

  return Math.max(1000, delay);
}

export function normalizeWebSocketReconcileIntervalMinutes(value) {
  const interval = Number(value ?? DEFAULT_WEBSOCKET_RECONCILE_INTERVAL_MINUTES);
  if (!Number.isFinite(interval)) {
    return DEFAULT_WEBSOCKET_RECONCILE_INTERVAL_MINUTES;
  }

  return Math.max(MIN_INTERVAL_MINUTES, interval);
}

export function normalizeWebSocketWatcherConfig(targetOrConfig, maybeConfig) {
  const config = maybeConfig ?? targetOrConfig;
  return {
    targetId: config.targetId,
    localStorageKey: config.localStorageKey,
    sessionStorageKey: config.sessionStorageKey,
    storageCheckIntervalMs: config.storageCheckIntervalMs
  };
}

export function summarizeTargets(targets) {
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
    csrfTokenUrl: config.csrfTokenUrl,
    commandHeaders: config.commandHeaders,
    storageCheckIntervalMs: config.storageCheckIntervalMs,
    reconnectDelayMs: config.reconnectDelayMs,
    logMessages: config.logMessages
  };
}
