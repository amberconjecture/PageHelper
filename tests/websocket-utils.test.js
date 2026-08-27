import assert from "node:assert/strict";
import test from "node:test";

const originalWebSocket = globalThis.WebSocket;
globalThis.WebSocket = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3
};

const { isWebSocketUsable } = await import("../src/websocket-utils.js");

test.after(() => {
  globalThis.WebSocket = originalWebSocket;
});

test("an OPEN WebSocket is usable regardless of connection age", () => {
  assert.equal(
    isWebSocketUsable(
      { readyState: WebSocket.OPEN },
      { connectStartedAt: 0, connectTimeoutMs: 15000, now: 60000 }
    ),
    true
  );
});

test("a CONNECTING WebSocket becomes unusable after its handshake timeout", () => {
  const socket = { readyState: WebSocket.CONNECTING };
  assert.equal(
    isWebSocketUsable(socket, {
      connectStartedAt: 1000,
      connectTimeoutMs: 15000,
      now: 15999
    }),
    true
  );
  assert.equal(
    isWebSocketUsable(socket, {
      connectStartedAt: 1000,
      connectTimeoutMs: 15000,
      now: 16000
    }),
    false
  );
});

test("CLOSING and CLOSED WebSockets are not usable", () => {
  assert.equal(isWebSocketUsable({ readyState: WebSocket.CLOSING }), false);
  assert.equal(isWebSocketUsable({ readyState: WebSocket.CLOSED }), false);
});
