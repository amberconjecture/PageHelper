import { KEEP_ALIVE_CONFIG } from "./config.js";

const ALARM_PREFIX = "pagehelper.keepAlive.";
const DEFAULT_INTERVAL_MINUTES = 50;
const MIN_INTERVAL_MINUTES = 1;
const DEFAULT_WAIT_FOR_SELECTOR_MS = 10000;
const LOG_STORAGE_KEY = "pagehelper.logs";
const LOG_LIMIT = 300;

chrome.runtime.onInstalled.addListener((details) => {
  void setupAlarms(`runtime.onInstalled:${details.reason}`);
});

chrome.runtime.onStartup.addListener(() => {
  void setupAlarms("runtime.onStartup");
});

chrome.alarms.onAlarm.addListener((alarm) => {
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

// Reconcile alarms whenever the MV3 service worker wakes. This makes unpacked
// extension reloads and edited developer config much easier to diagnose.
void setupAlarms("service-worker-start");

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
    logWarn("No enabled targets. Set target.enabled=true in src/config.js, then reload the extension.", {
      configuredTargets: summarizeTargets(normalizeArray(KEEP_ALIVE_CONFIG.targets))
    });
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

async function findMatchingTabs(target) {
  const queryPatterns = getQueryUrlPatterns(target);
  const tabs = await chrome.tabs.query(queryPatterns.length ? { url: queryPatterns } : {});
  const matchingTabs = tabs.filter((tab) => tab.id && tab.url && matchesTargetUrl(tab.url, target));

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

  return matchingTabs;
}

function selectPreferredTab(tabs) {
  return [...tabs].sort((a, b) => {
    if (a.active !== b.active) {
      return a.active ? -1 : 1;
    }

    return (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0);
  })[0];
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
  return normalizeArray(KEEP_ALIVE_CONFIG.targets).filter((target) => {
    if (!target || target.enabled === false) {
      return false;
    }

    if (!target.id) {
      logWarn("Ignored enabled target without id.", { target });
      return false;
    }

    if (!getSelectors(target).length) {
      logWarn("Ignored enabled target without selector.", { targetId: target.id });
      return false;
    }

    return true;
  });
}

function getSelectors(target) {
  return [target.selector, ...normalizeArray(target.selectors)].filter(Boolean);
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
    selectors: target ? getSelectors(target) : []
  }));
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
