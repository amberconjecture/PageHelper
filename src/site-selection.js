import { KEEP_ALIVE_CONFIG } from "./config.js";
import { SITE_SELECTIONS_STORAGE_KEY } from "./constants.js";
import { hasOwn, normalizeArray } from "./utils.js";

// 用户选择和开发者配置分开保存：config.js 决定有哪些站点，
// chrome.storage.local 只记录每个站点是否被用户勾选。
let cachedSelections = {};
let writeQueue = Promise.resolve();
let selectionRevision = 0;

export async function loadSiteSelections() {
  const revisionBeforeRead = selectionRevision;
  const stored = await chrome.storage.local.get(SITE_SELECTIONS_STORAGE_KEY);
  // 如果读取期间已收到更新事件，不让较旧的读取结果覆盖新状态。
  if (revisionBeforeRead === selectionRevision) {
    applySiteSelections(stored[SITE_SELECTIONS_STORAGE_KEY]);
  }
  return getSiteOptions();
}

export function applySiteSelections(value) {
  cachedSelections = normalizeSelectionMap(value);
  selectionRevision += 1;
}

export function getSiteOptions() {
  const seenIds = new Set();

  return normalizeArray(KEEP_ALIVE_CONFIG.targets)
    .filter((target) => target && target.enabled !== false && getSyncOption(target))
    .filter((target) => {
      if (typeof target.id !== "string") {
        return false;
      }

      const id = String(target.id || "").trim();
      if (!id || seenIds.has(id)) {
        return false;
      }

      seenIds.add(id);
      return true;
    })
    .map((target) => {
      const option = getSyncOption(target);
      return {
        id: String(target.id).trim(),
        label: String(option.label || target.name || target.id),
        description: String(option.description || ""),
        enabled: isTargetSelected(target)
      };
    });
}

export function isTargetSelected(target) {
  if (!target || target.enabled === false) {
    return false;
  }

  const option = getSyncOption(target);
  if (!option) {
    // 没有 syncOption 的旧配置继续沿用原来的 enabled 行为。
    return true;
  }

  const id = String(target.id || "").trim();
  if (id && hasOwn(cachedSelections, id)) {
    return cachedSelections[id] === true;
  }

  return option.defaultEnabled === true;
}

export function setSiteSelection(targetId, enabled) {
  const id = String(targetId || "").trim();
  if (!getSiteOptions().some((option) => option.id === id)) {
    return Promise.reject(new Error(`Unknown site option: ${id || "(empty)"}`));
  }

  writeQueue = writeQueue.catch(() => undefined).then(async () => {
    // 每次写入前重新读取，避免快速切换多个站点时后一次覆盖前一次。
    const stored = await chrome.storage.local.get(SITE_SELECTIONS_STORAGE_KEY);
    const selections = normalizeSelectionMap(stored[SITE_SELECTIONS_STORAGE_KEY]);
    selections[id] = enabled === true;
    await chrome.storage.local.set({
      [SITE_SELECTIONS_STORAGE_KEY]: selections
    });
    applySiteSelections(selections);
  });

  return writeQueue;
}

export async function requestSiteSelection(targetId, enabled) {
  const id = String(targetId || "").trim();
  if (!getSiteOptions().some((option) => option.id === id)) {
    throw new Error(`Unknown site option: ${id || "(empty)"}`);
  }

  const response = await chrome.runtime.sendMessage({
    type: "pagehelper.site-selection.set",
    targetId: id,
    enabled: enabled === true
  });
  if (!response?.ok) {
    throw new Error(response?.error || "Background did not save the site selection.");
  }

  applySiteSelections({
    ...cachedSelections,
    [id]: enabled === true
  });
}

function getSyncOption(target) {
  if (target?.syncOption === true) {
    return {};
  }

  if (target?.syncOption && typeof target.syncOption === "object" && !Array.isArray(target.syncOption)) {
    return target.syncOption;
  }

  return null;
}

function normalizeSelectionMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .map(([key, enabled]) => [String(key || "").trim(), enabled === true])
      .filter(([key]) => key)
  );
}
