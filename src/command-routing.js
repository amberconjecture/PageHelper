import { normalizeArray } from "./utils.js";

// Command 路由与页面 Tab 匹配是两套独立规则。这里仅根据服务端下发的
// action URL 选择唯一 target，避免共用 WebSocket 时把命令交给错误站点。

export function normalizeCommandRouting(target) {
  const raw = getRawCommandRouting(target);
  const allowedOrigins = uniqueNormalizedStrings(raw.allowedOrigins, normalizeOrigin);
  const pathPrefixes = uniqueNormalizedStrings(raw.pathPrefixes, normalizePathPrefix);
  const pathSegments = uniqueNormalizedStrings(raw.pathSegments, normalizePathSegment);
  const pathIncludes = uniqueStrings(raw.pathIncludes);
  const hasPathRules =
    pathPrefixes.length > 0 || pathSegments.length > 0 || pathIncludes.length > 0;
  const configured = hasDeclaredCommandRouting(raw);

  return {
    configured,
    valid: !configured || (allowedOrigins.length > 0 && hasPathRules),
    allowedOrigins,
    pathPrefixes,
    pathSegments,
    pathIncludes
  };
}

export function resolveCommandTargetByAction(targets, action, fallbackTarget) {
  const candidates = normalizeArray(targets).filter(Boolean);
  const targetEntries = candidates.map((target) => ({
    target,
    routing: normalizeCommandRouting(target)
  }));
  const configuredTargets = targetEntries.filter((entry) => entry.routing.configured);

  // 没有任何站点声明 commandRouting 时完全沿用旧行为：消息属于收到它的 socket。
  if (!configuredTargets.length) {
    return fallbackTarget
      ? {
          ok: true,
          target: fallbackTarget,
          mode: "socket-bound"
        }
      : {
          ok: false,
          reason: "missing-command-routing-fallback"
        };
  }

  // 一旦启用 action 路由，所有已启用的 WebSocket target 都必须提供完整规则。
  // 不允许对未配置站点回退到 socket，否则会重新引入共享连接串站问题。
  const missingTargetIds = targetEntries
    .filter((entry) => !entry.routing.configured)
    .map((entry) => entry.target.id);
  const invalidTargetIds = configuredTargets
    .filter((entry) => !entry.routing.valid)
    .map((entry) => entry.target.id);
  if (missingTargetIds.length || invalidTargetIds.length) {
    return {
      ok: false,
      reason: "invalid-command-routing-config",
      missingTargetIds,
      invalidTargetIds,
      configuredTargetIds: configuredTargets.map((entry) => entry.target.id)
    };
  }

  const actionUrl = parseAbsoluteHttpUrl(action);
  if (!actionUrl) {
    return {
      ok: false,
      reason: "invalid-command-action-url",
      configuredTargetIds: configuredTargets.map((entry) => entry.target.id)
    };
  }

  const matches = configuredTargets.filter((entry) =>
    matchesCommandRouting(actionUrl, entry.routing)
  );
  if (matches.length === 1) {
    return {
      ok: true,
      target: matches[0].target,
      mode: "action-path",
      actionOrigin: actionUrl.origin,
      actionPathname: actionUrl.pathname
    };
  }

  return {
    ok: false,
    reason: matches.length ? "ambiguous-command-target" : "command-target-not-found",
    actionOrigin: actionUrl.origin,
    actionPathname: actionUrl.pathname,
    matchedTargetIds: matches.map((entry) => entry.target.id),
    configuredTargetIds: configuredTargets.map((entry) => entry.target.id)
  };
}

function getRawCommandRouting(target) {
  const value = target?.commandRouting ?? target?.webSocket?.commandRouting;
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function hasDeclaredCommandRouting(raw) {
  return Object.values(raw).some((value) =>
    normalizeArray(value).some(
      (item) => item != null && String(item).trim().length > 0
    )
  );
}

function matchesCommandRouting(actionUrl, routing) {
  if (!routing.allowedOrigins.includes(actionUrl.origin)) {
    return false;
  }

  const segments = actionUrl.pathname
    .split("/")
    .filter(Boolean)
    .map(safeDecodeURIComponent);

  return (
    routing.pathPrefixes.some((prefix) => matchesPathPrefix(actionUrl.pathname, prefix)) ||
    routing.pathSegments.some((segment) => segments.includes(segment)) ||
    routing.pathIncludes.some((value) => actionUrl.pathname.includes(value))
  );
}

function matchesPathPrefix(pathname, prefix) {
  if (prefix === "/") {
    return true;
  }

  if (prefix.endsWith("/")) {
    return pathname.startsWith(prefix);
  }

  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function parseAbsoluteHttpUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return ["http:", "https:"].includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

function normalizeOrigin(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.origin : "";
  } catch {
    return "";
  }
}

function normalizePathPrefix(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return "";
  }

  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function normalizePathSegment(value) {
  const normalized = safeDecodeURIComponent(String(value || "").trim()).replace(/^\/+|\/+$/g, "");
  return normalized && !normalized.includes("/") ? normalized : "";
}

function uniqueStrings(value) {
  return [...new Set(normalizeArray(value).map((item) => String(item || "").trim()).filter(Boolean))];
}

function uniqueNormalizedStrings(value, normalize) {
  return [...new Set(uniqueStrings(value).map(normalize).filter(Boolean))];
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
