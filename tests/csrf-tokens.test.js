import assert from "node:assert/strict";
import test from "node:test";

import {
  executeWebSocketCommandFetchInPage,
  installWebSocketStorageWatcherInPage,
  removeDisabledWebSocketStorageWatchersInPage
} from "../src/page-scripts.js";

function installPageGlobals() {
  globalThis.location = {
    href: "https://admin.example.com/home",
    protocol: "https:"
  };
  globalThis.document = {
    title: "Admin",
    cookie: ""
  };
}

test("dual-token plan fetches both tokens and applies both headers", async (context) => {
  installPageGlobals();
  const calls = [];
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/token-one")) {
      return new Response(JSON.stringify({ nonce: "first" }), {
        headers: { "content-type": "application/json" }
      });
    }
    if (url.endsWith("/token-two")) {
      return new Response(JSON.stringify({ csrfToken: "second" }), {
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ saved: true }), {
      headers: { "content-type": "application/json" }
    });
  };

  const result = await executeWebSocketCommandFetchInPage({
    action: "https://admin.example.com/api/save",
    method: "POST",
    payload: { value: 1 },
    csrfTokens: [
      {
        id: "first",
        url: "https://admin.example.com/token-one",
        headerName: "X-hw-Csrftoken",
        responseType: "json",
        valuePaths: ["$"],
        serialize: "json"
      },
      {
        id: "second",
        url: "https://admin.example.com/token-two",
        headerName: "X-Session-Csrf-Token",
        responseType: "auto",
        valuePaths: ["$.csrfToken", "$"],
        serialize: "string",
        cookieName: "gpmp-csrfToken"
      }
    ]
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].options.headers["X-hw-Csrftoken"], JSON.stringify({ nonce: "first" }));
  assert.equal(calls[2].options.headers["X-Session-Csrf-Token"], "second");
  assert.match(document.cookie, /^gpmp-csrfToken=second;/);
});

test("single-token plan calls only its configured token URL", async (context) => {
  installPageGlobals();
  const calls = [];
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/single-token")) {
      return new Response("one-token", {
        headers: { "content-type": "text/plain" }
      });
    }
    return new Response("ok");
  };

  const result = await executeWebSocketCommandFetchInPage({
    action: "https://second.example.com/api/save",
    method: "POST",
    csrfTokens: [
      {
        id: "only",
        url: "https://second.example.com/single-token",
        headerName: "X-CSRF-Token",
        responseType: "text",
        valuePaths: ["$"],
        serialize: "string"
      }
    ]
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    calls.map((call) => call.url),
    ["https://second.example.com/single-token", "https://second.example.com/api/save"]
  );
  assert.equal(calls[1].options.headers["X-CSRF-Token"], "one-token");
  assert.equal(Object.hasOwn(calls[1].options.headers, "X-Session-Csrf-Token"), false);
});

test("string token serialization rejects an object when the configured field is missing", async (context) => {
  installPageGlobals();
  const calls = [];
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url) => {
    calls.push(url);
    return new Response(JSON.stringify({ message: "not a token" }), {
      headers: { "content-type": "application/json" }
    });
  };

  const result = await executeWebSocketCommandFetchInPage({
    action: "https://admin.example.com/api/save",
    csrfTokens: [
      {
        id: "session",
        url: "https://admin.example.com/token",
        headerName: "X-Session-Csrf-Token",
        responseType: "auto",
        valuePaths: ["$.csrfToken", "$"],
        serialize: "string"
      }
    ]
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid-csrf-token-value");
  assert.deepEqual(calls, ["https://admin.example.com/token"]);
});

test("disabled site watchers clear their interval, listener, and registry entry", (context) => {
  installPageGlobals();
  const originalWindow = globalThis.window;
  const originalChrome = globalThis.chrome;
  const originalLocalStorage = globalThis.localStorage;
  const originalSessionStorage = globalThis.sessionStorage;
  const clearedIntervals = [];
  const removedListeners = [];
  let nextIntervalId = 1;

  context.after(() => {
    globalThis.window = originalWindow;
    globalThis.chrome = originalChrome;
    globalThis.localStorage = originalLocalStorage;
    globalThis.sessionStorage = originalSessionStorage;
  });

  globalThis.window = {
    setInterval() {
      return nextIntervalId++;
    },
    clearInterval(intervalId) {
      clearedIntervals.push(intervalId);
    },
    addEventListener() {},
    removeEventListener(type) {
      removedListeners.push(type);
    }
  };
  globalThis.chrome = {
    runtime: {
      sendMessage() {
        return Promise.resolve();
      }
    }
  };
  globalThis.localStorage = { getItem: () => null };
  globalThis.sessionStorage = { getItem: () => null };

  installWebSocketStorageWatcherInPage({
    targetId: "first",
    localStorageKey: "auth",
    sessionStorageKey: "session",
    storageCheckIntervalMs: 3000
  });
  installWebSocketStorageWatcherInPage({
    targetId: "second",
    localStorageKey: "auth",
    sessionStorageKey: "session",
    storageCheckIntervalMs: 3000
  });

  const result = removeDisabledWebSocketStorageWatchersInPage({
    enabledTargetIds: ["second"]
  });

  assert.deepEqual(result.removedTargetIds, ["first"]);
  assert.deepEqual(clearedIntervals, [1]);
  assert.deepEqual(removedListeners, ["storage"]);
  assert.equal(Object.hasOwn(window.__pagehelper_websocket_storage_watchers__, "first"), false);
  assert.equal(Object.hasOwn(window.__pagehelper_websocket_storage_watchers__, "second"), true);
});
