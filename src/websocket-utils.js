import { normalizeError } from "./logger.js";

// WebSocket 辅助函数保持纯函数风格，便于后续单独测试 query 拼接和 JSON path 提取。

export function buildWebSocketUrl(config, candidate) {
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

export function extractJsonPathValue(rawValue, jsonPath) {
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

export function isNonEmptyValue(value) {
  return value !== undefined && value !== null && String(value).length > 0;
}

export function stringifyQueryValue(value) {
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

export function isWebSocketUsable(socket) {
  return socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN;
}

export function getWebSocketReadyStateName(readyState) {
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

export function getWebSocketMessageLength(data) {
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

export function serializeWebSocketEvent(event) {
  return {
    type: event.type,
    message: event.message
  };
}

export function safeCloseReason(reason) {
  return String(reason || "closed").slice(0, 120);
}

export function redactWebSocketUrl(rawUrl) {
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
