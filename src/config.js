export const KEEP_ALIVE_CONFIG = {
  // 页面 1 小时无点击会过期时，建议设置为 45-55 分钟。
  defaultIntervalMinutes: 50,
  defaultWaitForSelectorMs: 10000,
  defaultStartDelaySeconds: 10,
  defaultWebSocketStorageCheckIntervalMs: 3000,
  defaultWebSocketReconnectDelayMs: 5000,
  defaultWebSocketReconcileIntervalMinutes: 1,

  targets: [
    {
      id: "example-page",
      enabled: false,

      // 用于在没有匹配标签页且 openIfMissing=true 时打开页面。
      pageUrl: "https://example.com/app/home",

      // Chrome match patterns。建议收窄到目标系统域名，避免误匹配。
      urlPatterns: ["https://example.com/*"],

      // 可选的二次过滤。满足任意一项即可。
      urlIncludes: ["https://example.com/app/"],
      urlRegexes: [],

      // 要点击的元素。支持 CSS selector；也可以改成 selectors 数组作为备用链。
      selector: "#page-helper-target",
      selectors: [],

      intervalMinutes: 50,
      waitForSelectorMs: 10000,
      openIfMissing: true,
      activeWhenOpened: true,
      promptLoginWhenOpened: true,
      loginPromptTitle: "Page Helper 已打开目标页面",
      loginPromptMessage: "请完成登录。登录成功后，扩展会按配置定时执行页面动作。",
      loginPromptDurationMs: 30000,
      clickAllMatchingTabs: false,
      allFrames: true,
      scrollIntoView: true,

      // mouse-events: 发送 pointer/mouse 事件；native: 调用 element.click()；
      // both: 两种都做。保活一般优先 mouse-events。
      clickStrategy: "mouse-events",

      webSocket: {
        enabled: false,

        // 服务端 WebSocket 地址。最终会追加两个 query：
        // 1) localStorageQueryKey=TargetUrl 页面的 localStorage[localStorageKey]
        // 2) client_id=pageUrl 页面的 JSON path(sessionStorage[sessionStorageKey])
        url: "wss://example.com/ws",

        // 可选：WebSocket 监听的 TargetUrl 地址规则。未配置时复用上面的 pageUrl/urlPatterns/urlIncludes/urlRegexes。
        targetUrl: "https://example.com/app/home",
        targetUrlPatterns: ["https://example.com/*"],
        targetUrlIncludes: ["https://example.com/app/"],
        targetUrlRegexes: [],

        localStorageKey: "auth-token",
        localStorageQueryKey: "auth-token",
        sessionStorageKey: "page-session",
        sessionStorageJsonPath: "$.client.id",
        commandHeaders: {
          // 这里可追加固定请求头；X-hw-Csrftoken 会从 pageUrl 页面的 localStorage.userInfo.csrfToken 自动设置。
          // "X-Page-Helper": "true"
        },

        storageCheckIntervalMs: 3000,
        reconnectDelayMs: 5000,
        logMessages: false
      }
    }
  ]
};
