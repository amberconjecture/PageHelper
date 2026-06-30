# Page Helper

一个开发者配置型 Chrome 扩展，用于按配置在指定页面执行自动化辅助动作。当前内置了定时点击和服务端 WebSocket 连接能力，可用于页面保活、定时触发无副作用控件、把页面会话身份透传给服务端等场景。

## 使用方式

1. 打开 `src/config.js`。
2. 把 `targets[0]` 改成你的系统配置，并将 `enabled` 改为 `true`。
3. 在 Chrome 地址栏打开 `chrome://extensions/`。
4. 打开右上角「开发者模式」。
5. 点击「加载已解压的扩展程序」，选择本目录。

每次修改 `src/config.js` 或其它扩展源码后，都需要回到 `chrome://extensions/`，点击这个扩展卡片上的「重新加载」。重新加载后，扩展会在后台日志里打印当前读取到的目标、定时器和下一次执行时间。

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
dist/page-helper-0.1.0.crx
```

### 生成 update.xml

打包完成后，到 `chrome://extensions/` 查看这个 CRX 安装后的扩展 ID，然后生成更新清单：

```bash
./scripts/generate-update-xml.sh aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa https://your-internal-server.com/extension/page-helper-0.1.0.crx
```

这会生成 `deploy/update.xml`。你也可以参考 `deploy/update.xml.example` 手动维护：

```xml
<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'>
    <updatecheck codebase='https://your-internal-server.com/extension/page-helper-0.1.0.crx' version='0.1.0' />
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
        csrfTokenUrl: "https://admin.example.com/api/csrf-token",
        gpmpCsrfTokenUrl: "https://admin.example.com/api/gpmp-csrf-token",
        commandHeaders: {
          "X-Page-Helper": "true"
        }
      }
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

### WebSocket 字段

- `webSocket.enabled`：是否启用 WebSocket 能力。
- `webSocket.url`：服务端 WebSocket 地址，支持 `ws://` 和 `wss://`。
- `webSocket.targetUrl` / `targetUrlPatterns` / `targetUrlIncludes` / `targetUrlRegexes`：用于检测 TargetUrl 页面的地址规则；未配置时复用 target 上的 `pageUrl` / `urlPatterns` / `urlIncludes` / `urlRegexes`。
- `webSocket.localStorageKey`：TargetUrl 页面 `localStorage` 中的 key，默认示例为 `auth-token`。只有这个 key 有值时才会发起连接。
- `webSocket.localStorageQueryKey`：追加到 WebSocket URL 上的 query key；未配置时等于 `localStorageKey`。
- `webSocket.sessionStorageKey`：顶层 `pageUrl` 页面 `sessionStorage` 中保存 client 信息的 key。
- `webSocket.sessionStorageJsonPath`：从 `pageUrl` 页面的 `sessionStorage[sessionStorageKey]` 这段 JSON 里提取 `client_id` 的路径，例如 `$.client.id`、`user.clients[0].id`。最终 query key 固定为 `client_id`。
- `webSocket.csrfTokenUrl`：收到 WebSocket `command` 消息后，在 `pageUrl` 页面内先用 `GET` 调用这个接口；接口返回的完整 JSON 会被序列化后写入请求头 `X-hw-Csrftoken`。
- `webSocket.gpmpCsrfTokenUrl`：收到 WebSocket `command` 消息后，在 `pageUrl` 页面内用 `GET` 调用这个新增接口，并带上页面 cookie。扩展会从接口响应中获取 `csrfToken`，写入当前域名的 `gpmp-csrfToken` cookie，并写入请求头 `X-Session-Csrf-Token`。
- `webSocket.commandHeaders`：收到 WebSocket `command` 消息后，在 `pageUrl` 页面内发起 fetch 时追加的固定请求头对象。
- `webSocket.storageCheckIntervalMs`：目标页内检测 local/session storage 变化的间隔，默认 `3000`。
- `webSocket.reconnectDelayMs`：连接异常关闭后的重连延迟，默认 `5000`。
- `webSocket.logMessages`：是否记录服务端消息长度，默认 `false`，避免高频消息刷屏。

WebSocket 创建时机：扩展启动、安装/重载、目标 Tab 完成加载、目标 Tab URL 变化、storage watcher 检测到值变化、或后台周期校验时，只要检测到匹配的 TargetUrl 页面，就会检查 `pageUrl` 页面是否已打开；如果未打开，会主动拉起一个 `pageUrl` 页面。扩展会记住自己拉起的 tab，如果该页面跳转到登录页等非 `pageUrl` 地址，只要这个 tab 还存在，就不会重复拉起新的 `pageUrl`。随后只要 TargetUrl 页面的 `localStorage[localStorageKey]` 有值、`pageUrl` 页面的 `sessionStorage[sessionStorageKey]` 能按 JSON path 取到值，就会连接服务端。安装扩展时页面已经打开也会被扫描到。

WebSocket 关闭时机：当所有匹配 TargetUrl 的 Tab 都被关闭或导航离开后，扩展会主动断开连接。若 token 或 client_id 发生变化，扩展会用新的 query 重建连接。

### WebSocket command 消息

服务端发送 JSON 消息且 `type` 为 `command` 时，扩展会在当前匹配的 `pageUrl` 标签页内发起 fetch：

- `action`：作为 fetch URL。
- `payload`：作为 fetch 请求体；对象会序列化为 JSON 字符串。
- `method`：作为 fetch method；未提供时默认为 `POST`。

请求前会先在 `pageUrl` 页面内用 `GET` 调用 `webSocket.csrfTokenUrl`，将接口返回的完整 JSON 用 `JSON.stringify` 后放入 `X-hw-Csrftoken` 请求头；随后调用 `webSocket.gpmpCsrfTokenUrl`，从接口响应中取出 `csrfToken`，写入当前域名的 `gpmp-csrfToken` cookie，并放入 `X-Session-Csrf-Token` 请求头。最终请求会合并 `webSocket.commandHeaders` 中配置的固定 KV。响应体会按 JSON content-type 优先解析，否则作为文本返回。扩展会向服务端发送：

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
- `No enabled targets.`：没有任何启用的目标，通常是 `enabled` 没改成 `true` 或扩展没重新加载。
- `Created alarm.`：已创建定时器，日志里会有 `firstRunAt` 和 `intervalMinutes`。
- `Alarm fired.`：定时器触发。
- `No matching tab found; opening configured page.`：没有找到页面，准备主动打开 `pageUrl`。
- `Opened page and prompted the user to sign in.`：页面已打开，并已提示用户登录。
- `Clicked target element.`：已经完成保活点击。
- `WebSocket connecting.` / `WebSocket connected.`：已经按配置开始连接或连接成功，日志里的 URL 会隐藏 query 值。
- `WebSocket prerequisites are not ready.`：目标页存在，但 localStorage token 或 sessionStorage client_id 还没准备好。
- `Closing WebSocket connection.`：所有匹配目标页都已关闭、导航离开，或配置变更导致连接关闭。

最近 300 条日志也会保存在 `chrome.storage.local`。在 Service Worker 控制台执行：

```js
chrome.storage.local.get("pagehelper.logs").then(console.log)
```

## 注意事项

- 如果目标页面没有打开，扩展会按 `pageUrl` 主动打开并切到该标签页，显示登录提示；这一轮不会执行保活点击，下一轮定时任务会继续检测和点击。
- 选择器应指向一个点击后不会改变业务状态的元素，例如刷新会话按钮、空白安全区域、导航栏 Logo 等。
- 扩展发出的点击事件不是浏览器认可的真实用户手势，无法绕过需要真实用户激活的浏览器限制；但多数页面自己的“无操作超时”监听可以被这类事件刷新。
- 当前 `manifest.json` 使用了 `<all_urls>` 方便开发环境直接工作。如果要发布到团队或商店，建议把 `host_permissions` 收窄到实际目标域名。
