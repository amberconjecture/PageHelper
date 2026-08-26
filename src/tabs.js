import { logInfo, logWarn } from "./logger.js";
import { normalizeArray } from "./utils.js";

// Tab/URL 匹配工具。保活点击和 WebSocket 都复用同一套 TargetUrl 判定规则。

// 保活和 WebSocket 可能在同一时刻发现页面“缺失”。把创建动作合并成 single-flight，
// 确保同一 target/pageUrl 在一次并发窗口内只会创建一个 Tab。
const tabOpenPromises = new Map();

export async function findMatchingTabs(target, options = {}) {
  const queryPatterns = getQueryUrlPatterns(target);
  let tabs = await chrome.tabs.query(queryPatterns.length ? { url: queryPatterns } : {});
  let matchingTabs = tabs.filter((tab) => tabMatchesTarget(tab, target));

  // chrome.tabs.query({ url }) 只保证按当前 URL 查询。导航中的 Tab 可能已经把
  // pageUrl 放进 pendingUrl，但仍以旧 URL 参与 query；此时补查全部 Tab，避免误开新页。
  if (queryPatterns.length && !matchingTabs.length) {
    tabs = await chrome.tabs.query({});
    matchingTabs = tabs.filter((tab) => tabMatchesTarget(tab, target));
  }

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
        url: tab.url,
        pendingUrl: tab.pendingUrl
      }))
    });
  }

  return matchingTabs;
}

export async function findOrCreateMatchingTab(target, createProperties = {}) {
  const key = `${target.id || ""}\n${target.pageUrl || ""}`;
  const existingPromise = tabOpenPromises.get(key);
  if (existingPromise) {
    return {
      ...(await existingPromise),
      joined: true
    };
  }

  const openPromise = (async () => {
    // 调用方通常已经查过一次；在共享锁内必须再查一次，封住“查询后、创建前”的竞态窗口。
    // 两个调用方的业务匹配规则可能不同，因此锁内统一按真正要打开的 pageUrl 复查。
    const pageTarget = {
      id: target.id,
      pageUrl: target.pageUrl,
      urlPatterns: [],
      urlIncludes: [],
      urlRegexes: []
    };
    const matchingTabs = await findMatchingTabs(pageTarget, { log: false });
    if (matchingTabs.length) {
      return {
        created: false,
        tab: selectPreferredTab(matchingTabs),
        tabs: matchingTabs
      };
    }

    const tab = await chrome.tabs.create({
      ...createProperties,
      url: target.pageUrl
    });
    return {
      created: true,
      tab,
      tabs: [tab]
    };
  })();

  tabOpenPromises.set(key, openPromise);
  try {
    return {
      ...(await openPromise),
      joined: false
    };
  } finally {
    if (tabOpenPromises.get(key) === openPromise) {
      tabOpenPromises.delete(key);
    }
  }
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

  if (
    explicitPatterns.length &&
    !explicitPatterns.some((pattern) => matchesChromeUrlPattern(url, pattern))
  ) {
    return false;
  }

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

  if (target.pageUrl && matchesConfiguredPageUrl(url, target.pageUrl)) {
    return true;
  }

  return !target.pageUrl;
}

function tabMatchesTarget(tab, target) {
  if (!tab.id) {
    return false;
  }

  return [tab.url, tab.pendingUrl]
    .filter(Boolean)
    .some((url) => matchesTargetUrl(url, target));
}

function matchesConfiguredPageUrl(rawUrl, rawPageUrl) {
  try {
    const url = new URL(rawUrl);
    const pageUrl = new URL(rawPageUrl);
    if (
      url.origin !== pageUrl.origin ||
      normalizePathname(url.pathname) !== normalizePathname(pageUrl.pathname)
    ) {
      return false;
    }

    // pageUrl 没声明 query/hash 时允许页面追加临时状态；一旦显式声明，
    // 它们就是页面身份的一部分，不能让同域名的另一个 target 复用这个 Tab。
    if (!containsConfiguredSearchParams(url, pageUrl)) {
      return false;
    }

    return !pageUrl.hash || normalizeHash(url.hash) === normalizeHash(pageUrl.hash);
  } catch {
    return false;
  }
}

function normalizePathname(pathname) {
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}

function containsConfiguredSearchParams(url, pageUrl) {
  if (!pageUrl.search) {
    return true;
  }

  const actualCounts = countSearchParams(url.searchParams);
  const expectedCounts = countSearchParams(pageUrl.searchParams);
  return [...expectedCounts].every(
    ([entry, count]) => (actualCounts.get(entry) || 0) >= count
  );
}

function countSearchParams(searchParams) {
  const counts = new Map();
  for (const [key, value] of searchParams) {
    const entry = JSON.stringify([key, value]);
    counts.set(entry, (counts.get(entry) || 0) + 1);
  }
  return counts;
}

function normalizeHash(hash) {
  return hash.length > 1 ? hash.replace(/\/+$/, "") : hash;
}

function matchesChromeUrlPattern(rawUrl, rawPattern) {
  if (rawPattern === "<all_urls>") {
    return /^(https?|file|ftp):/i.test(rawUrl);
  }

  const match = /^(\*|http|https|file|ftp):\/\/([^/]*)(\/.*)$/.exec(rawPattern);
  if (!match) {
    return false;
  }

  try {
    const url = new URL(rawUrl);
    const [, scheme, host, path] = match;
    if (
      scheme === "*"
        ? !["http:", "https:"].includes(url.protocol)
        : url.protocol !== `${scheme}:`
    ) {
      return false;
    }

    const hostname = url.hostname.toLowerCase();
    const expectedHost = host.toLowerCase();
    if (
      expectedHost !== "*" &&
      !(expectedHost.startsWith("*.")
        ? hostname === expectedHost.slice(2) || hostname.endsWith(expectedHost.slice(1))
        : hostname === expectedHost)
    ) {
      return false;
    }

    const pathPattern = path
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");
    return new RegExp(`^${pathPattern}$`).test(`${url.pathname}${url.search}`);
  } catch {
    return false;
  }
}

function matchesRegex(value, pattern) {
  try {
    return new RegExp(pattern).test(value);
  } catch (error) {
    logWarn("Invalid urlRegex.", { pattern, error });
    return false;
  }
}
