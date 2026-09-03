# ChatGPT Android 自动化

这是独立于 `chatgpt-auto-confirm` 的新 Mahayana 小程序。旧 macOS/Electron 版本保持不变；本插件直接操控 **Android ChatGPT APK**，并以 GitHub-hosted Actions + Android Emulator 作为主要持续运行环境。

## 架构

主运行时使用 **TypeScript / Node.js**，Android UI 使用 **ADB + Appium 3 / UiAutomator2**：

```text
GitHub Actions (ubuntu-24.04)
  -> Android Emulator / AVD
  -> ChatGPT Android APK (com.openai.chatgpt)
  -> ADB + Appium UiAutomator2
  -> chatgpt-android-controller
  -> 持久化任务队列
```

选择 TypeScript 而不是纯 Rust/Kotlin，是因为 Mahayana/MCP 已经是 Node 插件运行时，控制器运行在 Runner/桌面宿主侧。Android 的跨应用 UI 能力交给 ADB/UiAutomator2，不额外维护 Rust/JNI 或自研 AccessibilityService。

## APK 登录态复用

登录成功的唯一验收条件是：

1. 前台包名是 `com.openai.chatgpt`；
2. APK 页面不存在登录/注册控件；
3. APK 内检测到真实 Chat composer。

**浏览器页面不是登录成功条件。**

GitHub-hosted Runner 每一轮结束前会冷关 Emulator，将 AVD 内容目录整体打包，其中包括 Android 用户数据、ChatGPT APK 私有状态、设备设置和 controller queue state。打包结果使用 `CHATGPT_AUTO_CONFIRM_STATE_KEY` 加密后才进入 Actions cache。

下一轮 Runner 恢复加密 AVD 后直接启动 ChatGPT APK。如果 APK composer 仍然可用，就直接继续任务，不重复登录。

如果没有可恢复 AVD，或 APK 登录已失效，`bootstrap-apk-login.mjs` 会从 **APK 自己的登录按钮**进入官方认证流程。已有 `CHATGPT_SESSION_COOKIES_B64` 仅可作为这次认证流程的 bootstrap 输入；最终必须回到 ChatGPT APK 并再次通过 composer 验证才算成功。之后保存新的完整 AVD 状态，后续轮次优先直接恢复 APK 登录态。

插件不会读取或打印 ChatGPT APK 私有 token/Cookie，也不会把未加密 AVD 数据上传到 artifact/cache。

## 持续 GitHub Actions

`.github/workflows/chatgpt-android-apk-runner.yml` 实现分段持续运行：

1. 恢复最近的加密 AVD state；没有则创建 Android 35 Play Store AVD。
2. 启动 Emulator，并检查 `com.openai.chatgpt`。
3. restored AVD 已包含 APK 时直接复用；fresh AVD 使用受控 APK URL + SHA-256 强校验安装。
4. 验证 APK 登录；必要时执行 APK login bootstrap。
5. 启动 Appium UiAutomator2。
6. 真正从 APK 发一条 smoke 消息，并要求 ChatGPT 回复唯一 marker。
7. smoke 通过后启动动态持久任务队列。
8. 每轮约运行 5 小时后停止 Emulator、加密 checkpoint，再 `workflow_dispatch` 下一轮 Runner。

因此单个 GitHub-hosted job 的生命周期不会丢失长期任务状态。

fresh AVD 需要在受保护 Environment 中配置：

- `CHATGPT_ANDROID_APK_URL`
- `CHATGPT_ANDROID_APK_SHA256`
- 已有 `CHATGPT_AUTO_CONFIRM_STATE_KEY`
- 首次 APK bootstrap 可复用已有 `CHATGPT_SESSION_COOKIES_B64`

仓库不会硬编码第三方 APK 镜像。APK URL 下载后必须先通过配置的 SHA-256，才允许 `adb install` / `adb install-multiple`。

## Action 证据与调试

控制台日志只记录脱敏信息，例如：

- 当前阶段和错误码
- foreground package
- UI node / editable / login-control 数量
- Appium/ADB 可用状态
- 队列任务状态计数
- smoke marker 是否观察到
- AVD checkpoint 密文大小

完整截图、ChatGPT package logcat、Appium 日志和 Emulator 日志写入 diagnostics 目录。上传 artifact 前先用 `CHATGPT_AUTO_CONFIRM_STATE_KEY` 加密，仓库里不保存明文截图或 Chat 内容。

关键脚本：

- `scripts/verify-apk-session.mjs`：验证 APK 登录状态并采集证据
- `scripts/bootstrap-apk-login.mjs`：从 APK 官方登录入口恢复登录
- `scripts/avd-state.sh`：加密保存/恢复完整 AVD 状态
- `scripts/apk-smoke.ts`：真实发送消息并验证 ChatGPT 回复 marker
- `scripts/action-runner.ts`：持续读取任务 inbox、对账并运行队列

## 自动化能力

- 多 Android 设备槽位（兼容旧版 `account_*` 命名）
- 自动扫描并点击 `Allow once / 允许一次 / 允許一次`
- `start / stop / status / scan_once / relaunch_and_confirm`
- `send_message / add_connector / get_reply / chat_status / send_and_watch`
- 持久化任务队列：依赖、优先级、多设备并发、暂停/恢复、验收、反馈重跑、取消、watchdog
- 动态读取 `chatgpt-auto-confirm/tasks/actions-inbox.json`，在 Runner 不重启的情况下吸收任务 revision 更新

watcher 只在 ChatGPT 已经位于 Android 前台时扫描，不会为了后台扫描抢走另一 App。`send_and_watch` 会记录发送前页面基线，排除刚发送的用户消息，避免把用户 prompt 误判成助手回复。

## 选择器策略

插件不以固定屏幕坐标作为主要识别方式。每次操作抓取 Android accessibility hierarchy，优先匹配：

1. `text`
2. `content-description`
3. `resource-id`
4. 控件类型（如 `EditText`）
5. 最后使用目标节点实时 `bounds` 点击

ChatGPT Android UI 更新后，通常只需要补充语义 selector，而不是重新录制整套坐标。

## 本地调试

需要 Node.js >= 22.6、Android platform-tools 和已连接的 Android 设备/Emulator。

```bash
adb devices -l
npm run setup:appium
npx appium
npm start
```

默认 Appium 地址为 `http://127.0.0.1:4723`，可通过 `CHATGPT_ANDROID_APPIUM_URL` 覆盖。

MCP server 由 `.mcp.json` 直接通过 Node 启动：

```bash
node --experimental-strip-types --import ./runtime/safety-patches.ts server/index.ts
```

## 状态与隐私

本地默认状态：

```text
~/.mahayana/chatgpt-android-controller/state.json
~/.mahayana/chatgpt-android-controller/audit.log
```

审计只记录动作类型、设备槽位、字符数和错误，不记录消息正文、Cookie 或 Token。

主要环境变量：

- `CHATGPT_ANDROID_CONTROLLER_STATE`
- `CHATGPT_ANDROID_CONTROLLER_AUDIT`
- `CHATGPT_ANDROID_ADB`
- `CHATGPT_ANDROID_APPIUM_URL`
- `CHATGPT_ANDROID_PACKAGE`（默认 `com.openai.chatgpt`）
- `CHATGPT_ANDROID_STATE_KEY`
- `CHATGPT_ANDROID_AVD_ROOT`
- `CHATGPT_ANDROID_STATE_FILE`
