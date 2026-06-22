export const KEEP_ALIVE_CONFIG = {
  // 页面 1 小时无点击会过期时，建议设置为 45-55 分钟。
  defaultIntervalMinutes: 50,
  defaultWaitForSelectorMs: 10000,
  defaultStartDelaySeconds: 10,

  targets: [
    {
      id: "example-system",
      enabled: false,

      // 用于在没有匹配标签页且 openIfMissing=true 时打开页面。
      pageUrl: "https://example.com/app/home",

      // Chrome match patterns。建议收窄到目标系统域名，避免误匹配。
      urlPatterns: ["https://example.com/*"],

      // 可选的二次过滤。满足任意一项即可。
      urlIncludes: ["https://example.com/app/"],
      urlRegexes: [],

      // 要点击的元素。支持 CSS selector；也可以改成 selectors 数组作为备用链。
      selector: "#keep-session-button",
      selectors: [],

      intervalMinutes: 50,
      waitForSelectorMs: 10000,
      openIfMissing: true,
      activeWhenOpened: true,
      promptLoginWhenOpened: true,
      loginPromptTitle: "Page Helper 已打开目标页面",
      loginPromptMessage: "请完成登录。登录成功后，扩展会按配置定时点击页面以保持会话状态。",
      loginPromptDurationMs: 30000,
      clickAllMatchingTabs: false,
      allFrames: true,
      scrollIntoView: true,

      // mouse-events: 发送 pointer/mouse 事件；native: 调用 element.click()；
      // both: 两种都做。保活一般优先 mouse-events。
      clickStrategy: "mouse-events"
    }
  ]
};
