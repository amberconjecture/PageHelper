const DEFAULT_RETENTION_MS = 30000;
const DEFAULT_MAX_ENTRIES = 50;

// 同一 command 可能被共用 WebSocket 服务广播到多条本地连接。
// 这里复用同一次执行结果，保证非幂等请求不会因为广播而重复执行。
export function createCommandExecutionDeduplicator(options = {}) {
  const retentionMs = normalizePositiveNumber(options.retentionMs, DEFAULT_RETENTION_MS);
  const maxEntries = normalizePositiveNumber(options.maxEntries, DEFAULT_MAX_ENTRIES);
  const now = typeof options.now === "function" ? options.now : Date.now;
  const entries = new Map();

  return {
    async run(key, execute) {
      const normalizedKey = String(key || "");
      if (!normalizedKey) {
        return {
          reused: false,
          result: await execute()
        };
      }

      removeExpiredEntries(entries, now());
      const existing = entries.get(normalizedKey);
      if (existing) {
        return {
          reused: true,
          result: await existing.promise
        };
      }

      const entry = {
        expiresAt: Number.POSITIVE_INFINITY,
        promise: Promise.resolve().then(execute)
      };
      entries.set(normalizedKey, entry);

      try {
        const result = await entry.promise;
        entry.expiresAt = now() + retentionMs;
        trimSettledEntries(entries, maxEntries);
        return {
          reused: false,
          result
        };
      } catch (error) {
        if (entries.get(normalizedKey) === entry) {
          entries.delete(normalizedKey);
        }
        throw error;
      }
    }
  };
}

export function buildCommandExecutionKey(targetId, message) {
  const commandId = message?.id;
  if (
    !["number", "string"].includes(typeof commandId) ||
    (typeof commandId === "number" && !Number.isFinite(commandId)) ||
    (typeof commandId === "string" && !commandId.trim())
  ) {
    return "";
  }

  return JSON.stringify([String(targetId || ""), typeof commandId, String(commandId)]);
}

function removeExpiredEntries(entries, timestamp) {
  for (const [key, entry] of entries) {
    if (entry.expiresAt <= timestamp) {
      entries.delete(key);
    }
  }
}

function trimSettledEntries(entries, maxEntries) {
  if (entries.size <= maxEntries) {
    return;
  }

  for (const [key, entry] of entries) {
    if (entries.size <= maxEntries) {
      return;
    }

    if (Number.isFinite(entry.expiresAt)) {
      entries.delete(key);
    }
  }
}

function normalizePositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
