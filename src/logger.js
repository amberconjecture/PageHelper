import { LOG_LIMIT, LOG_STORAGE_KEY } from "./constants.js";

// 统一日志入口：既打印到 Service Worker 控制台，也保留最近若干条到 chrome.storage.local。

export function logInfo(message, details) {
  void writeLog("info", message, details);
}

export function logWarn(message, details) {
  void writeLog("warn", message, details);
}

export function logError(message, details) {
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

export function normalizeError(error) {
  return {
    name: error.name,
    message: error.message,
    stack: error.stack
  };
}

export function formatTimestamp(timestamp) {
  if (!timestamp) {
    return null;
  }

  return new Date(timestamp).toISOString();
}
