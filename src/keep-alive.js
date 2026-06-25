import { KEEP_ALIVE_CONFIG } from "./config.js";
import { ALARM_PREFIX } from "./constants.js";
import { logError, logInfo, logWarn, formatTimestamp } from "./logger.js";
import { clickElementInPage, showLoginPromptInPage } from "./page-scripts.js";
import {
  getEnabledTargets,
  getSelectors,
  getWebSocketTargets,
  normalizeInjectionTarget,
  normalizeIntervalMinutes,
  normalizeLoginPrompt,
  normalizeStartDelaySeconds,
  shouldOpenIfMissing,
  summarizeTargets
} from "./target-config.js";
import {
  findMatchingTabs,
  getQueryUrlPatterns,
  selectPreferredTab,
  waitForTabComplete
} from "./tabs.js";
import { normalizeArray } from "./utils.js";

// 定时点击能力：负责创建/维护 alarms，并在匹配页面内执行配置好的点击动作。
// 这里只处理页面保活，不直接持有 WebSocket 状态。

export function isKeepAliveAlarm(alarm) {
  return alarm.name.startsWith(ALARM_PREFIX);
}

export async function handleKeepAliveAlarm(alarm, options = {}) {
  logInfo("Alarm fired.", {
    alarmName: alarm.name,
    scheduledTime: formatTimestamp(alarm.scheduledTime),
    periodInMinutes: alarm.periodInMinutes
  });

  const targetId = alarm.name.slice(ALARM_PREFIX.length);
  const target = getEnabledTargets().find((item) => item.id === targetId);
  if (!target) {
    logWarn("Alarm target is no longer enabled; clearing stale alarm.", {
      alarmName: alarm.name,
      targetId
    });
    void chrome.alarms.clear(alarm.name);
    return;
  }

  await runTarget(target, "alarm", options);
}

export async function setupAlarms(reason) {
  const targets = getEnabledTargets();
  const expectedNames = new Set(targets.map((target) => alarmNameFor(target)));
  const existingAlarms = await chrome.alarms.getAll();
  const existingPageHelperAlarms = existingAlarms.filter((alarm) => alarm.name.startsWith(ALARM_PREFIX));

  logInfo("Setting up alarms.", {
    reason,
    configuredTargetCount: normalizeArray(KEEP_ALIVE_CONFIG.targets).length,
    enabledTargetIds: targets.map((target) => target.id),
    existingAlarmNames: existingPageHelperAlarms.map((alarm) => alarm.name)
  });

  if (!targets.length) {
    const webSocketTargets = getWebSocketTargets();
    const details = {
      configuredTargets: summarizeTargets(normalizeArray(KEEP_ALIVE_CONFIG.targets)),
      enabledWebSocketTargetIds: webSocketTargets.map((target) => target.id)
    };

    if (webSocketTargets.length) {
      logInfo("No enabled keep-alive targets; WebSocket-only configuration is active.", details);
    } else {
      logWarn("No enabled keep-alive targets. Configure a selector to enable timed clicks, or enable webSocket for a target.", details);
    }
  }

  await Promise.all(
    existingPageHelperAlarms
      .filter((alarm) => !expectedNames.has(alarm.name))
      .map(async (alarm) => {
        await chrome.alarms.clear(alarm.name);
        logInfo("Cleared stale alarm.", { alarmName: alarm.name });
      })
  );

  await Promise.all(
    targets.map((target) =>
      createOrUpdateAlarm(
        target,
        existingPageHelperAlarms.find((alarm) => alarm.name === alarmNameFor(target))
      )
    )
  );
  logInfo("Alarm setup complete.", { enabledTargetIds: targets.map((target) => target.id) });
}

async function createOrUpdateAlarm(target, existingAlarm) {
  const intervalMinutes = normalizeIntervalMinutes(target.intervalMinutes);
  const startDelaySeconds = normalizeStartDelaySeconds(target.startDelaySeconds);
  const alarmName = alarmNameFor(target);

  if (existingAlarm?.periodInMinutes === intervalMinutes) {
    logInfo("Keeping existing alarm.", {
      targetId: target.id,
      alarmName,
      nextRunAt: formatTimestamp(existingAlarm.scheduledTime),
      intervalMinutes
    });
    return;
  }

  const firstRunAt = Date.now() + startDelaySeconds * 1000;
  await chrome.alarms.create(alarmName, {
    when: firstRunAt,
    periodInMinutes: intervalMinutes
  });

  logInfo("Created alarm.", {
    targetId: target.id,
    alarmName,
    firstRunAt: formatTimestamp(firstRunAt),
    intervalMinutes,
    startDelaySeconds,
    pageUrl: target.pageUrl,
    openIfMissing: target.openIfMissing !== false,
    urlPatterns: getQueryUrlPatterns(target),
    urlIncludes: normalizeArray(target.urlIncludes),
    urlRegexes: normalizeArray(target.urlRegexes),
    selectors: getSelectors(target)
  });
}

async function runTarget(target, trigger, options = {}) {
  logInfo("Running target.", {
    trigger,
    targetId: target.id,
    pageUrl: target.pageUrl,
    queryUrlPatterns: getQueryUrlPatterns(target),
    openIfMissing: shouldOpenIfMissing(target),
    intervalMinutes: normalizeIntervalMinutes(target.intervalMinutes),
    selectors: getSelectors(target)
  });

  const tabs = await findMatchingTabs(target);
  let tabsToClick = tabs;

  if (!tabsToClick.length && shouldOpenIfMissing(target)) {
    logInfo("No matching tab found; opening configured page.", {
      targetId: target.id,
      pageUrl: target.pageUrl,
      activeWhenOpened: target.activeWhenOpened !== false
    });

    const createdTab = await chrome.tabs.create({
      url: target.pageUrl,
      active: target.activeWhenOpened !== false
    });

    await waitForTabComplete(createdTab.id, target.pageLoadTimeoutMs ?? 30000);
    await showLoginPrompt(createdTab, target);
    logInfo("Opened page and prompted the user to sign in.", {
      targetId: target.id,
      tabId: createdTab.id,
      url: createdTab.url
    });

    // 新打开页面后立即让 WebSocket 模块重新扫描，避免等到下一次周期校验。
    if (options.onPageOpened) {
      void options.onPageOpened(`runTarget-opened-page:${target.id}`);
    }
    return;
  }

  if (!tabsToClick.length) {
    logWarn("No matching tab and openIfMissing is disabled or pageUrl is missing.", {
      targetId: target.id,
      openIfMissing: target.openIfMissing,
      pageUrl: target.pageUrl
    });
    return;
  }

  if (!target.clickAllMatchingTabs) {
    tabsToClick = [selectPreferredTab(tabsToClick)];
  }

  logInfo("Clicking matching tabs.", {
    targetId: target.id,
    tabIds: tabsToClick.map((tab) => tab.id),
    clickAllMatchingTabs: Boolean(target.clickAllMatchingTabs)
  });

  await Promise.all(tabsToClick.map((tab) => clickTabTarget(tab, target)));
}

async function clickTabTarget(tab, target) {
  try {
    const results = await chrome.scripting.executeScript({
      target: {
        tabId: tab.id,
        allFrames: target.allFrames !== false
      },
      world: "MAIN",
      func: clickElementInPage,
      args: [normalizeInjectionTarget(target)]
    });

    const success = results.find((item) => item.result?.ok);
    if (success) {
      logInfo("Clicked target element.", {
        targetId: target.id,
        tabId: tab.id,
        result: success.result
      });
      return;
    }

    logWarn("Could not click target element.", {
      targetId: target.id,
      tabId: tab.id,
      results
    });
  } catch (error) {
    logError("Failed to click target element.", {
      targetId: target.id,
      tabId: tab.id,
      error
    });
  }
}

async function showLoginPrompt(tab, target) {
  if (!tab.id || target.promptLoginWhenOpened === false) {
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: {
        tabId: tab.id,
        allFrames: false
      },
      func: showLoginPromptInPage,
      args: [normalizeLoginPrompt(target)]
    });

    logInfo("Displayed login prompt in page.", {
      targetId: target.id,
      tabId: tab.id
    });
  } catch (error) {
    logWarn("Could not show login prompt in page.", {
      targetId: target.id,
      tabId: tab.id,
      error
    });
  }
}

function alarmNameFor(target) {
  return `${ALARM_PREFIX}${target.id}`;
}
