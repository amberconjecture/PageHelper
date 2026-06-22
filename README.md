# Page Helper

一个开发者配置型 Chrome 扩展，用于按配置在指定页面执行自动化辅助动作。当前内置了定时点击能力，可用于页面保活、定时触发无副作用控件等场景。

## 使用方式

1. 打开 `src/config.js`。
2. 把 `targets[0]` 改成你的系统配置，并将 `enabled` 改为 `true`。
3. 在 Chrome 地址栏打开 `chrome://extensions/`。
4. 打开右上角「开发者模式」。
5. 点击「加载已解压的扩展程序」，选择本目录。

每次修改 `src/config.js` 或其它扩展源码后，都需要回到 `chrome://extensions/`，点击这个扩展卡片上的「重新加载」。重新加载后，扩展会在后台日志里打印当前读取到的目标、定时器和下一次执行时间。

## 配置示例

```js
export const KEEP_ALIVE_CONFIG = {
  defaultIntervalMinutes: 50,
  targets: [
    {
      id: "internal-admin",
      enabled: true,
      pageUrl: "https://admin.example.com/home",
      urlPatterns: ["https://admin.example.com/*"],
      urlIncludes: ["https://admin.example.com/"],
      selector: "button[data-page-helper-action='click-target']",
      intervalMinutes: 50,
      openIfMissing: true,
      activeWhenOpened: true,
      promptLoginWhenOpened: true,
      loginPromptTitle: "Page Helper 已打开目标页面",
      loginPromptMessage: "请完成登录。登录成功后，扩展会按配置定时执行页面动作。",
      clickAllMatchingTabs: false,
      allFrames: true,
      clickStrategy: "mouse-events"
    }
  ]
};
```

## 字段说明

- `id`：目标唯一标识，会用于定时任务名称。
- `enabled`：是否启用这个目标。
- `pageUrl`：目标页面地址；当 `openIfMissing` 为 `true` 时会自动打开。
- `urlPatterns`：Chrome match patterns，用于查找已打开的目标标签页。
- `urlIncludes` / `urlRegexes`：二次过滤规则，避免误点同域名下的其它页面。
- `selector` / `selectors`：要点击的元素 CSS 选择器；`selectors` 可作为备用选择器数组。
- `intervalMinutes`：点击间隔。页面 1 小时过期时建议设为 `50`。
- `openIfMissing`：没有打开目标页时是否自动打开；默认建议为 `true`。
- `activeWhenOpened`：自动打开页面时是否切到该标签页，方便用户完成登录。
- `promptLoginWhenOpened`：自动打开页面后是否在页面右下角提示用户登录。
- `loginPromptTitle` / `loginPromptMessage`：登录提示文案。
- `clickAllMatchingTabs`：是否点击所有匹配标签页；默认只点最近使用的一个。
- `allFrames`：是否在所有 frame 中查找元素，适合目标元素在 iframe 中的页面。
- `clickStrategy`：`mouse-events`、`native` 或 `both`。

## 查看日志

1. 打开 `chrome://extensions/`。
2. 找到 Page Helper。
3. 点击「Service Worker」或「检查视图」打开后台控制台。
4. 搜索 `[PageHelper]`。

后台会记录这些关键事件：

- `Setting up alarms.`：扩展读取配置并准备定时器。
- `No enabled targets.`：没有任何启用的目标，通常是 `enabled` 没改成 `true` 或扩展没重新加载。
- `Created alarm.`：已创建定时器，日志里会有 `firstRunAt` 和 `intervalMinutes`。
- `Alarm fired.`：定时器触发。
- `No matching tab found; opening configured page.`：没有找到页面，准备主动打开 `pageUrl`。
- `Opened page and prompted the user to sign in.`：页面已打开，并已提示用户登录。
- `Clicked target element.`：已经完成保活点击。

最近 300 条日志也会保存在 `chrome.storage.local`。在 Service Worker 控制台执行：

```js
chrome.storage.local.get("pagehelper.logs").then(console.log)
```

## 注意事项

- 如果目标页面没有打开，扩展会按 `pageUrl` 主动打开并切到该标签页，显示登录提示；这一轮不会执行保活点击，下一轮定时任务会继续检测和点击。
- 选择器应指向一个点击后不会改变业务状态的元素，例如刷新会话按钮、空白安全区域、导航栏 Logo 等。
- 扩展发出的点击事件不是浏览器认可的真实用户手势，无法绕过需要真实用户激活的浏览器限制；但多数页面自己的“无操作超时”监听可以被这类事件刷新。
- 当前 `manifest.json` 使用了 `<all_urls>` 方便开发环境直接工作。如果要发布到团队或商店，建议把 `host_permissions` 收窄到实际目标域名。
