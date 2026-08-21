# Page Helper

一个配置驱动的 Chrome 扩展，用于按站点执行页面自动化与服务端 WebSocket 同步。点击扩展图标后，可以分别勾选要同步的网站；各站点的页面、连接、token 和运行状态按 `target.id` 隔离，多个选项可以同时启用。

## 使用方式

1. 打开 `src/config.js`，把两个示例站点的 URL、页面存储键、WebSocket 地址和 CSRF token 规则改成真实配置。
2. 在 Chrome 地址栏打开 `chrome://extensions/`。
3. 打开右上角「开发者模式」。
4. 点击「加载已解压的扩展程序」，选择本目录。
5. 点击工具栏中的 Page Helper 图标，按需勾选网站一、网站二；两个选项互不排斥。

勾选状态保存在 `chrome.storage.local`，关闭面板或重启浏览器后仍会保留。切换选项会立即通知后台：启用时建立该站点的定时任务和同步连接，停用时只清理该站点，不影响其它已勾选站点。每次修改 `src/config.js` 或其它扩展源码后，仍需回到 `chrome://extensions/` 点击「重新加载」。

## 内网自动更新

当前 `manifest.json` 已配置 `update_url`，默认指向：

```json
"update_url": "https://your-internal-server.com/extension/page-helper/update.xml"
```

发布前请把它改成你自己的内网静态服务地址。Chrome 会定期请求这个 XML 更新清单；当清单里的 `version` 高于本机已安装版本时，会下载并安装 `codebase` 指向的 `.crx`。

自动更新只适用于已安装的 `.crx` 扩展；开发者模式下「加载已解压的扩展程序」不会走这套更新机制。自托管 CRX 的安装/静默分发还受平台和 Chrome 企业策略影响，面向 Windows/macOS 批量分发前请先用目标管理策略验证安装通道。

### 打包 CRX

首次打包会生成固定插件 ID 所需的私钥：

```bash
./scripts/pack-crx.sh
```

脚本会把发布内容复制到 `dist/page-helper/`，调用 Chrome 打包，并把首次生成的私钥保存到 `private/page-helper.pem`。这个 `.pem` 决定扩展 ID，后续每次更新都必须继续使用同一个文件。`private/`、`.pem` 和 `.crx` 已加入 `.gitignore`，不要提交到仓库。

如果私钥放在其它路径，可以显式传入：

```bash
./scripts/pack-crx.sh /secure/path/page-helper.pem
```

每次发布新版本前，先递增 `manifest.json` 里的 `version`，再重新执行打包脚本。生成的文件名类似：

```text
dist/page-helper-0.2.0.crx
```

### 生成 update.xml

打包完成后，到 `chrome://extensions/` 查看这个 CRX 安装后的扩展 ID，然后生成更新清单：

```bash
./scripts/generate-update-xml.sh aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa https://your-internal-server.com/extension/page-helper-0.2.0.crx
```

这会生成 `deploy/update.xml`。你也可以参考 `deploy/update.xml.example` 手动维护：

```xml
<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'>
    <updatecheck codebase='https://your-internal-server.com/extension/page-helper-0.2.0.crx' version='0.2.0' />
  </app>
</gupdate>
```

把 `update.xml` 和对应的 `.crx` 上传到内网静态文件服务即可。以后升级只需要递增版本号、复用同一个 `.pem` 重新打包、上传新 `.crx`，并更新 XML 里的 `version` 与 `codebase`。

静态服务建议为 `.crx` 返回 `Content-Type: application/x-chrome-extension`。如果响应带有 `X-Content-Type-Options: nosniff`，但 `Content-Type` 又不是 Chrome 认可的类型，安装或更新可能会失败。

注意：Chrome 请求自动更新清单时不会携带 Cookie，也会忽略响应里的 `Set-Cookie`。如果内网服务需要访问控制，建议用网络/VPN、防火墙或其它不依赖浏览器 Cookie 的方式处理。

### Windows 一键安装

Windows 可以通过 Chrome 企业策略强制安装这个扩展。生成可双击导入的注册表文件：

```bash
./scripts/generate-windows-force-install-reg.sh aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa https://your-internal-server.com/extension/page-helper/update.xml
```

这会生成 `deploy/windows-install-force.reg`，内容类似：

```reg
Windows Registry Editor Version 5.00

[HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist]
"1"="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;https://your-internal-server.com/extension/page-helper/update.xml"
```

把这个 `.reg` 文件发给 Windows 用户后，用户双击或右键「合并」即可写入策略。由于写入的是 `HKEY_LOCAL_MACHINE`，普通用户没有权限时会弹出 UAC 或导入失败。导入后重启 Chrome，或打开 `chrome://policy` 点击「重新加载政策」，即可触发安装。

注意：这是企业策略安装方式，Chrome 会把浏览器标记为“由贵单位管理”。Google 官方文档说明，自动安装非 Chrome Web Store 扩展时，Windows 设备通常需要处于 Active Directory 域或其它企业管理通道下；面向普通个人电脑分发前请先在目标环境验证。

## 配置示例

面板会自动遍历带 `syncOption` 的 target，不需要在 HTML 中手写选项。下面是一项双 token 配置；第二个站点只需复制整个 target、换一个唯一 `id`，并把 `csrfTokens` 数组缩减为一项。仓库内的 `src/config.js` 已同时放好了双 token 和单 token 两个完整示例。

```js
export const KEEP_ALIVE_CONFIG = {
  defaultIntervalMinutes: 50,
  targets: [
    {
      id: "internal-admin",
      enabled: true,
      syncOption: {
        label: "内部管理站",
        description: "双 CSRF Token 配置",
        defaultEnabled: false
      },
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
      clickStrategy: "mouse-events",
      webSocket: {
        enabled: true,
        url: "wss://api.example.com/page-helper/ws",
        targetUrl: "https://admin.example.com/home",
        targetUrlPatterns: ["https://admin.example.com/*"],
        targetUrlIncludes: ["https://admin.example.com/"],
        localStorageKey: "auth-token",
        localStorageQueryKey: "auth-token",
        sessionStorageKey: "page-session",
        sessionStorageJsonPath: "$.client.id",
        csrfTokens: [
          {
            id: "hw-csrf",
            url: "https://admin.example.com/api/csrf-token",
            headerName: "X-hw-Csrftoken",
            responseType: "json",
            valuePath: "$",
            serialize: "json"
          },
          {
            id: "session-csrf",
            url: "https://admin.example.com/api/gpmp-csrf-token",
            headerName: "X-Session-Csrf-Token",
            responseType: "auto",
            valuePaths: ["$.csrfToken", "$"],
            serialize: "string",
            cookieName: "gpmp-csrfToken"
          }
        ],
        commandHeaders: {
          "X-Page-Helper": "true"
        },
        keepAliveIntervalMs: 20000,
        keepAliveMessage: {
          type: "pagehelper.keepalive"
        }
      }
    }
  ]
};
```

## 字段说明

- `id`：非空且唯一的字符串标识，会用于定时任务名称和站点状态隔离。
- `enabled`：开发者配置开关；为 `false` 时不出现在面板，也不会运行。用户是否同步由面板勾选状态决定。
- `syncOption.label` / `description`：面板中显示的名称和说明。
- `syncOption.defaultEnabled`：这个站点尚未产生本地勾选记录时的默认状态。示例为安全起见均设为 `false`。
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

### WebSocket 字段

- `webSocket.enabled`：是否启用 WebSocket 能力。
- `webSocket.url`：服务端 WebSocket 地址，支持 `ws://` 和 `wss://`。
- `webSocket.targetUrl` / `targetUrlPatterns` / `targetUrlIncludes` / `targetUrlRegexes`：用于检测 TargetUrl 页面的地址规则；未配置时复用 target 上的 `pageUrl` / `urlPatterns` / `urlIncludes` / `urlRegexes`。
- `webSocket.localStorageKey`：TargetUrl 页面 `localStorage` 中的 key，默认示例为 `auth-token`。只有这个 key 有值时才会发起连接。
- `webSocket.localStorageQueryKey`：追加到 WebSocket URL 上的 query key；未配置时等于 `localStorageKey`。
- `webSocket.sessionStorageKey`：顶层 `pageUrl` 页面 `sessionStorage` 中保存 client 信息的 key。
- `webSocket.sessionStorageJsonPath`：从 `pageUrl` 页面的 `sessionStorage[sessionStorageKey]` 这段 JSON 里提取 `client_id` 的路径，例如 `$.client.id`、`user.clients[0].id`。最终 query key 固定为 `client_id`。
- `webSocket.csrfTokens`：命令请求前按顺序执行的 token 配置数组。双 token 站点配置两项，单 token 站点只配置一项；站点之间不共享数组或结果。
- `csrfTokens[].url` / `method` / `credentials` / `requestHeaders`：token 请求地址、方法、凭证模式和可选请求头。默认分别为 `GET`、`include`、空对象。
- `csrfTokens[].responseType`：`json`、`text` 或 `auto`。`auto` 会根据响应 Content-Type 尝试解析 JSON。
- `csrfTokens[].valuePath` / `valuePaths`：从响应提取值的 JSON path；`$` 代表整个响应。`valuePaths` 可提供按顺序尝试的备用路径。
- `csrfTokens[].serialize`：`json` 会用 `JSON.stringify`，`string` 会转成字符串。
- `csrfTokens[].headerName`：把提取后的值写入最终业务请求的哪个 header。
- `csrfTokens[].cookieName`：可选；配置后还会把相同值写入当前页面域名的 cookie。不同站点可用不同名称，未配置则不写。
- 旧字段 `webSocket.csrfTokenUrl` 和 `webSocket.gpmpCsrfTokenUrl` 仍兼容，并会自动映射成原来的双 token 行为；新站点建议使用 `csrfTokens`。
- `webSocket.commandHeaders`：收到 WebSocket `command` 消息后，在 `pageUrl` 页面内发起 fetch 时追加的固定请求头对象。
- `webSocket.storageCheckIntervalMs`：目标页内检测 local/session storage 变化的间隔，默认 `3000`。
- `webSocket.reconnectDelayMs`：连接异常关闭后的重连延迟，默认 `5000`。
- `webSocket.keepAliveIntervalMs`：WebSocket 连接成功后发送客户端心跳的间隔，默认 `20000`。MV3 Service Worker 空闲窗口约 30 秒，因此会被限制在 `5000` 到 `25000` 之间；设置为 `0` 或 `false` 可关闭心跳。
- `webSocket.keepAliveMessage`：客户端心跳消息，默认发送 `{"type":"pagehelper.keepalive"}`。如果服务端要求固定文本或其它 JSON 格式，请改成服务端能识别或忽略的消息。
- `webSocket.logMessages`：是否记录服务端消息长度，默认 `false`，避免高频消息刷屏。

### 新增更多网站

在 `KEEP_ALIVE_CONFIG.targets` 中追加一个对象即可。需要保证 `id` 唯一，并配置 `syncOption`；面板会自动增加对应复选项。页面匹配、WebSocket、storage key、`csrfTokens`、固定请求头及可选 cookie 全部写在这个对象内，不会复用其它站点的配置。若只需要一个 token，`csrfTokens` 数组只放一项即可。

WebSocket 创建时机：扩展启动、安装/重载、目标 Tab 完成加载、目标 Tab URL 变化、storage watcher 检测到值变化、或后台周期校验时，只要检测到匹配的 TargetUrl 页面，就会检查 `pageUrl` 页面是否已打开；如果未打开，会主动拉起一个 `pageUrl` 页面。扩展会记住自己拉起的 tab，如果该页面跳转到登录页等非 `pageUrl` 地址，只要这个 tab 还存在，就不会重复拉起新的 `pageUrl`。随后只要 TargetUrl 页面的 `localStorage[localStorageKey]` 有值、`pageUrl` 页面的 `sessionStorage[sessionStorageKey]` 能按 JSON path 取到值，就会连接服务端。安装扩展时页面已经打开也会被扫描到。

WebSocket 关闭时机：当所有匹配 TargetUrl 的 Tab 都被关闭或导航离开后，扩展会主动断开连接。若 token 或 client_id 发生变化，扩展会用新的 query 重建连接。

MV3 后台脚本是 `service_worker`，长时间没有事件或 WebSocket 消息时可能被浏览器挂起，连接也会随之关闭。扩展默认每 20 秒发送一次客户端心跳，避免连接空闲超过浏览器的后台脚本空闲窗口；如果服务端不接受默认心跳，需要调整 `keepAliveMessage`。

### WebSocket command 消息

服务端发送 JSON 消息且 `type` 为 `command` 时，扩展会在当前匹配的 `pageUrl` 标签页内发起 fetch：

- `action`：作为 fetch URL。
- `payload`：作为 fetch 请求体；对象会序列化为 JSON 字符串。
- `method`：作为 fetch method；未提供时默认为 `POST`。

请求前会在该站点的 `pageUrl` 页面内依次执行 `webSocket.csrfTokens`。每一项独立请求、解析并写入自己配置的 header/可选 cookie；任一必需项失败时，只终止当前站点的这条 command。最终请求会合并 `webSocket.commandHeaders` 中配置的固定 KV。响应体会按 JSON content-type 优先解析，否则作为文本返回。扩展会向服务端发送：

```json
{
  "type": "event",
  "action": "client_response",
  "payload": "收到的响应体",
  "id": "收到的 command.id"
}
```

## 查看日志

1. 打开 `chrome://extensions/`。
2. 找到 Page Helper。
3. 点击「Service Worker」或「检查视图」打开后台控制台。
4. 搜索 `[PageHelper]`。

后台会记录这些关键事件：

- `Setting up alarms.`：扩展读取配置并准备定时器。
- `No enabled keep-alive targets.`：当前没有勾选带页面点击配置的站点，或对应 target 没有 selector。
- `Created alarm.`：已创建定时器，日志里会有 `firstRunAt` 和 `intervalMinutes`。
- `Alarm fired.`：定时器触发。
- `No matching tab found; opening configured page.`：没有找到页面，准备主动打开 `pageUrl`。
- `Opened page and prompted the user to sign in.`：页面已打开，并已提示用户登录。
- `Clicked target element.`：已经完成保活点击。
- `WebSocket connecting.` / `WebSocket connected.`：已经按配置开始连接或连接成功，日志里的 URL 会隐藏 query 值。
- `WebSocket prerequisites are not ready.`：目标页存在，但 localStorage token 或 sessionStorage client_id 还没准备好。
- `Closing WebSocket connection.`：所有匹配目标页都已关闭、导航离开，或配置变更导致连接关闭。

## 自动验证

项目使用 Node 内置测试，无需安装第三方依赖：

```bash
npm test
```

测试覆盖两个站点的四种勾选组合、面板到后台的持久化路径、并发更新不丢状态、双/单 token 请求、异常 token 拦截，以及停用站点后卸载页面 watcher。

最近 300 条日志也会保存在 `chrome.storage.local`。在 Service Worker 控制台执行：

```js
chrome.storage.local.get("pagehelper.logs").then(console.log)
```

## 注意事项

- 如果目标页面没有打开，扩展会按 `pageUrl` 主动打开并切到该标签页，显示登录提示；这一轮不会执行保活点击，下一轮定时任务会继续检测和点击。
- 选择器应指向一个点击后不会改变业务状态的元素，例如刷新会话按钮、空白安全区域、导航栏 Logo 等。
- 扩展发出的点击事件不是浏览器认可的真实用户手势，无法绕过需要真实用户激活的浏览器限制；但多数页面自己的“无操作超时”监听可以被这类事件刷新。
- 当前 `manifest.json` 使用了 `<all_urls>` 方便开发环境直接工作。如果要发布到团队或商店，建议把 `host_permissions` 收窄到实际目标域名。
