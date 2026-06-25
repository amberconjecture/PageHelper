import { logInfo, logWarn } from "./logger.js";
import { normalizeArray } from "./utils.js";

// Tab/URL 匹配工具。保活点击和 WebSocket 都复用同一套 TargetUrl 判定规则。

export async function findMatchingTabs(target, options = {}) {
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

export function selectPreferredTab(tabs) {
  return sortPreferredTabs(tabs)[0];
}

export function sortPreferredTabs(tabs) {
  return [...tabs].sort((a, b) => {
    if (a.active !== b.active) {
      return a.active ? -1 : 1;
    }

    return (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0);
  });
}

export async function waitForTabComplete(tabId, timeoutMs) {
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

export function getQueryUrlPatterns(target) {
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

export function matchesTargetUrl(url, target) {
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
