export const KEEP_ALIVE_CONFIG = {
  // 页面 1 小时无点击会过期时，建议设置为 45-55 分钟。
  defaultIntervalMinutes: 50,
  defaultWaitForSelectorMs: 10000,
  defaultStartDelaySeconds: 10,
  defaultWebSocketStorageCheckIntervalMs: 3000,
  defaultWebSocketReconnectDelayMs: 5000,
  defaultWebSocketConnectTimeoutMs: 15000,
  defaultWebSocketReconcileIntervalMinutes: 1,
  defaultWebSocketKeepAliveIntervalMs: 20000,

  targets: [
    {
      id: "example-page",
      // enabled 控制这项配置是否提供给扩展；用户是否实际启用由面板勾选状态决定。
      enabled: true,
      syncOption: {
        label: "网站一",
        description: "现有双 CSRF Token 配置",
        defaultEnabled: false
      },

      // 两个站点共用 WebSocket 时，按 command.action 的 URL 路径选择唯一 target。
      // 推荐填写完整路径段，例如 action=/api/website-one/orders 时填写 "website-one"。
      // 启用时必须同时填写精确 allowedOrigins，并为每个启用的 WebSocket target 配置路由。
      // 只有所有 target 的数组都为空时，才沿用“消息属于收到它的 WebSocket”的旧行为。
      commandRouting: {
        allowedOrigins: [],
        pathPrefixes: [],
        pathSegments: [],
        pathIncludes: []
      },

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
        enabled: true,

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
        csrfTokenUrl: "https://example.com/api/csrf-token",
        gpmpCsrfTokenUrl: "https://example.com/api/gpmp-csrf-token",
        commandHeaders: {
          // 这里可追加固定请求头；X-hw-Csrftoken 会通过 csrfTokenUrl GET 获取。
          // X-Session-Csrf-Token 会通过 gpmpCsrfTokenUrl GET 获取，并写入 gpmp-csrfToken cookie。
          // "X-Page-Helper": "true"
        },

        storageCheckIntervalMs: 3000,
        reconnectDelayMs: 5000,
        connectTimeoutMs: 15000,
        keepAliveIntervalMs: 20000,
        keepAliveMessage: {
          type: "pagehelper.keepalive"
        },
        logMessages: false
      }
    },
    {
      // 第二个站点完全使用自己的页面、存储键、WebSocket 和 token 配置。
      // 请把下面的 example 地址与键名替换成真实值。
      id: "second-page",
      enabled: true,
      syncOption: {
        label: "网站二",
        description: "独立的单 CSRF Token 配置",
        defaultEnabled: false
      },

      // 请填写网站二的精确 API Origin，以及与网站一不重复的完整路径段。
      commandRouting: {
        allowedOrigins: [],
        pathPrefixes: [],
        pathSegments: [],
        pathIncludes: []
      },

      pageUrl: "https://second.example.com/app/home",
      urlPatterns: ["https://second.example.com/*"],
      urlIncludes: ["https://second.example.com/app/"],
      urlRegexes: [],

      selector: "#page-helper-target",
      selectors: [],
      intervalMinutes: 50,
      waitForSelectorMs: 10000,
      openIfMissing: true,
      activeWhenOpened: true,
      promptLoginWhenOpened: true,
      loginPromptTitle: "Page Helper 已打开网站二",
      loginPromptMessage: "请完成登录。登录成功后，扩展会同步这个网站。",
      loginPromptDurationMs: 30000,
      clickAllMatchingTabs: false,
      allFrames: true,
      scrollIntoView: true,
      clickStrategy: "mouse-events",

      webSocket: {
        enabled: true,
        url: "wss://second.example.com/ws",
        targetUrl: "https://second.example.com/app/home",
        targetUrlPatterns: ["https://second.example.com/*"],
        targetUrlIncludes: ["https://second.example.com/app/"],
        targetUrlRegexes: [],
        localStorageKey: "auth-token",
        localStorageQueryKey: "auth-token",
        sessionStorageKey: "page-session",
        sessionStorageJsonPath: "$.client.id",

        // token 是数组：这个站点只声明一项，因此每次 command 只会请求这一个 URL。
        // responseType/valuePath/serialize/headerName 请按真实接口响应调整。
        csrfTokens: [
          {
            id: "site-two-csrf",
            url: "https://second.example.com/api/csrf-token",
            headerName: "X-hw-Csrftoken",
            responseType: "json",
            valuePath: "$",
            serialize: "json"
          }
        ],
        commandHeaders: {},
        storageCheckIntervalMs: 3000,
        reconnectDelayMs: 5000,
        connectTimeoutMs: 15000,
        keepAliveIntervalMs: 20000,
        keepAliveMessage: {
          type: "pagehelper.keepalive"
        },
        logMessages: false
      }
    }
  ]
};
