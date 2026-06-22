import { KEEP_ALIVE_CONFIG } from "./config.js";

const ALARM_PREFIX = "pagehelper.keepAlive.";
const DEFAULT_INTERVAL_MINUTES = 50;
const MIN_INTERVAL_MINUTES = 1;
const DEFAULT_WAIT_FOR_SELECTOR_MS = 10000;

chrome.runtime.onInstalled.addListener(() => {
  void setupAlarms();
});

chrome.runtime.onStartup.addListener(() => {
  void setupAlarms();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith(ALARM_PREFIX)) {
    return;
  }

  const targetId = alarm.name.slice(ALARM_PREFIX.length);
  const target = getEnabledTargets().find((item) => item.id === targetId);
  if (!target) {
    void chrome.alarms.clear(alarm.name);
    return;
  }

  void runTarget(target);
});

async function setupAlarms() {
  const targets = getEnabledTargets();
  const expectedNames = new Set(targets.map((target) => alarmNameFor(target)));
  const existingAlarms = await chrome.alarms.getAll();

  await Promise.all(
    existingAlarms
      .filter((alarm) => alarm.name.startsWith(ALARM_PREFIX) && !expectedNames.has(alarm.name))
      .map((alarm) => chrome.alarms.clear(alarm.name))
  );

  await Promise.all(targets.map((target) => createOrUpdateAlarm(target)));
  console.info("[PageHelper] Alarms ready:", targets.map((target) => target.id));
}

async function createOrUpdateAlarm(target) {
  const intervalMinutes = normalizeIntervalMinutes(target.intervalMinutes);
  const startDelaySeconds = normalizeStartDelaySeconds(target.startDelaySeconds);

  await chrome.alarms.create(alarmNameFor(target), {
    when: Date.now() + startDelaySeconds * 1000,
    periodInMinutes: intervalMinutes
  });
}

async function runTarget(target) {
  const tabs = await findMatchingTabs(target);
  let tabsToClick = tabs;

  if (!tabsToClick.length && shouldOpenIfMissing(target)) {
    const createdTab = await chrome.tabs.create({
      url: target.pageUrl,
      active: target.activeWhenOpened !== false
    });

    await waitForTabComplete(createdTab.id, target.pageLoadTimeoutMs ?? 30000);
    await showLoginPrompt(createdTab, target);
    console.info(`[PageHelper] Opened "${target.id}" and prompted the user to sign in.`);
    return;
  }

  if (!tabsToClick.length) {
    console.warn(`[PageHelper] No matching tab for target "${target.id}".`);
    return;
  }

  if (!target.clickAllMatchingTabs) {
    tabsToClick = [selectPreferredTab(tabsToClick)];
  }

  await Promise.all(tabsToClick.map((tab) => clickTabTarget(tab, target)));
}

async function findMatchingTabs(target) {
  const queryPatterns = getQueryUrlPatterns(target);
  const tabs = await chrome.tabs.query(queryPatterns.length ? { url: queryPatterns } : {});
  return tabs.filter((tab) => tab.id && tab.url && matchesTargetUrl(tab.url, target));
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
      console.info(`[PageHelper] Clicked "${target.id}" in tab ${tab.id}:`, success.result);
      return;
    }

    console.warn(`[PageHelper] Could not click "${target.id}" in tab ${tab.id}:`, results);
  } catch (error) {
    console.error(`[PageHelper] Failed to click "${target.id}" in tab ${tab.id}:`, error);
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
  } catch (error) {
    console.warn(`[PageHelper] Could not show login prompt for "${target.id}" in tab ${tab.id}:`, error);
  }
}

function normalizeLoginPrompt(target) {
  return {
    title: target.loginPromptTitle || "Page Helper opened this page",
    message:
      target.loginPromptMessage ||
      "Please finish signing in. After login, Page Helper will keep this session alive on schedule.",
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
      console.warn("[PageHelper] Ignored target without id:", target);
      return false;
    }

    if (!getSelectors(target).length) {
      console.warn(`[PageHelper] Ignored target "${target.id}" without selector.`);
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
    console.warn(`[PageHelper] Invalid urlRegex "${pattern}":`, error);
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
