// 这些函数会被 chrome.scripting.executeScript 序列化到目标页面执行。
// 因此函数内部不要依赖模块级变量或 import，只使用参数和浏览器页面环境。

export async function clickElementInPage(target) {
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

export function readWebSocketStorageInPage(config) {
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

export async function executeWebSocketCommandFetchInPage(command) {
  const action = typeof command.action === "string" ? command.action.trim() : "";
  if (!action) {
    return {
      ok: false,
      reason: "missing-command-action",
      href: location.href,
      title: document.title
    };
  }

  const method = String(command.method || "POST").trim().toUpperCase();
  if (!method) {
    return {
      ok: false,
      reason: "missing-command-method",
      href: location.href,
      title: document.title
    };
  }

  const csrfResult = await readCsrfToken();
  if (!csrfResult.ok) {
    return {
      ok: false,
      reason: csrfResult.reason,
      href: location.href,
      title: document.title,
      status: csrfResult.status,
      statusText: csrfResult.statusText,
      error: csrfResult.error
    };
  }

  const gpmpCsrfResult = await readGpmpCsrfToken();
  if (!gpmpCsrfResult.ok) {
    return {
      ok: false,
      reason: gpmpCsrfResult.reason,
      href: location.href,
      title: document.title,
      status: gpmpCsrfResult.status,
      statusText: gpmpCsrfResult.statusText,
      error: gpmpCsrfResult.error
    };
  }

  const headers = normalizeHeaders(command.headers);
  const supportsBody = method !== "GET" && method !== "HEAD";
  let body;

  if (supportsBody) {
    const payload = command.payload;
    if (typeof payload === "string") {
      body = payload;
    } else if (payload !== undefined) {
      body = JSON.stringify(payload);
      if (!hasHeader(headers, "content-type")) {
        headers["Content-Type"] = "application/json";
      }
    }
  }

  setHeader(headers, "X-hw-Csrftoken", String(csrfResult.csrfToken));
  setHeader(headers, "X-Session-Csrf-Token", String(gpmpCsrfResult.csrfToken));

  try {
    const fetchOptions = {
      method,
      headers,
      credentials: "include"
    };
    if (body !== undefined) {
      fetchOptions.body = body;
    }

    const response = await fetch(action, fetchOptions);
    const text = await response.text();

    return {
      ok: true,
      href: location.href,
      title: document.title,
      status: response.status,
      statusText: response.statusText,
      responseOk: response.ok,
      payload: parseResponseBody(text, response.headers.get("content-type"))
    };
  } catch (error) {
    return {
      ok: false,
      reason: "fetch-failed",
      href: location.href,
      title: document.title,
      error: normalizeError(error)
    };
  }

  async function readCsrfToken() {
    const csrfTokenUrl = getConfiguredString(command.csrfTokenUrl);
    if (!csrfTokenUrl) {
      return {
        ok: false,
        reason: "missing-csrf-token-url"
      };
    }

    try {
      const response = await fetch(csrfTokenUrl, {
        method: "GET",
        credentials: "include"
      });
      const text = await response.text();
      let payload;

      try {
        payload = JSON.parse(text);
      } catch (error) {
        return {
          ok: false,
          reason: "invalid-csrf-token-response-json",
          status: response.status,
          statusText: response.statusText,
          error: normalizeError(error)
        };
      }

      if (!response.ok) {
        return {
          ok: false,
          reason: "csrf-token-request-failed",
          status: response.status,
          statusText: response.statusText,
          payload
        };
      }

      return {
        ok: true,
        csrfToken: JSON.stringify(payload)
      };
    } catch (error) {
      return {
        ok: false,
        reason: "csrf-token-request-error",
        error: normalizeError(error)
      };
    }
  }

  async function readGpmpCsrfToken() {
    const gpmpCsrfTokenUrl = getConfiguredString(command.gpmpCsrfTokenUrl);
    if (!gpmpCsrfTokenUrl) {
      return {
        ok: false,
        reason: "missing-gpmp-csrf-token-url"
      };
    }

    try {
      const response = await fetch(gpmpCsrfTokenUrl, {
        method: "GET",
        credentials: "include"
      });
      const text = await response.text();
      const payload = parseResponseBody(text, response.headers.get("content-type"));

      if (!response.ok) {
        return {
          ok: false,
          reason: "gpmp-csrf-token-request-failed",
          status: response.status,
          statusText: response.statusText,
          payload
        };
      }

      const csrfToken = extractGpmpCsrfToken(payload);
      if (!csrfToken) {
        return {
          ok: false,
          reason: "missing-gpmp-csrf-token-response",
          status: response.status,
          statusText: response.statusText,
          payload
        };
      }

      writeCookieValue("gpmp-csrfToken", csrfToken);

      return {
        ok: true,
        csrfToken
      };
    } catch (error) {
      return {
        ok: false,
        reason: "gpmp-csrf-token-request-error",
        error: normalizeError(error)
      };
    }
  }

  function getConfiguredString(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function extractGpmpCsrfToken(payload) {
    if (typeof payload === "string") {
      return payload.trim();
    }

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return "";
    }

    return getConfiguredString(payload.csrfToken);
  }

  function writeCookieValue(cookieName, value) {
    const secureAttribute = location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${cookieName}=${encodeURIComponent(value)}; Path=/; SameSite=Lax${secureAttribute}`;
  }

  function normalizeHeaders(value) {
    const normalized = {};
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return normalized;
    }

    for (const [key, headerValue] of Object.entries(value)) {
      const headerName = String(key || "").trim();
      if (!headerName || headerValue === undefined || headerValue === null) {
        continue;
      }

      normalized[headerName] = String(headerValue);
    }

    return normalized;
  }

  function hasHeader(headers, headerName) {
    const expected = headerName.toLowerCase();
    return Object.keys(headers).some((key) => key.toLowerCase() === expected);
  }

  function setHeader(headers, headerName, headerValue) {
    const expected = headerName.toLowerCase();
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === expected && key !== headerName) {
        delete headers[key];
      }
    }

    headers[headerName] = headerValue;
  }

  function parseResponseBody(text, contentType) {
    if (!text) {
      return null;
    }

    const normalizedContentType = String(contentType || "").toLowerCase();
    if (!normalizedContentType.includes("application/json") && !normalizedContentType.includes("+json")) {
      return text;
    }

    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  function normalizeError(error) {
    return {
      name: error?.name,
      message: error?.message,
      stack: error?.stack
    };
  }
}

export function installWebSocketStorageWatcherInPage(config) {
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
      // Service Worker 可能正好在重启；下一次轮询会再次上报。
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

export function showLoginPromptInPage(prompt) {
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
