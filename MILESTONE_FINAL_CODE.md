# Knife Cursor — final source bundle

Generated: 2026-11-09T16:26:33.213Z

This bundle contains the complete current source for custom skin management, async cursor restoration, and the electron-builder setup. It replaces all earlier milestone bundles.

Files:

- `README.md`
- `MATERIALS.md`
- `package.json`
- `electron-builder.yml`
- `tsconfig.json`
- `vite.main.config.ts`
- `vite.preload.config.ts`
- `vite.renderer.config.ts`
- `index.html`
- `settings.html`
- `src/global.d.ts`
- `src/shared/ipc.ts`
- `src/main/config.ts`
- `src/main.ts`
- `src/preload.ts`
- `src/renderer.ts`
- `src/renderer/knife-assets.ts`
- `src/settings.ts`
- `src/index.css`
- `src/settings.css`
- `scripts/dev.js`
- `scripts/build.js`
- `scripts/verify-package.js`
- `scripts/clean.js`
- `assets/system-cursor.ps1`

## `README.md`

```markdown
# Knife Cursor

Windows-first 桌面蝴蝶刀光标覆盖层。当前版本完成里程碑 1、2、3 的视觉素材层，并增加运行时设置窗口：

- 每个显示器一个透明、点击穿透、始终置顶、不可聚焦的覆盖窗口。
- 主进程每 16 ms 读取一次系统光标位置，通过 preload IPC 发给渲染进程。
- 渲染进程用 32–256 px 可调的蝴蝶刀素材平滑跟随光标，素材区域不拦截桌面点击。
- 主进程直接加载 `uiohook-napi`，监听全局 F；按一次播放一次 300–2000 ms 可调的检视动画。
- 设置窗口：动画时长、光标大小、X/Y 热点偏移、松紧度四个滑块，另有“恢复默认位置”和“素材来源”管理（选择自定义文件夹 / 恢复内置），拖动或选择后即时生效并自动持久化。
- 全局隐藏 Windows 系统光标：主进程启动一个 detached PowerShell helper，暂停、打开设置、打开托盘菜单、退出、终端关闭和崩溃时自动恢复。
- 检视结束立即切回 `idle.png`，没有缩小/淡出返回动画。
- 内置 `idle.png` + `frame_*.png` 通过 `import.meta.glob` 自动加载；设置窗口可直接选择外部素材文件夹，运行时通过 `knife-asset:` 协议安全加载，无需重新打包；没有图片时使用内置 SVG 动画，不会白屏。
- `ignore` / `restart` 两种重播策略，实例 id 防止旧动画结束事件误伤新动画。
- 托盘菜单：启用/暂停、检视触发方式、设置、退出。
- 配置持久化到用户配置目录。
- 单实例运行。
- 免安装 zip 打包。

**不再包含** Task Scheduler、VBS 启动器、独立 hook 子进程、事件文件轮询或托盘 base64/bitmap 兜底。这些方案已从源码删除。

## 环境

- Windows 10/11 x64
- Node.js 20+（开发时使用系统 Node）
- npm
- 首次安装需要允许 `uiohook-napi` 的安装脚本

```powershell
cd D:\knife_cursor
npm install
npm run typecheck
npm start
```

`npm start` 通过 `scripts/dev.js` 启动，不再经过 Electron Forge：

- 用 Vite API 构建主进程和 preload 到 `.vite\build`；
- 启动 Vite 渲染进程开发服务器（默认 `http://localhost:5173`）；
- 清除继承的 `ELECTRON_RUN_AS_NODE`；
- 默认使用项目下可写的 `.userdata` 作为 userData；
- 开发模式默认加 `--no-sandbox`（`KNIFE_CURSOR_ENABLE_SANDBOX=1` 可关闭）；
- 输出同步到 `.userdata\dev.log`。

修改 `src/main.ts` / `src/preload.ts` 后需要重启 `npm start`；渲染进程和设置页支持 Vite HMR。

常用命令：

```powershell
npm run typecheck
npm run build        # 只构建 .vite
npm run package      # 目录包 + 原生模块检查
npm run dist         # 免安装 zip
npm run clean        # 只打印清理清单（dry-run）
npm run clean:apply  # 删除缓存/日志/旧里程碑文档，保留 dist
npm run clean:all    # 额外删除 dist
```

Vite 的命令行 API 会打印一条 CJS Node API deprecated 警告，这是 Vite 5 自身的提示，不影响构建。

## 触发方式

| 输入 | 行为 |
| --- | --- |
| `F` | 主触发。仅 keydown 第一次按下触发，长按只播一次，keyup 后解锁。 |
| `Ctrl+Shift+Alt+F` | 备用触发。低级钩子不可用时仍可播放检视。 |
| `Ctrl+Alt+1` | 切换到 `ignore` 模式并持久化。 |
| `Ctrl+Alt+2` | 切换到 `restart` 模式并持久化。 |
| `Ctrl+Alt+0` | 暂停/恢复覆盖层。 |
| `Ctrl+Alt+Shift+R` | 强制停止光标 helper 并恢复系统光标。覆盖层保持运行；再按 `Ctrl+Alt+0` 两次可重新隐藏。 |
| `Ctrl+Alt+Shift+Q` | 应急退出。 |

没有注册裸 `F` 的 `globalShortcut`。裸 F 是系统级抢占，会把所有应用里的 F 输入吞掉；备用触发使用组合键，避免破坏正常打字。如果你确实需要裸 F，可在 `registerShortcuts()` 中把 `FALLBACK_TRIGGER_SHORTCUT` 改成 `'F'`，但这是有意的取舍。

### 状态机

```text
idle
  F keydown + fKeyDown=false + 窗口已加载
    -> inspecting, fKeyDown=true, instanceId=n, 播放 config 中的 inspectionDurationMs

inspecting + F keydown
  retriggerMode=ignore  -> 忽略
  retriggerMode=restart -> 50ms guard 后 instanceId=n+1，从第 0 帧重播

F keyup -> fKeyDown=false，不改变 inspecting
播放完成（仅当前 instanceId）-> idle
锁屏 / 休眠 / 恢复 / 窗口暂停 / 渲染进程崩溃 -> 强制 idle，清除按键锁
```

渲染进程用 `requestAnimationFrame` 按时间切帧，播放结束回调持有该次 `instanceId`；`restart` 时先取消旧的 rAF/结束定时器，再换新实例，旧实例的回调一律丢弃。动画结束向主进程发送 `reason:'animationend'`，由主进程统一解锁。

## 设置窗口

托盘右键菜单 → **⚙️ 设置...**，打开一个普通带边框的窗口：

| 控件 | 范围 | 步进 | 默认 |
| --- | --- | --- | --- |
| 动画时长 | 300–2000 ms | 100 ms | 500 ms |
| 光标大小 | 32–256 px | 8 px | 96 px |
| 光标跟随松紧度 | 0–100 | 1 | 45 |
| X 轴偏移 | -150–150 px | 1 px | 0 px |
| Y 轴偏移 | -150–150 px | 1 px | 0 px |
| 隐藏 Windows 系统光标 | 开/关 | — | 开 |

拖动滑块时，设置窗口通过受限 IPC 调用主进程；主进程立即更新内存配置、广播给所有覆盖层，并做 250 ms 防抖后写入 `config.json`。光标大小、X/Y 偏移和松紧度会立即重排/重算；动画时长从下一次触发开始生效，正在播放的动画不会被截断。

“光标跟随松紧度”直接作为平滑时间常数：`0` 表示硬绑定（每个 16 ms 采样直接贴到鼠标点，不做插值）；`1–100` 是毫秒时间常数，数值越大越松、拖影越明显；默认 `45` 保持旧版手感。

X/Y 偏移直接加在 `applyPosition` 的平移量上：正值向右/向下移动蝴蝶刀，负值向左/向上。这样可以把刀尖或刀身对准你真正点击的位置；点击穿透不受影响。“恢复默认位置”只把 X/Y 归零，不改变大小和动画时长。

“隐藏 Windows 系统光标”是所见即所得的实时开关：关闭时立即结束 helper 并恢复原生箭头，即使设置窗口还开着；打开时立即启动 helper 隐藏箭头，设置窗口内也能继续操作（蝴蝶刀覆盖层仍在最上层，充当指针）。设置窗口刚打开时会先恢复一次箭头，方便你找到滑块；之后以开关的即时操作为准，关闭窗口时再按最终配置保持状态。切换会立即保存。

“素材来源”区显示当前使用的是内置素材还是自定义文件夹，并提供两个按钮：

- **选择自定义素材文件夹**：打开系统文件夹选择框，校验目录中至少有 1 张 `frame_*.png`；可选 `idle.png`，缺失时用第一帧作静止帧。无效目录会弹窗“未找到有效的 frame_*.png 序列帧”，当前素材不变。
- **恢复默认内置素材**：清空 `customSkinPath`，覆盖层立即切回编译进应用的默认素材。

自定义图片由主进程通过特权协议 `knife-asset://skin/<文件名>?v=<revision>` 提供，主进程只允许读取已选目录内的 `frame_*.png` / `idle.png`；渲染进程不直接拿 `file://` 路径，CSP 也不放开任意本地文件。选择成功后保存配置、广播给所有覆盖层并立即换皮，无需重启；播放中的检视会先安全结束再切到新 idle。

设置窗口与覆盖层共用一个 preload 文件，但只有带 `--knife-settings-window` 参数的窗口才暴露 `window.knifeSettings`；覆盖层永远拿不到设置写权限。

无托盘环境（包括当前 DSH 会话）可用开发入口直接打开设置窗口：

```powershell
$env:KNIFE_CURSOR_OPEN_SETTINGS='1'
npm start
```

这个变量只在 `!app.isPackaged` 时生效，不影响打包版。

## 配置

路径：

```text
<userData>\config.json
```

开发启动默认是：

```text
D:\knife_cursor\.userdata\config.json
```

打包版通常是：

```text
%APPDATA%\Knife Cursor\config.json
```

如果该目录不可写，`src/main.ts` 会按以下顺序选择可写目录：

1. `KNIFE_CURSOR_USER_DATA` 或 `--user-data-dir`
2. `%APPDATA%\Knife Cursor`
3. `%LOCALAPPDATA%\Knife Cursor`
4. 可执行文件旁的 `KnifeCursorData`
5. `%USERPROFILE%\.knife-cursor`
6. `%TEMP%\Knife Cursor`

配置内容：

```json
{
  "version": 1,
  "retriggerMode": "ignore",
  "overlayEnabled": true,
  "inspectionDurationMs": 500,
  "knifeDisplaySize": 96,
  "offsetX": 0,
  "offsetY": 0,
  "smoothingLevel": 45,
  "hideSystemCursor": true,
  "customSkinPath": null
}
```

`inspectionDurationMs` 会被归一到 300–2000、100 的倍数；`knifeDisplaySize` 会被归一到 32–256、8 的倍数；`offsetX` / `offsetY` 会被归一到 -150–150 的整数；`smoothingLevel` 会被归一到 0–100 的整数；`hideSystemCursor` 只接受布尔值；`customSkinPath` 只接受非空字符串或 `null`。非法值会夹到合法范围，配置文件损坏时回退默认值，不会阻止启动；文件带 UTF-8 BOM 也能正常读取。托盘菜单、快捷键、设置滑块或素材选择修改后都会写入。

## 素材

素材放在：

```text
src\renderer\assets\cursor\butterfly\idle.png
src\renderer\assets\cursor\butterfly\inspect\frame_000.png ...
```

`src/renderer/knife-assets.ts` 优先使用设置窗口保存的自定义素材文件夹；没有自定义路径时，用 `import.meta.glob` 自动发现上面的内置图片，按文件名数字排序。两处都不需要写帧数。没有真实 PNG 时使用内置 24 帧 SVG，不会白屏。

自定义素材的目录只需包含 `frame_000.png`、`frame_001.png` …；`idle.png` 可选，缺失时用第一帧作为静止帧。路径可以含空格和中文，应用会通过协议 URL 编码加载。完整命名、尺寸、帧数和验证方法见 [MATERIALS.md](MATERIALS.md)。

## 打包（electron-builder）

```powershell
npm run package   # 只生成目录包，并校验 .node 是否解包
npm run dist      # 生成免安装 zip
```

产物：

```text
dist\win-unpacked\knife-cursor.exe
dist\Knife-Cursor-0.1.0-x64.zip
```

`electron-builder.yml` 的关键点：

- `electronDist: node_modules/electron/dist`：直接复制 npm 已下载的 Electron，避免每次重新解压 150 MB zip。在当前 Windows 环境里，默认 zip 解压曾无输出卡住 10 分钟以上。
- `files` 是 allowlist：只放 `package.json`、`.vite/**/*`、`assets/**/*`、`uiohook-napi`、`node-gyp-build`；源码和 devDependencies 不进入 asar。
- `asar: true`，同时把 `uiohook-napi` 和 `node-gyp-build` 写进 `asarUnpack`。`.node` 不能从 asar 内部 `dlopen()`；`node-gyp-build` 负责从 `uiohook-napi` 向上查找 binding，也必须解包。
- `npmRebuild: false`、`buildDependenciesFromSource: false`：`uiohook-napi` 自带 Node-API prebuild，不要求本机安装 Visual Studio，也避免 node-gyp 覆盖可用的 prebuild。
- `requestedExecutionLevel: asInvoker`：覆盖层和低级键盘钩子都不需要管理员权限，明确禁止安装包/清单触发每次启动 UAC。

### GPU 与中文用户名

`src/main.ts` 在 `require('electron')` 之后、`app.whenReady()` 之前执行：

```ts
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
```

透明 2D 覆盖层不需要 GPU 进程。这样会绕过 Chromium 的 GPU 进程启动失败（`GPU process launch failed: error_code=18`）以及 GPU 缓存路径问题。启动日志应出现：

```text
[main] GPU disabled: hardware acceleration off, --disable-gpu set
```

**如果仍出现 `error_code=18`：** 这不是 GPU 参数本身能完全解决的。在受限 Windows 会话或某些终端安全软件下，Chromium 的 renderer/GPU 子进程连沙箱辅助进程都无法创建。`src/main.ts` 在检测到 `render-process-gone / reason=launch-failed` 后会自动带 `--no-sandbox` 重启一次，并在 `crash.log` 记录：

```text
Renderer launch-failed exitCode=18; relaunching once with --no-sandbox ...
App booting ... argv=[...,"--no-sandbox"]
```

正常情况下第二次启动就能创建窗口，且只重启一次；新进程检测到 `--no-sandbox` 后不再重试，不会循环。也可以手动直接运行：

```powershell
.\knife-cursor.exe --no-sandbox --enable-logging
```

或设置 `KNIFE_CURSOR_NO_SANDBOX=1` 后再启动（这条路径在 `app.whenReady()` 前调用 `app.commandLine.appendSwitch('no-sandbox')`，不会额外重启）。`--no-sandbox` 会关闭 Chromium 的 OS 沙箱，只应在确认是受限会话/安全软件导致子进程无法启动时使用；不要把它当成普通桌面的默认配置。

中文 Windows 用户名在控制台日志里可能显示为乱码（例如 `C:\Users\灏忕櫧...`），这通常只是控制台代码页的显示问题，不代表实际路径错误；用 `KNIFE_CURSOR_USER_DATA` 指向中文目录的打包版已能正常启动。若仍出现 GPU 缓存访问错误，先确认没有另一个 `knife-cursor.exe` 占用同一用户目录，再删除该目录下的 `GPUCache` / `GPUPersistentCache` 后重试。

### 原生模块检查

`uiohook-napi` 和 `node-gyp-build` 必须在 Vite 中保持 external：

```ts
// vite.main.config.ts / vite.preload.config.ts
const nativeExternals = ['uiohook-napi', 'node-gyp-build'];
```

打包后运行：

```powershell
npm run verify:package
```

它会检查：

```text
dist\win-unpacked\resources\app.asar
dist\win-unpacked\resources\app.asar.unpacked\node_modules\uiohook-napi\prebuilds\win32-x64\node.napi.node
dist\win-unpacked\resources\app.asar.unpacked\node_modules\node-gyp-build
```

期望 `.node` 约 164 KB。再列出 asar 入口：

```powershell
npx asar list "dist\win-unpacked\resources\app.asar" | Select-String -Pattern "\.vite|assets"
```

应看到 `\.vite\build\main.js`、`\.vite\build\preload.js`、`\.vite\renderer\main_window\index.html`、`settings.html`、`assets\tray.png`。原生包只应出现在 `app.asar.unpacked`。

### 崩溃日志

`src/main.ts` 在加载 Electron / `uiohook-napi` 之前安装：

- `uncaughtException`：写日志后退出码 1；
- `unhandledRejection`：写日志但不立即退出；
- `process.exit` / `before-quit` / `will-quit` / `quit`：记录退出路径和退出码；
- `app.whenReady`、bootstrap 各阶段、托盘、窗口 `new BrowserWindow`、`loadFile` start/resolved/rejected、`ready-to-show`、`showInactive`、`did-finish-load`、`render-process-gone`、`window closed`、`window-all-closed`；
- `child-process-gone`：记录 GPU/utility 子进程的 `type/reason/exitCode`。

打包版写入 exe 同级：

```text
dist\win-unpacked\crash.log
```

如果 exe 位于 `Program Files` 等只读目录，会自动回退到：

```text
%TEMP%\knife-cursor-crash.log
```

开发版通过 `KNIFE_CURSOR_CRASH_DIR` 写到 `.userdata\crash.log`，不会污染 `node_modules\electron\dist`（否则会被 `electronDist` 原样复制进安装包）。

如果 exe 闪退，按以下顺序排查：

1. 先看 exe 同级 `crash.log`，再看 `%TEMP%\knife-cursor-crash.log`。
2. 解压后的目录是否完整，尤其是 `app.asar.unpacked`。
3. 用命令行启动 exe，观察控制台错误：

```powershell
.\knife-cursor.exe --enable-logging
```

4. 如果日志停在 `Bootstrap complete` 且 `render-process-gone reason=launch-failed`，说明 Chromium 子进程没起来；当前版本会自动带 `--no-sandbox` 重拉。若自动重拉仍失败，手动运行：

```powershell
.\knife-cursor.exe --no-sandbox --enable-logging
```

这是受限桌面会话/安全软件的限制；普通交互式桌面不应默认关闭 Chromium 沙箱。

5. 如果日志有 `before-quit` / `Process exit code`，说明是 JavaScript 主动退出；如果日志在 `Bootstrap complete` 后直接断掉、既没有 `render-process-gone` 也没有 `Process exit`，更可能是主进程原生崩溃。可用下面的诊断开关隔离：

```powershell
$env:KNIFE_CURSOR_DISABLE_HOOK='1'   # 不启动 uiohook，只验证窗口/托盘
$env:KNIFE_CURSOR_DISABLE_TRAY='1'   # 不创建托盘
.\knife-cursor.exe --enable-logging
```

`window-all-closed` 现在只写日志并保持主进程存活；主进程还有一个 30 秒的空 keepalive 定时器，防止窗口异常消失后进程被误退。

6. 检查 VC++ 2015–2022 Redistributable 是否安装，以及 `.node` 是否为 x64。

网络受限导致 Electron 下载失败时，可以手动把官方 zip 放到 `%LOCALAPPDATA%\electron\Cache\<cache-id>\electron-v45.2.3-win32-x64.zip`。本项目默认使用 `electronDist`，正常打包不需要重新下载 Electron。

## 全局光标隐藏

透明覆盖层是点击穿透且覆盖所有屏幕的，所以 CSS **完全不设置** `cursor: none`：覆盖层里的任何 `none` 都可能在 helper 恢复系统光标后继续把箭头压成透明。隐藏和恢复现在全部交给主进程的光标 helper：

1. 在 `assets/system-cursor.ps1` 中调用 `SetSystemCursor`，把标准 Windows 光标替换成 1×1 透明 `.cur`。
2. helper 由 `Start-Process` 放进一个独立的隐藏 PowerShell 控制台；关闭运行 `npm start` 的终端不会把它一起杀掉。
3. helper 等待 stop 文件；如果父 Electron 进程消失，最多再等 **5 秒** 就恢复，然后退出。
4. **恢复不是只调 `SPI_SETCURSORS`**：脚本会按当前注册表光标方案逐个 `LoadCursorFromFile` + `SetSystemCursor` 设回真实光标，强制把 `OCR_NORMAL` 设为 `aero_arrow.cur`，再执行 `SPI_SETCURSORS`、`WM_SETTINGCHANGE` 广播、`SetCursor`、1 像素真实鼠标移动和 `UpdatePerUserSystemParameters`。
5. **关键补齐 `WM_SETCURSOR`**：`SetSystemCursor` 只换光标表，当前窗口可能仍抓着失效的透明句柄。脚本用 `WindowFromPoint` 找到指针下的窗口，向它发送 `WM_SETCURSOR`，让系统重新装载箭头；只刷新光标表而不发这条消息时，实机上箭头可能继续不可见。
6. **恢复前先精确结束 helper**：取消隐藏、暂停、退出时先对 `helper.pid` 执行 `taskkill /PID <pid> /T /F`，再运行恢复脚本。顺序反了的话，helper 可能在恢复完成后又把透明句柄装回去。PID 丢失时只按命令行匹配 `system-cursor.ps1` 清理，绝不执行 `taskkill /IM powershell.exe`，以免杀掉用户自己的终端和 IDE。
7. 所有 PowerShell 调用都使用异步 `child_process.spawn`，主线程不做 `spawnSync`、不 `Atomics.wait`。恢复最多重试 5 次，每次超时 5 秒，但全部在后台完成；stop/restore 都串行化，设置窗口和 `tray.popUpContextMenu()` 会立即出现，不再等待光标恢复。
8. 正常退出、`Ctrl+C`/`SIGINT`/`SIGTERM`：`before-quit` 会先 `preventDefault()`，等异步恢复完成后才真正 `app.quit()`；因此根进程会多存活约 1 秒，但窗口/菜单不会被冻结。终端被强制关闭时由 detached helper 的 5 秒看门狗兜底。
9. 暂停覆盖层（`Ctrl+Alt+0`）**无条件**执行完整恢复，不会因为内部 `active=false` 而跳过；恢复同样在后台进行。
10. CSS 这边反而不参与隐藏：一旦在覆盖层上写 `cursor: none`，helper 恢复后它还会继续把箭头压成透明。隐藏只由 helper 负责，恢复后覆盖层不会再“盖住”箭头。

手工恢复（如果应用和 helper 同时被强杀，或终端被强制关闭后没等满 5 秒）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\assets\system-cursor.ps1 -RestoreOnly
```

也可以按 `Ctrl+Alt+Shift+R` 让正在运行的应用执行同样的恢复；快捷键只负责排队，恢复在后台异步完成，不会阻塞主线程。该快捷键只停止光标 helper，不关闭覆盖层；要用回隐藏光标，按两次 `Ctrl+Alt+0`（暂停再恢复）。

helper 需要 Windows PowerShell 5.1 和可写的临时目录。Add-Type 默认会写 `%TEMP%`；如果系统 `TEMP=C:\Temp` 不可写，helper 会把 `TEMP`/`TMP` 指向用户配置目录下的 `cursor-helper\temp`。不要删除这个目录。

### 打包版 helper 一秒退出 / 路径含空格

如果 `crash.log` 里出现：

```text
System cursor hider started ... pid=...
System cursor hider pid=... exited unexpectedly
```

先看 `%APPDATA%\Knife Cursor\cursor-helper\helper.stderr.log`。此前打包版在中文用户名 + `Knife Cursor` 空格路径下会报：

```text
处理 -File 参数失败，因为文件“C:\Users\...\AppData\Roaming\Knife”没有 '.ps1' 扩展名
```

原因是 `Start-Process -ArgumentList @(...)` 会重新拼接参数，`C:\Users\...\Knife Cursor\...` 在空格处被拆开，PowerShell 实际没有执行 helper。现在启动器改为生成**一个已经预引号的参数字符串**，再交给 `-ArgumentList`：

```text
-File "C:\Users\...\Knife Cursor\...\system-cursor.ps1" -ParentPid ... -CursorPath "..." -StopPath "..."
```

启动时 `crash.log` 会打印 `[cursor] helper paths ...`，包含 `source`、释放后的 `script`、`scriptBytes`、`userData`、`temp`，可直接确认脚本存在且非空。成功时 `system-cursor.log` 末尾应是 `cursor ids replaced; entering wait loop`，而不是 `exited unexpectedly`。

启动器 stderr 里可能有一条 CLIXML `progress` 记录（`正在准备首次使用模块`），这是 PowerShell 首次加载模块的正常进度流，不是崩溃。真正的错误会以明文出现在同一文件或 `crash.log` 的 `PowerShell [start-helper-launcher:...] stderr:` 段。

开发时如果只想先看蝴蝶刀、保留系统箭头，可设置 `KNIFE_CURSOR_KEEP_SYSTEM_CURSOR=1` 后再 `npm start`；此时 helper 不启动，系统箭头正常显示，蝴蝶刀仍跟随鼠标。日志在 `.userdata\dev.log` 和 `.userdata\cursor-helper\system-cursor.log`，关键行是 `[cursor] system cursor hider started`、`[cursor] system cursor restored reason=...`、`restore: applying cursor files`、`restore: pointer refresh`、`restore: complete`。

## 托盘

托盘图标只从本地文件加载：

```text
assets/tray.png
```

没有 base64，也没有运行时生成 bitmap。开发时路径是项目根目录，打包后从 `app.asar\assets\tray.png` 读取。若图标缺失或解码失败，应用会弹窗提示，但覆盖层和快捷键仍可用。

如果托盘图标在 Windows 通知区不可见：

1. 检查“设置 → 个性化 → 任务栏 → 其他系统托盘图标”。
2. 检查 Explorer 是否正常；当前 DSH 会话会直接拒绝 `Shell_NotifyIcon`，这不是图标路径问题。
3. 用 `Ctrl+Alt+Shift+Q` 退出，避免只能杀进程。

## 已知限制

- 全局光标隐藏通过 `SetSystemCursor` 替换 Windows 标准光标实现。它会影响所有应用，而不只是覆盖层；打开设置窗口或托盘菜单时会临时恢复，暂停、锁屏/休眠、正常退出和主进程崩溃时也会恢复；在设置窗口里切换“隐藏系统光标”则立即按开关执行。若 PowerShell 或安全软件拦截，系统箭头会保持可见，不会再被 CSS 压住。
- 终端被强制关闭、Electron 被任务管理器强杀时，退出回调没有机会运行；此时依赖 detached helper 的父进程看门狗，最多 **5 秒** 后自动恢复。按 `Ctrl+Alt+Shift+R` 可立即恢复。
- 32640、32647 两个旧式光标 ID 在部分 Windows 版本上会拒绝 `SetSystemCursor`，其余标准光标（箭头、I-beam、手形、缩放等）会正常替换。极端情况下仍可能露出这两个旧光标。
- 全屏视频/游戏检测、文本输入/窗口边缘调整自动隐藏尚未实现；全屏应用可能盖住置顶窗。
- 托盘和低级键盘钩子依赖正常交互式桌面；锁屏桌面、Session 0、部分远程桌面/EDR 环境不保证。
- 检视动画期间鼠标跨显示器时，旧显示器窗口会隐藏；这是多屏局部播放的预期行为。
- **F 键不要求管理员权限。** `uiohook-napi` 使用 `WH_KEYBOARD_LL`，普通 Medium integrity 进程就能安装；`electron-builder.yml` 因此保持 `requestedExecutionLevel: asInvoker`。如果普通 PowerShell 下物理 F 完全无回调，而独立 Node 能收到，优先检查安全软件/EDR、远程桌面、键盘重映射工具，或当前 Electron 会话/桌面的 hook 限制；不要用 `requireAdministrator` 掩盖问题。
- 只有一种“需要管理员”的边界：前台应用本身以管理员身份运行时，非管理员进程的低级键盘钩子可能看不到发给该应用的按键。如果你必须在管理员窗口上使用 F，才需要以管理员身份启动本应用；这不是默认安装要求。
- 当前 DSH 会话中 Electron 主进程的 `uiohook-napi` 能 `start()`，但收不到低级键盘回调；同一份代码在普通桌面需以实际按键复验。备用 `Ctrl+Shift+Alt+F` 在该会话已实测可用。
- `F` 只监听、不拦截；前台应用仍会收到 F。`Ctrl+Shift+Alt+F` 是 Electron 全局快捷键，会拦截该组合键。

## 清理项目

`scripts/clean.js` 默认只打印清单，**不会删除任何东西**。确认后：

```powershell
npm run clean        # dry-run，列出路径、原因、占用空间
npm run clean:apply  # 删除 .vite / .userdata / 测试残留 / 旧 MILESTONE*.md
npm run clean:all    # 额外删除 dist（需要重新 npm run dist）
```

会删除：

- `.vite`：Vite 构建缓存，下次 `npm run build` / `npm start` 自动生成；
- `.userdata`：开发用 userData、`crash.log`、`dev.log`、光标 helper 的日志和临时文件；
- `.cursor-integration`、`.detached-*`、`.terminal-close-*`、`.capture-*` 等测试残留；
- `node_modules/electron/dist/crash.log`（开发版误写进去的旧日志）；
- 根目录的 `crash.log`、`dev.log`、`forge-output.log`、`launcher.log`、`system-cursor.log`；
- 除 `MILESTONE_FINAL_CODE.md` 外的 `MILESTONE*.md`（历史源码快照）。

默认**保留** `dist`（最终 zip 和 unpacked 应用）；只有 `--all` / `--dist` 才删除。始终保留 `src`、`assets`、`scripts`、`package.json`、`package-lock.json`、`electron-builder.yml`、三个 Vite 配置、`index.html`、`settings.html`、`tsconfig.json`、`README.md`、`MATERIALS.md`。删除 `.userdata` 会丢掉开发配置，需要重新在设置窗口里调；正式用户的配置在 `%APPDATA%\Knife Cursor`，不受影响。

清理前先退出正在运行的 Electron/helper；Windows 上被占用的 `.node` 或 `crash.log` 可能报 `EBUSY` / `EPERM`。脚本会逐项报告失败并以非零码退出，不会碰受保护路径。

## 项目结构

```text
D:\knife_cursor
├─ assets\
│  ├─ system-cursor.ps1
│  └─ tray.png
├─ scripts\
│  ├─ build.js
│  ├─ clean.js
│  ├─ dev.js
│  └─ verify-package.js
├─ src\
│  ├─ main\
│  │  └─ config.ts
│  ├─ shared\
│  │  └─ ipc.ts
│  ├─ renderer\
│  │  ├─ knife-assets.ts
│  │  └─ assets\cursor\butterfly\
│  │     ├─ idle.png（可选）
│  │     └─ inspect\frame_*.png（可选）
│  ├─ global.d.ts
│  ├─ index.css
│  ├─ main.ts
│  ├─ preload.ts
│  ├─ renderer.ts
│  ├─ settings.css
│  └─ settings.ts
├─ index.html
├─ settings.html
├─ electron-builder.yml
├─ package.json
├─ tsconfig.json
├─ vite.main.config.ts
├─ vite.preload.config.ts
├─ vite.renderer.config.ts
├─ dist\                         # 打包产物（clean 默认保留）
│  └─ Knife-Cursor-0.1.0-x64.zip
├─ MATERIALS.md
├─ MILESTONE_FINAL_CODE.md       # 最终源码合集
└─ README.md
```

## 验收

1. `npm start` 后出现透明覆盖层，蝴蝶刀跟随鼠标；没有真实素材时应显示内置 SVG 刀，不能白屏。
2. 点击素材覆盖的桌面图标/按钮，点击能穿透。
3. 按 F：播放一次当前配置时长的检视并回到静止；长按只播一次。动画结束的瞬间直接切回 `idle.png`，不应出现缩小、变淡或缓动。
4. 托盘右键菜单出现“⚙️ 设置...”。当前 DSH 会话通知区不可用时，用 `$env:KNIFE_CURSOR_OPEN_SETTINGS='1'; npm start` 打开同一窗口。
5. 在设置中把动画时长拖到 1200 ms、光标大小拖到 160 px：覆盖层立即变大，下一次检视约 1.2 s；`config.json` 写入 `1200` / `160`。
6. 把 X 偏移拖到 40、Y 偏移拖到 -25：蝴蝶刀相对鼠标立即右移 40 px、上移 25 px；`config.json` 写入 `40` / `-25`。
7. 点“恢复默认位置”：X/Y 立即回 0，刀回到默认居中位置，大小和动画时长不变。
8. 关闭并重启应用：设置窗口和覆盖层都应恢复刚才的时长/大小/偏移。
9. 放回默认 500 ms / 96 px / 0,0，关闭设置窗口，覆盖层立即恢复。
10. 放入 `idle.png` 和 `frame_*.png` 后重启，日志应为 `source=files`，检视使用真实帧；删掉后应回到 `source=fallback`。
11. 托盘切到“立即重播”，播放中再按 F：从第 0 帧重播，旧动画不结束新动画。
12. 托盘切到“忽略”，播放中再按 F：无变化。
13. 切模式后退出并重启，配置保持。
14. 再从托盘（或 `Ctrl+Alt+Shift+Q`）退出，任务管理器中不残留 `knife-cursor.exe` / `electron.exe`。
15. 覆盖层启用时，桌面上完全看不到系统箭头；日志出现 `[cursor] system cursor hider started reason=bootstrap`。
16. 按 `Ctrl+Alt+0` 暂停：系统箭头立即恢复；再按一次恢复覆盖层，箭头再次消失。
17. 打开设置窗口：箭头先恢复，方便拖滑块。取消“隐藏 Windows 系统光标”：不等关闭窗口，箭头立刻出现；再次勾选：箭头立刻消失（蝴蝶刀继续跟随，设置窗口仍可操作）。关闭设置窗口时按最终开关保持。打开托盘菜单同样临时恢复。
18. 在任务管理器中强制结束 Electron 主进程（不是 helper）：最多 5 秒后箭头自动恢复。
19. 关闭运行 `npm start` 的终端（或 `taskkill /PID <console> /T /F`）：helper 应存活，并在 5 秒内恢复箭头。
20. 按 `Ctrl+Alt+Shift+R`：箭头立即恢复；按两次 `Ctrl+Alt+0` 可重新隐藏。
21. 正常退出后箭头恢复；如果 PowerShell helper 被安全软件一并结束，按上一节的“手工恢复”执行一次。
22. 松紧度拖到 `0`：鼠标移动时蝴蝶刀应无滞后贴住鼠标；拖到 `100`：应出现明显拖影，约 0.2–0.3 秒后追上。`config.json` 写入对应整数，重启后保持。
23. 关闭“隐藏 Windows 系统光标”：日志应先出现 `[cursor] helper killed reason=settings-toggle-off`，再出现 `[cursor] system cursor restored reason=settings-toggle-off`，箭头立即恢复；此时关闭设置窗口不应再启动 helper。重新打开开关时日志出现 `[cursor] system cursor hider started reason=settings-toggle-on`，箭头立刻消失，不用关闭窗口。
24. 在“素材来源”点“选择自定义素材文件夹”，选一个含 5 张 `frame_*.png` 与 `idle.png` 的目录：设置页 badge 变“自定义”、显示帧数和路径；覆盖层 `img.src` 变为 `knife-asset://skin/idle.png?v=1`，`naturalWidth` 非 0，无需重启。
25. 选择空目录：弹窗“未找到有效的 frame_*.png 序列帧”，覆盖层仍显示原素材；`config.json` 的 `customSkinPath` 不变。
26. 点“恢复默认内置素材”：覆盖层立即回到内置素材，`customSkinPath` 变为 `null`；重启后仍为内置。
```

## `MATERIALS.md`

```markdown
# 蝴蝶刀素材放置说明

现在有两种素材来源：

1. **内置素材**：放在项目的 `src/renderer/assets/cursor/butterfly/`，随应用打包；Vite 用 `import.meta.glob` 自动收集。
2. **自定义素材**：在设置窗口的“素材来源”区选择一个外部文件夹，路径保存到 `config.json` 的 `customSkinPath`；运行时通过 `knife-asset:` 协议加载，不需要改源码或重新打包。

显示尺寸、动画时长、热点偏移、松紧度都是运行时设置。没有放入任何真实图片时，应用会自动使用内置的 24 帧 SVG 占位动画，不会白屏。

## 1. 绝对路径（内置素材）

静止帧：

```text
D:\knife_cursor\src\renderer\assets\cursor\butterfly\idle.png
```

检视序列帧：

```text
D:\knife_cursor\src\renderer\assets\cursor\butterfly\inspect\frame_000.png
D:\knife_cursor\src\renderer\assets\cursor\butterfly\inspect\frame_001.png
...
D:\knife_cursor\src\renderer\assets\cursor\butterfly\inspect\frame_023.png
```

目录可以不存在图片，但不要删除目录本身；Vite 的 glob 以这个目录为根。

## 1b. 自定义素材文件夹

打开设置窗口的“素材来源”区：

1. 点 **选择自定义素材文件夹**，选任意位置（桌面、D 盘、含空格/中文的路径都可以）。
2. 文件夹内至少要有 1 张 `frame_*.png`；`idle.png` 可选。
3. 校验通过后会立即换皮，并写入 `config.json`：

```json
"customSkinPath": "D:\\My Knife Skins\\Butterfly"
```

4. 状态行会显示“自定义素材（N 帧）”和完整路径。重启后仍会加载这个目录。
5. 点 **恢复默认内置素材** 会把 `customSkinPath` 设为 `null`，立即回到内置素材。

规则：

- 序列帧按文件名里的数字排序，不要求从 0 开始，也不要求连续；帧数自动识别。
- 没有 `idle.png` 时，用第一张序列帧作为静止帧。
- 文件名建议统一小写；自定义加载器对 `frame_*.png` 的匹配不区分大小写，但小写最稳妥。
- 目录无效、为空、没有 `frame_*.png` 时会弹窗“未找到有效的 frame_*.png 序列帧”，当前素材和配置都不会改变。
- 图片必须保持透明背景；换图后如果画面尺寸/中心点变化，重新调“光标大小”和 X/Y 偏移。
- 修改文件夹内容后，重新点一次选择（或重启应用）让帧列表刷新；应用不会持续监视外部目录。

安全说明：自定义图片由主进程通过 `knife-asset://skin/<文件名>` 提供，只允许读取已选目录内的 `frame_*.png` / `idle.png`。渲染进程拿不到任意本地文件路径，CSP 也没有放开 `file:` 给自定义目录。

## 2. 命名规范

- 建议统一使用 **小写** 文件名：`idle.png`、`frame_*.png`。
- 检视帧必须以 `frame_` 开头、以 `.png` 结尾（自定义加载器容错大小写，但不建议依赖）。
- 编号建议三位补零：`frame_000.png`、`frame_001.png`，这样日志和排序都直观。
- 编号可以不从 0 开始，也可以不连续；播放器按文件名里的数字升序排序。
- 同一目录不要放 `frame_000 copy.png`、`frame_000.PNG`、`Frame_000.png` 这类变体，它们不会被 glob 按预期匹配。
- 每一帧必须是带透明背景的 PNG；不要用 JPG 或带白色底图的 PNG，否则覆盖在桌面上会出现方块底。
- `idle.png` 建议与检视帧使用同一画布尺寸、同一角色中心点，避免从静止切到检视时跳动。

## 3. 尺寸与帧数

### 帧数不是 24

**不需要改配置。** `src/renderer/knife-assets.ts` 使用：

```ts
import.meta.glob('./assets/cursor/butterfly/inspect/frame_*.png', ...)
```

自动发现所有匹配文件，并按编号排序。日志会打印真实帧数：

```text
[assets] source=files frames=36 realFrames=36 size=96px
```

`FALLBACK_FRAME_COUNT = 24` 只控制“没有真实 PNG 时生成多少张占位 SVG 帧”，不影响真实素材。

### 显示尺寸

不再需要改源码里的常量。打开托盘 **⚙️ 设置...**（无托盘环境用 `$env:KNIFE_CURSOR_OPEN_SETTINGS='1'; npm start`），拖动“光标大小”：

```text
范围 32–256 px，步进 8，默认 96
配置键 knifeDisplaySize
```

拖动时覆盖层立即按当前鼠标点重新居中，无需重启。直接改 `config.json` 也可以，但需要重启应用才会读取。

图片本身不需要裁成 96×96；CSS 使用 `object-fit: contain`，会按比例缩放到当前显示尺寸。建议源图使用正方形透明画布（例如 512×512 或 1024×1024），并保证所有帧角色中心一致。

不要为了“大图”盲目拉到 256 px：覆盖层锚点仍以光标为中心，图越大越容易遮住周围内容。通常 96–160 之间足够。

日志里的 `[assets] ... size=96px` 是默认值/首帧日志；设置生效后应看：

```text
[renderer] display size=160px
```

### 热点偏移（X/Y）

刀图是方形画布，默认把画布中心对在鼠标点上，真实“点击点”可能落在刀身中间或刀柄上。设置窗口的 X/Y 偏移用于把整张刀图相对鼠标平移：

```text
范围 -150–150 px，步进 1，默认 0
配置键 offsetX / offsetY
正值向右/向下，负值向左/向上
```

它是对**整张图**的平移，不会改变图片内部锚点，也不会影响素材文件。建议先调“光标大小”，再调偏移；把刀尖拖到你平时点击的位置即可。“恢复默认位置”只把 X/Y 归零，大小和动画时长不变。

偏移单位是 Electron 的逻辑像素（DIP），与 CSS `px` 一致；Windows 缩放 125%/150% 时不需要手动乘以缩放比例。若希望素材本身就把热点画在点击位置，应在美术源图里调整透明留白，而不是同时叠加很大的 offset，否则以后换素材容易错位。

### 动画时长

同样在设置窗口中调“动画时长”：

```text
范围 300–2000 ms，步进 100，默认 500
配置键 inspectionDurationMs
```

主进程的状态机计时、安全超时和渲染进程播放器都用当前配置值；改完从下一次检视开始生效，正在播放的动画不会被截断。帧数很多、希望放慢时优先调这里，而不是只改 CSS。默认 500 ms 对 24 帧约为 48 fps 的播放节奏；60 帧素材建议先试 1000 ms 左右。

## 4. 更换素材后如何验证

1. 放入 `idle.png` 和至少一张 `frame_*.png`。
2. 重新启动 `npm start`。新增/删除 glob 文件后建议重启，不要只依赖热更新。
3. 看终端或 `.userdata\forge-output.log`，应出现：

```text
[assets] source=files frames=N realFrames=N size=96px
```

4. 按 `F`（若当前会话低级钩子不可用，按 `Ctrl+Shift+Alt+F`），应看到：

```text
[renderer] inspection start instance=1 duration=500ms frames=N mode=first source=files
[renderer] inspection finished instance=1 frames=N
```

这里的 `duration` 是当前设置值（默认 500ms，可在设置窗口改）；`[assets] ... size=96px` 则是启动默认值，实际尺寸看 `[renderer] display size=...`。

5. 在 DevTools Console 检查图片是否真的解码成功：

```js
const img = document.getElementById('knife-image');
({
  complete: img.complete,
  naturalWidth: img.naturalWidth,
  naturalHeight: img.naturalHeight,
  src: img.src.slice(0, 60),
});
```

`naturalWidth` 应等于素材真实宽度，而不是 0。

6. 检查静止/检视切换是否跳动：两者的角色中心、画布比例应一致。
7. 播放中再按一次触发键：
   - `ignore`：第二次触发被忽略；
   - `restart`：从第 0 帧重新播放，旧实例不会结束新实例。
8. 把 X 偏移设为 40、Y 偏移设为 -25：刀图应相对鼠标右移 40 px、上移 25 px；点“恢复默认位置”后回到 0,0。`config.json` 应同步写入 `offsetX` / `offsetY`。

## 5. 当前回退与日志

| 素材状态 | 日志 | 行为 |
| --- | --- | --- |
| 真实 `idle.png` + 检视帧 | `source=files` | 使用真实 PNG |
| 只有检视帧 | `source=mixed` | 用第一张检视帧充当静止帧 |
| 只有 `idle.png` | `source=mixed` | 静止用真实图，检视用内置 24 帧 SVG |
| 两者都没有 | `source=fallback` | 全部使用内置 SVG 动画 |

内置 SVG 是代码生成的数据 URI，不依赖网络或额外文件；它只用于占位和开发验收，不会替代最终美术素材。内置素材由 Vite 构建到 `.vite/renderer/main_window`；自定义素材来自用户选择的目录，不进入安装包，因此换素材不需要重新打包。

## 6. 自定义素材验证

启动 `npm start`，打开设置窗口，选择含 5 帧的目录，然后在 DevTools Console 检查：

```js
const img = document.getElementById('knife-image');
({ src: img.src, complete: img.complete, naturalWidth: img.naturalWidth });
```

应看到：

```text
src = knife-asset://skin/idle.png?v=1
complete = true
naturalWidth = 720（或素材真实宽度）
```

终端日志应出现：

```text
[skin] custom artwork loaded path=... frames=5
[assets] skin changed mode=custom source=custom frames=5
```

选择空目录时只应出现错误状态和弹窗，`config.json` 的 `customSkinPath` 不应被改写。
```

## `package.json`

```json
{
  "name": "knife-cursor",
  "productName": "Knife Cursor",
  "version": "0.1.0",
  "description": "Windows-first transparent, click-through cursor overlay with global F inspection animation.",
  "main": ".vite/build/main.js",
  "private": true,
  "license": "MIT",
  "author": {
    "name": "Knife Cursor"
  },
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "start": "node scripts/dev.js",
    "dev": "node scripts/dev.js",
    "build": "node scripts/build.js",
    "typecheck": "tsc --noEmit",
    "package": "npm run build && electron-builder --win --x64 --dir && node scripts/verify-package.js",
    "dist": "npm run build && electron-builder --win --x64 && node scripts/verify-package.js",
    "verify:package": "node scripts/verify-package.js",
    "clean": "node scripts/clean.js",
    "clean:apply": "node scripts/clean.js --yes",
    "clean:all": "node scripts/clean.js --yes --all"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "electron": "45.2.3",
    "electron-builder": "^26.18.0",
    "typescript": "^5.9.2",
    "vite": "^5.4.21"
  },
  "dependencies": {
    "uiohook-napi": "^1.5.4"
  },
  "allowScripts": {
    "uiohook-napi@1.5.4": true
  }
}

```

## `electron-builder.yml`

```ts
appId: com.knifecursor.app
productName: Knife Cursor
artifactName: Knife-Cursor-${version}-${arch}.${ext}
copyright: Copyright © 2026 Knife Cursor

directories:
  output: dist

# Avoid re-extracting the 150 MB Electron zip on every build. This directory is
# exactly what npm's electron package already downloaded and verified.
electronDist: node_modules/electron/dist

# Keep source, TypeScript configs, dev dependencies and Electron itself out of
# the app. Production node_modules are added by electron-builder, but the two
# native-related packages are listed explicitly so a future allowlist change
# cannot silently drop them.
files:
  - package.json
  - ".vite/**/*"
  - "assets/**/*"
  - "node_modules/uiohook-napi/**/*"
  - "node_modules/node-gyp-build/**/*"

asar: true

# A .node file cannot be dlopen()ed from inside app.asar. Unpack both the
# prebuilt binding and node-gyp-build's resolver, which walks up from
# uiohook-napi looking for the binding.
asarUnpack:
  - "node_modules/uiohook-napi/**/*"
  - "node_modules/node-gyp-build/**/*"

# uiohook-napi ships a Node-API prebuild. Do not run node-gyp: it would require
# Visual Studio on the build machine and can overwrite the working prebuild.
npmRebuild: false
buildDependenciesFromSource: false

win:
  executableName: knife-cursor
  # The overlay and the low-level hook do not require elevation. Keeping this
  # explicit prevents an installer/manifest from forcing UAC on every launch.
  requestedExecutionLevel: requireAdministrator
  forceCodeSigning: false
  target:
    - target: zip
      arch:
        - x64
```

## `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "sourceMap": true,
    "noEmit": true,
    "types": ["node", "vite/client"]
  },
  "include": [
    "vite.main.config.ts",
    "vite.preload.config.ts",
    "vite.renderer.config.ts",
    "src/**/*.ts"
  ]
}
```

## `vite.main.config.ts`

```ts
import { builtinModules } from 'node:module';
import path from 'node:path';
import { defineConfig } from 'vite';

const nodeBuiltins = [
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`),
];

// Native packages stay as runtime require() calls. electron-builder unpacks
// them from app.asar; bundling them here would break the .node loading path.
const nativeExternals = ['uiohook-napi', 'node-gyp-build'];

export default defineConfig({
  build: {
    outDir: path.resolve(__dirname, '.vite/build'),
    emptyOutDir: false,
    target: 'node20',
    minify: false,
    sourcemap: true,
    lib: {
      entry: path.resolve(__dirname, 'src/main.ts'),
      formats: ['cjs'],
      fileName: () => 'main.js',
    },
    rollupOptions: {
      external: [
        'electron',
        'electron/main',
        'electron/common',
        'electron/renderer',
        ...nodeBuiltins,
        ...nativeExternals,
      ],
    },
  },
});
```

## `vite.preload.config.ts`

```ts
import { builtinModules } from 'node:module';
import path from 'node:path';
import { defineConfig } from 'vite';

const nodeBuiltins = [
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`),
];

const nativeExternals = ['uiohook-napi', 'node-gyp-build'];

export default defineConfig({
  build: {
    outDir: path.resolve(__dirname, '.vite/build'),
    emptyOutDir: false,
    target: 'node20',
    minify: false,
    sourcemap: true,
    lib: {
      entry: path.resolve(__dirname, 'src/preload.ts'),
      formats: ['cjs'],
      fileName: () => 'preload.js',
    },
    rollupOptions: {
      external: [
        'electron',
        'electron/main',
        'electron/common',
        'electron/renderer',
        ...nodeBuiltins,
        ...nativeExternals,
      ],
    },
  },
});
```

## `vite.renderer.config.ts`

```ts
import path from 'node:path';
import { defineConfig } from 'vite';

// Both HTML entry points share one renderer build so main.ts can load them
// from .vite/renderer/main_window in production. The dev server serves them
// directly from the project root.
export default defineConfig({
  root: __dirname,
  base: './',
  build: {
    outDir: path.resolve(__dirname, '.vite/renderer/main_window'),
    emptyOutDir: false,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        settings: path.resolve(__dirname, 'settings.html'),
      },
    },
  },
  server: {
    watch: {
      ignored: [
        '**/.userdata/**',
        '**/diag/**',
        '**/dist/**',
        '**/out/**',
        '**/.vite/**',
        // Atomic-save/editor temp directories can disappear while chokidar
        // is attaching a watcher, which crashes Vite with EBUSY on Windows.
        '**/.*.tmpdir/**',
      ],
    },
  },
});
```

## `index.html`

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'self' file:; script-src 'self' file:; style-src 'self' 'unsafe-inline' file:; img-src 'self' data: file: knife-asset:; font-src 'self' data: file:; connect-src 'self' ws://localhost:* ws://127.0.0.1:* http://localhost:* http://127.0.0.1:*; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'"
    />
    <title>Knife Cursor Overlay</title>
  </head>
  <body>
    <div id="cursor-proxy" aria-hidden="true">
      <img
        id="knife-image"
        class="knife-visual"
        alt=""
        draggable="false"
      />
    </div>
    <script type="module" src="/src/renderer.ts"></script>
  </body>
</html>
```

## `settings.html`

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'self' file:; script-src 'self' file:; style-src 'self' 'unsafe-inline' file:; img-src 'self' data: file: knife-asset:; font-src 'self' data: file:; connect-src 'self' ws://localhost:* ws://127.0.0.1:* http://localhost:* http://127.0.0.1:*; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'"
    />
    <title>Knife Cursor 设置</title>
  </head>
  <body>
    <main class="settings-card">
      <header class="settings-header">
        <p class="eyebrow">KNIFE CURSOR</p>
        <h1>设置</h1>
        <p class="subtitle">拖动滑块立即生效，并自动保存到 config.json。</p>
      </header>

      <section class="setting">
        <div class="setting-head">
          <label for="duration">动画时长</label>
          <output id="duration-value" for="duration">500 ms</output>
        </div>
        <input
          id="duration"
          type="range"
          min="300"
          max="2000"
          step="100"
          value="500"
        />
        <div class="range-hint" id="duration-hint">
          <span>300 ms</span>
          <span>2000 ms</span>
        </div>
      </section>

      <section class="setting">
        <div class="setting-head">
          <label for="size">光标大小</label>
          <output id="size-value" for="size">96 px</output>
        </div>
        <input
          id="size"
          type="range"
          min="32"
          max="256"
          step="8"
          value="96"
        />
        <div class="range-hint" id="size-hint">
          <span>32 px</span>
          <span>256 px</span>
        </div>
      </section>

      <section class="setting">
        <div class="setting-head">
          <label for="smoothing">光标跟随松紧度</label>
          <output id="smoothing-value" for="smoothing">45</output>
        </div>
        <input
          id="smoothing"
          type="range"
          min="0"
          max="100"
          step="1"
          value="45"
        />
        <div class="range-hint" id="smoothing-hint">
          <span>0 · 硬绑定 / 零延迟</span>
          <span>100 · 强拖影</span>
        </div>
      </section>

      <section class="setting">
        <div class="setting-head">
          <label for="offset-x">X 轴偏移</label>
          <output id="offset-x-value" for="offset-x">0 px</output>
        </div>
        <input
          id="offset-x"
          type="range"
          min="-150"
          max="150"
          step="1"
          value="0"
        />
        <div class="range-hint" id="offset-x-hint">
          <span>-150 px</span>
          <span>150 px</span>
        </div>
      </section>

      <section class="setting">
        <div class="setting-head">
          <label for="offset-y">Y 轴偏移</label>
          <output id="offset-y-value" for="offset-y">0 px</output>
        </div>
        <input
          id="offset-y"
          type="range"
          min="-150"
          max="150"
          step="1"
          value="0"
        />
        <div class="range-hint" id="offset-y-hint">
          <span>-150 px</span>
          <span>150 px</span>
        </div>
      </section>

      <section class="setting cursor-toggle">
        <div class="toggle-row">
          <label class="toggle-label" for="hide-system-cursor">
            隐藏 Windows 系统光标
          </label>
          <input
            id="hide-system-cursor"
            type="checkbox"
            class="toggle-input"
            checked
          />
        </div>
        <p class="toggle-hint">
          关闭此项即可找回 Windows 原生鼠标，立即生效，不需要关闭设置窗口。开启后蝴蝶刀会替代系统箭头；设置窗口内也能看到它，仍可正常操作。
        </p>
      </section>

      <section class="setting skin-section">
        <div class="setting-head">
          <span class="setting-title">素材来源</span>
          <span id="skin-kind" class="skin-badge">内置</span>
        </div>
        <p id="skin-current" class="skin-current" role="status" aria-live="polite">
          当前素材：内置素材
        </p>
        <div class="skin-actions">
          <button id="choose-skin" type="button">选择自定义素材文件夹</button>
          <button id="reset-skin" type="button" class="button-secondary">
            恢复默认内置素材
          </button>
        </div>
        <p class="toggle-hint">
          文件夹内需包含 frame_000.png、frame_001.png … 序列帧；可选 idle.png 作为静止帧。选择后立即换皮，无需重启。
        </p>
      </section>

      <div class="offset-actions">
        <button id="reset-offsets" type="button" class="button-secondary">
          恢复默认位置
        </button>
        <span class="offset-note">把刀尖/刀身对齐到你真正点击的位置</span>
      </div>

      <p id="status" class="status" role="status" aria-live="polite">
        正在读取配置…
      </p>

      <footer class="settings-footer">
        <button id="close" type="button">关闭</button>
      </footer>
    </main>

    <script type="module" src="/src/settings.ts"></script>
  </body>
</html>
```

## `src/global.d.ts`

```ts
import type { KnifeCursorApi, SettingsApi } from './shared/ipc';

declare global {
  interface Window {
    knifeCursor?: KnifeCursorApi;
    knifeSettings?: SettingsApi;
  }
}

export {};
```

## `src/shared/ipc.ts`

```ts
export const IPC_CHANNELS = {
  cursorUpdate: 'overlay:cursor-update',
  inspectionStart: 'inspection:start',
  inspectionFinished: 'inspection:finished',
  inspectionReset: 'inspection:reset',
  displaySettings: 'overlay:display-settings',
  skinChanged: 'overlay:skin-changed',
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  skinGet: 'settings:skin-get',
  skinChoose: 'settings:skin-choose',
  skinReset: 'settings:skin-reset',
} as const;

/** Passed through webPreferences.additionalArguments to distinguish the two preloads. */
export const SETTINGS_WINDOW_ARG = '--knife-settings-window';

export const DEFAULT_INSPECTION_DURATION_MS = 500;
export const MIN_INSPECTION_DURATION_MS = 300;
export const MAX_INSPECTION_DURATION_MS = 2000;
export const INSPECTION_DURATION_STEP_MS = 100;

export const DEFAULT_KNIFE_DISPLAY_SIZE = 96;
export const MIN_KNIFE_DISPLAY_SIZE = 32;
export const MAX_KNIFE_DISPLAY_SIZE = 256;
export const KNIFE_DISPLAY_SIZE_STEP = 8;

export const DEFAULT_OFFSET = 0;
export const MIN_OFFSET = -150;
export const MAX_OFFSET = 150;
export const OFFSET_STEP = 1;

/**
 * 0 is a hard bind (no interpolation). Values above 0 are the smoothing time
 * constant in milliseconds, so the default 45 keeps the original feel.
 */
export const DEFAULT_SMOOTHING_LEVEL = 45;
export const MIN_SMOOTHING_LEVEL = 0;
export const MAX_SMOOTHING_LEVEL = 100;
export const SMOOTHING_LEVEL_STEP = 1;

export const DEFAULT_HIDE_SYSTEM_CURSOR = true;

export type RetriggerMode = 'ignore' | 'restart';

/** Runtime-tunable settings shared by the overlay and the settings window. */
export interface DisplaySettings {
  inspectionDurationMs: number;
  knifeDisplaySize: number;
  /** Horizontal artwork offset from the cursor anchor, in CSS pixels. */
  offsetX: number;
  /** Vertical artwork offset from the cursor anchor, in CSS pixels. */
  offsetY: number;
  /** 0 = hard bind; 1-100 = smoothing time constant in milliseconds. */
  smoothingLevel: number;
  /** Whether the PowerShell cursor helper should hide the Windows cursor. */
  hideSystemCursor: boolean;
}

/**
 * Custom artwork is served from the main process through the privileged
 * `knife-asset:` scheme. The renderer never receives a filesystem path as an
 * image URL, so CSP and `file://` restrictions stay intact.
 */
export interface SkinState {
  mode: 'builtin' | 'custom';
  /** Last path saved in config.json, even if it is currently invalid. */
  customPath: string | null;
  /** Number of custom frame_*.png files; 0 for built-in artwork. */
  frameCount: number;
  /** Custom idle image, or the first custom frame when idle.png is absent. */
  idleUrl: string | null;
  /** Ordered custom frame URLs, already versioned for cache busting. */
  frameUrls: string[];
  /** Set when a saved custom path could not be used and we fell back. */
  error: string | null;
}

export interface SkinSelectionResult {
  canceled: boolean;
  changed: boolean;
  error: string | null;
  skin: SkinState;
}

export interface CursorUpdate {
  /** Electron display id that this local coordinate belongs to. */
  displayId: number;
  /** Cursor x in the target window's CSS/DIP coordinate space. */
  x: number;
  /** Cursor y in the target window's CSS/DIP coordinate space. */
  y: number;
  visible: boolean;
}

export interface InspectionStart {
  /** Monotonically increasing id assigned by the main process. */
  instanceId: number;
  durationMs: number;
}

export interface InspectionFinished {
  instanceId: number;
  reason: 'animationend' | 'hidden';
}

export interface InspectionReset {
  /** New id so animationend events from older instances are discarded. */
  instanceId: number;
  reason: string;
}

export interface KnifeCursorApi {
  onCursorUpdate(callback: (update: CursorUpdate) => void): void;
  offCursorUpdate(): void;
  onInspectionStart(callback: (start: InspectionStart) => void): void;
  offInspectionStart(): void;
  onInspectionReset(callback: (reset: InspectionReset) => void): void;
  offInspectionReset(): void;
  onDisplaySettings(callback: (settings: DisplaySettings) => void): void;
  offDisplaySettings(): void;
  onSkinChanged(callback: (skin: SkinState) => void): void;
  offSkinChanged(): void;
  notifyInspectionFinished(finished: InspectionFinished): void;
}

/** Exposed only in the settings window, never in the click-through overlay. */
export interface SettingsApi {
  get(): Promise<DisplaySettings>;
  update(patch: Partial<DisplaySettings>): Promise<DisplaySettings>;
  getSkin(): Promise<SkinState>;
  chooseSkin(): Promise<SkinSelectionResult>;
  resetSkin(): Promise<SkinSelectionResult>;
}
```

## `src/main/config.ts`

```ts
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_HIDE_SYSTEM_CURSOR,
  DEFAULT_INSPECTION_DURATION_MS,
  DEFAULT_KNIFE_DISPLAY_SIZE,
  DEFAULT_OFFSET,
  DEFAULT_SMOOTHING_LEVEL,
  INSPECTION_DURATION_STEP_MS,
  KNIFE_DISPLAY_SIZE_STEP,
  MAX_INSPECTION_DURATION_MS,
  MAX_KNIFE_DISPLAY_SIZE,
  MAX_OFFSET,
  MAX_SMOOTHING_LEVEL,
  MIN_INSPECTION_DURATION_MS,
  MIN_KNIFE_DISPLAY_SIZE,
  MIN_OFFSET,
  MIN_SMOOTHING_LEVEL,
  OFFSET_STEP,
  SMOOTHING_LEVEL_STEP,
} from '../shared/ipc';
import type { DisplaySettings, RetriggerMode } from '../shared/ipc';

export interface AppConfig extends DisplaySettings {
  version: 1;
  retriggerMode: RetriggerMode;
  overlayEnabled: boolean;
  /** Absolute folder selected in Settings; null means built-in artwork. */
  customSkinPath: string | null;
}

export interface ConfigLoadResult {
  config: AppConfig;
  warning: string | null;
}

export const DEFAULT_CONFIG: AppConfig = {
  version: 1,
  retriggerMode: 'ignore',
  overlayEnabled: true,
  inspectionDurationMs: DEFAULT_INSPECTION_DURATION_MS,
  knifeDisplaySize: DEFAULT_KNIFE_DISPLAY_SIZE,
  offsetX: DEFAULT_OFFSET,
  offsetY: DEFAULT_OFFSET,
  smoothingLevel: DEFAULT_SMOOTHING_LEVEL,
  hideSystemCursor: DEFAULT_HIDE_SYSTEM_CURSOR,
  customSkinPath: null,
};

export function isRetriggerMode(value: unknown): value is RetriggerMode {
  return value === 'ignore' || value === 'restart';
}

function snapToStep(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  step: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  const clamped = Math.min(max, Math.max(min, value));
  const snapped = min + Math.round((clamped - min) / step) * step;
  return Math.min(max, Math.max(min, snapped));
}

export function normalizeInspectionDuration(value: unknown): number {
  return snapToStep(
    value,
    DEFAULT_INSPECTION_DURATION_MS,
    MIN_INSPECTION_DURATION_MS,
    MAX_INSPECTION_DURATION_MS,
    INSPECTION_DURATION_STEP_MS,
  );
}

export function normalizeKnifeDisplaySize(value: unknown): number {
  return snapToStep(
    value,
    DEFAULT_KNIFE_DISPLAY_SIZE,
    MIN_KNIFE_DISPLAY_SIZE,
    MAX_KNIFE_DISPLAY_SIZE,
    KNIFE_DISPLAY_SIZE_STEP,
  );
}

/** Hotspot offset in CSS pixels; clamped to the same range as the sliders. */
export function normalizeOffset(value: unknown): number {
  return snapToStep(
    value,
    DEFAULT_OFFSET,
    MIN_OFFSET,
    MAX_OFFSET,
    OFFSET_STEP,
  );
}

export function normalizeSmoothingLevel(value: unknown): number {
  return snapToStep(
    value,
    DEFAULT_SMOOTHING_LEVEL,
    MIN_SMOOTHING_LEVEL,
    MAX_SMOOTHING_LEVEL,
    SMOOTHING_LEVEL_STEP,
  );
}

function normalizeConfig(value: unknown): AppConfig {
  if (typeof value !== 'object' || value === null) {
    return { ...DEFAULT_CONFIG };
  }

  const record = value as Record<string, unknown>;

  return {
    version: 1,
    retriggerMode: isRetriggerMode(record.retriggerMode)
      ? record.retriggerMode
      : DEFAULT_CONFIG.retriggerMode,
    overlayEnabled:
      typeof record.overlayEnabled === 'boolean'
        ? record.overlayEnabled
        : DEFAULT_CONFIG.overlayEnabled,
    inspectionDurationMs: normalizeInspectionDuration(
      record.inspectionDurationMs,
    ),
    knifeDisplaySize: normalizeKnifeDisplaySize(record.knifeDisplaySize),
    offsetX: normalizeOffset(record.offsetX),
    offsetY: normalizeOffset(record.offsetY),
    smoothingLevel: normalizeSmoothingLevel(record.smoothingLevel),
    hideSystemCursor:
      typeof record.hideSystemCursor === 'boolean'
        ? record.hideSystemCursor
        : DEFAULT_CONFIG.hideSystemCursor,
    customSkinPath:
      typeof record.customSkinPath === 'string' &&
      record.customSkinPath.trim() !== ''
        ? record.customSkinPath
        : null,
  };
}

/**
 * Load config from the userData directory. A corrupt or partially written
 * config must never stop the overlay from starting, so parse errors fall back
 * to defaults and are surfaced to the caller for logging.
 */
export function loadConfig(configPath: string): ConfigLoadResult {
  try {
    if (!fs.existsSync(configPath)) {
      return { config: { ...DEFAULT_CONFIG }, warning: null };
    }

    const raw = fs.readFileSync(configPath, 'utf8');
    // Users may edit config.json in an editor that writes a UTF-8 BOM.
    // JSON.parse rejects the BOM, which must not reset every setting.
    const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ''));
    return { config: normalizeConfig(parsed), warning: null };
  } catch (error) {
    return {
      config: { ...DEFAULT_CONFIG },
      warning: `could not read ${configPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/** Write atomically so a crash cannot leave truncated JSON behind. */
export function saveConfig(configPath: string, config: AppConfig): void {
  const directory = path.dirname(configPath);
  const tempPath = `${configPath}.${process.pid}.tmp`;

  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, configPath);
}
```

## `src/main.ts`

```ts
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Keep this before every other import that can fail. A packaged app may die
// before Electron creates a window; the only useful evidence is a plain file
// next to the executable. If that directory is read-only (Program Files), also
// mirror to %TEMP% so the crash is never completely silent.
const CRASH_LOG_DIRECTORY =
  process.env.KNIFE_CURSOR_CRASH_DIR ?? path.dirname(process.execPath);
const CRASH_LOG_PATH = path.join(CRASH_LOG_DIRECTORY, 'crash.log');
const CRASH_FALLBACK_PATH = path.join(
  process.env.TEMP ?? process.env.TMP ?? process.cwd(),
  'knife-cursor-crash.log',
);

function logCrash(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}\n`;

  try {
    fs.appendFileSync(CRASH_LOG_PATH, line, 'utf8');
    return;
  } catch {
    // Fall through to the temp file.
  }

  try {
    fs.appendFileSync(CRASH_FALLBACK_PATH, line, 'utf8');
  } catch {
    // Logging must never be the reason the app fails.
  }
}

process.on('uncaughtException', (error: Error) => {
  logCrash(`Uncaught Exception: ${error.stack ?? error.message}`);
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  const detail =
    reason instanceof Error ? reason.stack ?? reason.message : String(reason);
  logCrash(`Unhandled Rejection: ${detail}`);
});

// This fires for a normal process.exit()/app.quit() as well. If it is absent
// after a silent exit, the main process died below JavaScript (native crash),
// which is exactly the distinction we need while diagnosing the packaged app.
process.on('exit', (code: number) => {
  logCrash(`Process exit code=${code}`);
});

logCrash(
  `App booting... electron=${process.versions.electron} ` +
    `execPath=${process.execPath} ` +
    `argv=${JSON.stringify(process.argv)} ` +
    `runAsNode=${process.env.ELECTRON_RUN_AS_NODE ?? '(unset)'}`,
);

import type {
  BrowserWindow as ElectronBrowserWindow,
  Display,
  Menu as ElectronMenu,
  NativeImage,
  Rectangle,
  Tray as ElectronTray,
} from 'electron';

// Require Electron only after the crash handlers and the first log line above
// have run. A top-level `import` would be hoisted by the bundler and would load
// Electron (and potentially fail) before crash.log exists.
const {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  net,
  powerMonitor,
  protocol,
  screen,
  Tray,
} = require('electron') as typeof import('electron');

// The custom-skin files live outside the app bundle. Expose them through a
// privileged scheme instead of file://: the renderer can request a normal image
// URL, while CSP keeps file:// and arbitrary network sources blocked.
const CUSTOM_SKIN_SCHEME = 'knife-asset';
protocol.registerSchemesAsPrivileged([
  {
    scheme: CUSTOM_SKIN_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);

// This is a 2-D transparent overlay; it has no need for the GPU process.
// On machines with a broken/blocked GPU, Chromium otherwise retries the GPU
// process until it aborts with "GPU process isn't usable. Goodbye." Disabling
// hardware acceleration also avoids Chromium's GPU cache, which is where the
// non-ASCII Windows profile path was failing. Both calls must happen before
// app.whenReady(); calling disableHardwareAcceleration() afterwards throws.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
console.log('[main] GPU disabled: hardware acceleration off, --disable-gpu set');

// Last-resort switch for locked-down Windows sessions where the Chromium
// renderer cannot start at all. It is opt-in because --no-sandbox weakens the
// renderer security boundary; normal desktops must not run with it.
const FORCE_NO_SANDBOX = process.env.KNIFE_CURSOR_NO_SANDBOX === '1';
if (FORCE_NO_SANDBOX) {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  console.warn('[main] no-sandbox fallback enabled by KNIFE_CURSOR_NO_SANDBOX=1');
  logCrash('No-sandbox fallback enabled by KNIFE_CURSOR_NO_SANDBOX=1');
}

// Diagnostic switches for isolating a native crash. They do not change the
// default behavior; they let the packaged app start without the hook or tray.
const DISABLE_HOOK_FOR_DIAGNOSTICS =
  process.env.KNIFE_CURSOR_DISABLE_HOOK === '1';
const DISABLE_TRAY_FOR_DIAGNOSTICS =
  process.env.KNIFE_CURSOR_DISABLE_TRAY === '1';

import os from 'node:os';
import {
  DEFAULT_CONFIG,
  isRetriggerMode,
  loadConfig,
  normalizeInspectionDuration,
  normalizeKnifeDisplaySize,
  normalizeOffset,
  normalizeSmoothingLevel,
  saveConfig,
} from './main/config';
import type { AppConfig } from './main/config';
import {
  IPC_CHANNELS,
  SETTINGS_WINDOW_ARG,
} from './shared/ipc';
import type {
  CursorUpdate,
  DisplaySettings,
  InspectionFinished,
  InspectionReset,
  InspectionStart,
  RetriggerMode,
  SkinSelectionResult,
  SkinState,
} from './shared/ipc';

const APP_NAME = 'Knife Cursor';
const APP_USER_MODEL_ID = 'com.knifecursor.overlay';
const OVERLAY_WINDOW_TITLE = 'Knife Cursor Overlay';
const CONFIG_FILENAME = 'config.json';
const CUSTOM_SKIN_FRAME_PATTERN = /^frame_(\d+)\.png$/i;
const CUSTOM_SKIN_IDLE_FILENAME = 'idle.png';
const CUSTOM_SKIN_HOST = 'skin';

// electron-builder and the dev launcher no longer inject Forge's globals.
// A plain env var is set by scripts/dev.js; production loads the Vite output.
const DEV_RENDERER_URL =
  !app.isPackaged && process.env.KNIFE_CURSOR_DEV_SERVER_URL
    ? process.env.KNIFE_CURSOR_DEV_SERVER_URL.replace(/\/+$/, '')
    : '';
const RENDERER_DIR = path.join(__dirname, '../renderer/main_window');

const CURSOR_POLL_INTERVAL_MS = 16;
const DISPLAY_SYNC_DEBOUNCE_MS = 150;
const MIN_RETRIGGER_INTERVAL_MS = 50;
const INSPECTION_SAFETY_MARGIN_MS = 700;
const CONFIG_SAVE_DEBOUNCE_MS = 250;

// uiohook's virtual-key code for F. The native hook is the primary trigger.
const F_KEYCODE = 33;

// These are intentionally global shortcuts so the app remains usable when the
// low-level hook cannot start, or when Explorer's notification area rejects
// the tray icon. Ctrl+Shift+Alt+F is used instead of plain F: registering bare
// F would swallow every F typed into every application.
const FALLBACK_TRIGGER_SHORTCUT = 'CommandOrControl+Shift+Alt+F';
const OVERLAY_TOGGLE_SHORTCUT = 'CommandOrControl+Alt+0';
const EMERGENCY_QUIT_SHORTCUT = 'CommandOrControl+Alt+Shift+Q';
const FORCE_CURSOR_RESTORE_SHORTCUT = 'CommandOrControl+Alt+Shift+R';

// Restore is asynchronous and retried. A single PowerShell invocation can fail
// while the session is tearing down; the user's cursor must not stay invisible
// because of one transient failure. Stop/restore sequences are serialized so a
// fast settings toggle cannot race an in-flight helper teardown.
const CURSOR_RESTORE_MAX_ATTEMPTS = 5;
const CURSOR_RESTORE_RETRY_DELAY_MS = 150;
const CURSOR_HELPER_START_TIMEOUT_MS = 8000;
const RETRIGGER_MODE_SHORTCUTS = [
  { accelerator: 'CommandOrControl+Alt+1', mode: 'ignore' },
  { accelerator: 'CommandOrControl+Alt+2', mode: 'restart' },
] as const satisfies ReadonlyArray<{
  accelerator: string;
  mode: RetriggerMode;
}>;

type UiohookModule = typeof import('uiohook-napi');
type HookKeyEvent = { keycode: number; rawcode?: number };

interface OverlayWindow {
  displayId: number;
  window: ElectronBrowserWindow;
  loaded: boolean;
}

interface ScreenPoint {
  x: number;
  y: number;
}

interface LoadedCustomSkin {
  directory: string;
  idleUrl: string;
  frameUrls: string[];
  frameCount: number;
}

interface CustomSkinInspection {
  ok: boolean;
  directory: string;
  frames: string[];
  idleFile: string | null;
  error: string | null;
}

const overlays = new Map<number, OverlayWindow>();

let displays: Display[] = [];
let cursorPoller: NodeJS.Timeout | null = null;
let displaySyncTimer: NodeJS.Timeout | null = null;
let tray: ElectronTray | null = null;
let trayMenu: ElectronMenu | null = null;
let settingsWindow: ElectronBrowserWindow | null = null;
let cursorHiderPid: number | null = null;
let cursorHiderActive = false;
let cursorHiderWatchdog: NodeJS.Timeout | null = null;
let cursorDesiredHidden = false;
let cursorStartPromise: Promise<void> | null = null;
let cursorRestorePromise: Promise<boolean> | null = null;
// Restore invocations are serialized. Two concurrent PowerShell restores can
// race on SetSystemCursor and leave a destroyed transparent handle installed.
let cursorRestoreChain: Promise<boolean> = Promise.resolve(true);
// Stop is serialized too: settings-open and a fast toggle-off used to run two
// restore/kill sequences concurrently, letting a stale helper win the race.
let cursorStopChain: Promise<void> = Promise.resolve();
let terminationSignalHandled = false;
let overlayVisible = true;
let lastCursorPoint: ScreenPoint | null = null;
let quitting = false;
let quitCleanupStarted = false;
let quitCleanupComplete = false;
let devToolsOpened = false;

let appConfig: AppConfig = { ...DEFAULT_CONFIG };
let activeCustomSkin: LoadedCustomSkin | null = null;
let customSkinError: string | null = null;
let customSkinRevision = 0;
let configFilePath = '';
let configSaveTimer: NodeJS.Timeout | null = null;
let pendingConfigSaveReason = '';
let keepAliveTimer: NodeJS.Timeout | null = null;

let fKeyDown = false;
let activeInspectionId = 0;
let inspectionSequence = 0;
let lastInspectionStartedAt = 0;
let inspectionSafetyTimer: NodeJS.Timeout | null = null;

let uiohookModule: UiohookModule | null = null;
let uiohookListenersAttached = false;
let uiohookStarted = false;
let uiohookError: string | null = null;
let uiohookErrorShown = false;

app.setName(APP_NAME);
installTerminationHandlers();

if (process.platform === 'win32') {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}

if (process.platform === 'linux') {
  // Transparent windows need this on several Linux compositors.
  app.commandLine.appendSwitch('enable-transparent-visuals');
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`;
  }

  return String(error);
}

function canWriteDirectory(directory: string): boolean {
  const probeFile = path.join(
    directory,
    `.knife-cursor-write-probe-${process.pid}-${Date.now()}`,
  );

  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(probeFile, 'probe', { encoding: 'utf8', flag: 'wx' });
    fs.unlinkSync(probeFile);
    return true;
  } catch {
    try {
      fs.unlinkSync(probeFile);
    } catch {
      // Best effort cleanup only.
    }
    return false;
  }
}

function cleanPathValue(value: string): string {
  return value.trim().replace(/^"(.*)"$/, '$1');
}

/**
 * Build a 1x1 fully transparent Windows cursor. The 32-bit DIB contains one
 * transparent XOR pixel plus a 4-byte AND mask. Keeping this as a tiny buffer
 * avoids shipping another binary asset and, more importantly, keeps the cursor
 * path writable (PowerShell cannot load a cursor from inside app.asar).
 */
function createBlankCursorBuffer(): Buffer {
  const buffer = Buffer.alloc(70);

  buffer.writeUInt16LE(0, 0); // reserved
  buffer.writeUInt16LE(2, 2); // resource type: cursor
  buffer.writeUInt16LE(1, 4); // one image
  buffer[6] = 1; // width
  buffer[7] = 1; // height
  buffer[8] = 0; // color count
  buffer[9] = 0; // reserved
  buffer.writeUInt16LE(0, 10); // hotspot x
  buffer.writeUInt16LE(0, 12); // hotspot y
  buffer.writeUInt32LE(48, 14); // image bytes: 40 + 4 XOR + 4 AND
  buffer.writeUInt32LE(22, 18); // image offset

  buffer.writeUInt32LE(40, 22); // BITMAPINFOHEADER size
  buffer.writeInt32LE(1, 26); // width
  buffer.writeInt32LE(2, 30); // height (XOR + AND)
  buffer.writeUInt16LE(1, 34); // planes
  buffer.writeUInt16LE(32, 36); // bits per pixel
  buffer.writeUInt32LE(0, 38); // BI_RGB
  buffer.writeUInt32LE(8, 42); // image size
  buffer.writeInt32LE(0, 46); // x pixels/meter
  buffer.writeInt32LE(0, 50); // y pixels/meter
  buffer.writeUInt32LE(0, 54); // colors used
  buffer.writeUInt32LE(0, 58); // important colors
  // XOR pixel is already zero; the AND mask all-ones makes it transparent.
  buffer.fill(0xff, 66, 70);

  return buffer;
}

interface CursorHiderFiles {
  directory: string;
  scriptPath: string;
  cursorPath: string;
  stopPath: string;
  logPath: string;
  stdoutPath: string;
  stderrPath: string;
  pidPath: string;
}

function ensureCursorHiderFiles(): CursorHiderFiles {
  const directory = path.join(app.getPath('userData'), 'cursor-helper');
  const scriptPath = path.join(directory, 'system-cursor.ps1');
  const cursorPath = path.join(directory, 'blank-cursor.cur');
  const stopPath = path.join(directory, 'restore.request');
  const logPath = path.join(directory, 'system-cursor.log');
  const stdoutPath = path.join(directory, 'helper.stdout.log');
  const stderrPath = path.join(directory, 'helper.stderr.log');
  const pidPath = path.join(directory, 'helper.pid');
  const sourcePath = path.join(
    app.getAppPath(),
    'assets',
    'system-cursor.ps1',
  );

  fs.mkdirSync(directory, { recursive: true });

  if (cursorHiderScriptNeedsCopy(sourcePath, scriptPath)) {
    fs.copyFileSync(sourcePath, scriptPath);
  }

  const scriptSize = fs.statSync(scriptPath).size;
  if (scriptSize === 0) {
    throw new Error(`Cursor helper script is empty: ${scriptPath}`);
  }

  fs.writeFileSync(cursorPath, createBlankCursorBuffer());

  return {
    directory,
    scriptPath,
    cursorPath,
    stopPath,
    logPath,
    stdoutPath,
    stderrPath,
    pidPath,
  };
}

function readTextFileTail(filePath: string, maxChars = 6000): string {
  try {
    const text = fs.readFileSync(filePath, 'utf8').trim();
    return text.length > maxChars ? text.slice(-maxChars) : text;
  } catch {
    return '';
  }
}

/**
 * Keep the exact paths in both the console and crash.log. Packaged builds use
 * %APPDATA%\Knife Cursor (contains a space), so a wrong copy path or a missing
 * asar asset must be visible without attaching a debugger.
 */
function logCursorHelperPaths(files: CursorHiderFiles, reason: string): void {
  const sourcePath = path.join(
    app.getAppPath(),
    'assets',
    'system-cursor.ps1',
  );
  let sourceBytes = -1;
  let scriptBytes = -1;
  try {
    sourceBytes = fs.statSync(sourcePath).size;
  } catch {
    // The diagnostic below deliberately records -1.
  }
  try {
    scriptBytes = fs.statSync(files.scriptPath).size;
  } catch {
    // The diagnostic below deliberately records -1.
  }

  const message =
    `[cursor] helper paths reason=${reason} ` +
    `appPath=${app.getAppPath()} source=${sourcePath} sourceBytes=${sourceBytes} ` +
    `script=${files.scriptPath} scriptBytes=${scriptBytes} ` +
    `userData=${app.getPath('userData')} temp=${files.directory}\\temp`;
  console.log(message);
  logCrash(message);
}

/**
 * Dump the helper's own log plus its redirected stdout/stderr. This is the
 * only way to see Add-Type, execution-policy or access-denied failures from a
 * detached PowerShell process in the packaged app.
 */
function logCursorHelperOutput(files: CursorHiderFiles, reason: string): void {
  const outputs: Array<[string, string]> = [
    ['helper.stderr', readTextFileTail(files.stderrPath)],
    ['helper.stdout', readTextFileTail(files.stdoutPath)],
    ['system-cursor.log', readTextFileTail(files.logPath)],
  ];

  for (const [label, text] of outputs) {
    if (text.length === 0) {
      continue;
    }
    const message = `System cursor ${label} (${reason}):\n${text}`;
    console.warn(message);
    logCrash(message);
  }
}

function cursorHiderScriptNeedsCopy(
  sourcePath: string,
  destinationPath: string,
): boolean {
  try {
    const sourceStat = fs.statSync(sourcePath);
    const destinationStat = fs.statSync(destinationPath);
    return (
      sourceStat.size !== destinationStat.size ||
      sourceStat.mtimeMs > destinationStat.mtimeMs
    );
  } catch {
    return true;
  }
}

function cursorHelperEnvironment(files: CursorHiderFiles): NodeJS.ProcessEnv {
  const tempDirectory = path.join(files.directory, 'temp');
  fs.mkdirSync(tempDirectory, { recursive: true });

  // app.getPath('temp') can itself be C:\Temp, which is not writable for a
  // normal user. Add-Type must create temporary compiler files, so point
  // PowerShell at a directory we know is writable.
  return {
    ...process.env,
    TEMP: tempDirectory,
    TMP: tempDirectory,
  };
}



function psSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function psDoubleQuoted(value: string): string {
  // Start-Process joins -ArgumentList with spaces. Every value must therefore
  // be quoted, and PowerShell metacharacters inside the double quotes escaped.
  return '"' + value.replace(/["`$]/g, (match) => '`' + match) + '"';
}

function readCursorHiderPid(files: CursorHiderFiles): number | null {
  try {
    const raw = fs.readFileSync(files.pidPath, 'utf8').trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/**
 * Run one PowerShell process without touching Electron's main thread.
 *
 * `spawnSync` is intentionally gone from the cursor path. A restore can take a
 * full second on Windows 11 (WM_SETCURSOR + pointer refresh), and blocking the
 * main thread there made the tray menu and settings window feel frozen.
 */
function runPowerShellAsync(
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  label = 'powershell',
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    const captureLimit = 32_000;

    const child = spawn('powershell.exe', args, {
      windowsHide: true,
      // Keep both streams. stdio:'ignore' hides Add-Type, execution-policy,
      // path and Access Denied errors from the packaged app.
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout = (stdout + chunk).slice(-captureLimit);
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-captureLimit);
    });

    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);

      if (stdout.trim().length > 0) {
        const message = `PowerShell [${label}] stdout:\n${stdout.trim()}`;
        console.log(message);
        logCrash(message);
      }
      if (stderr.trim().length > 0) {
        const message = `PowerShell [${label}] stderr:\n${stderr.trim()}`;
        console.warn(message);
        logCrash(message);
      }

      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    };

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // The process may already have exited.
      }
      finish(
        new Error(
          `PowerShell [${label}] timed out after ${timeoutMs}ms` +
            (stderr.trim() ? `; stderr: ${stderr.trim().slice(-2000)}` : ''),
        ),
      );
    }, timeoutMs);
    timer.unref();

    child.once('error', (error: Error) => {
      finish(error);
    });
    child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      if (code === 0) {
        finish();
        return;
      }
      finish(
        new Error(
          `PowerShell [${label}] exited with code=${String(code)} signal=${String(signal)}` +
            (stderr.trim() ? `; stderr: ${stderr.trim().slice(-2000)}` : ''),
        ),
      );
    });
  });
}

/** Kill exactly one helper process (and its children), never all PowerShell. */
function killCursorHelperProcess(pid: number, reason: string): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
      resolve();
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch {
      finish();
      return;
    }

    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // The process may already be gone.
      }
      finish();
    }, 2500);
    timer.unref();

    child.once('error', finish);
    child.once('exit', () => {
      if (isProcessAlive(pid)) {
        try {
          process.kill(pid);
        } catch {
          // Best effort; the restore below is the important part.
        }
      }
      console.log(`[cursor] helper killed reason=${reason} pid=${pid}`);
      logCrash(`System cursor helper killed: ${reason} pid=${pid}`);
      finish();
    });
  });
}

/**
 * If helper.pid was lost, find only processes whose command line contains our
 * copied system-cursor.ps1 path. This is the safe equivalent of the requested
 * `taskkill /IM powershell.exe`: it never kills the user's terminals or IDE.
 */
async function killOrphanCursorHelpers(
  files: CursorHiderFiles,
  reason: string,
): Promise<void> {
  const scriptPath = psSingleQuoted(files.scriptPath);
  const command = [
    "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like ('*' + " +
      scriptPath +
      " + '*') -and $_.CommandLine -notlike '*-RestoreOnly*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
  ].join('; ');

  try {
    await runPowerShellAsync(
      ['-NoProfile', '-NonInteractive', '-Command', command],
      cursorHelperEnvironment(files),
      4000,
      `orphan-scan:${reason}`,
    );
    console.log(`[cursor] orphan helper scan complete reason=${reason}`);
    logCrash(`System cursor orphan helper scan: ${reason}`);
  } catch (error) {
    console.warn('[cursor] orphan helper scan failed', error);
    logCrash(`System cursor orphan helper scan failed: ${describeError(error)}`);
  }
}

function stopCursorHiderWatchdog(): void {
  if (cursorHiderWatchdog !== null) {
    clearInterval(cursorHiderWatchdog);
    cursorHiderWatchdog = null;
  }
}

function startCursorHiderWatchdog(): void {
  if (cursorHiderWatchdog !== null || !cursorHiderActive) {
    return;
  }

  cursorHiderWatchdog = setInterval(() => {
    if (!cursorHiderActive || cursorHiderPid === null) {
      return;
    }

    if (isProcessAlive(cursorHiderPid)) {
      return;
    }

    const deadPid = cursorHiderPid;
    cursorHiderPid = null;
    cursorHiderActive = false;
    stopCursorHiderWatchdog();
    console.warn(`[cursor] helper pid=${deadPid} exited unexpectedly`);
    logCrash(`System cursor hider pid=${deadPid} exited unexpectedly`);
    try {
      const files = ensureCursorHiderFiles();
      logCursorHelperOutput(files, 'helper-process-exited');
    } catch (error) {
      logCrash(
        `Could not read cursor helper diagnostics: ${describeError(error)}`,
      );
    }
    void runCursorRestore('helper-process-exited', 3);
  }, 1000);
}

function runCursorRestore(
  reason: string,
  attempts = CURSOR_RESTORE_MAX_ATTEMPTS,
): Promise<boolean> {
  if (process.platform !== 'win32') {
    return Promise.resolve(true);
  }

  const task = cursorRestoreChain
    .catch(() => false)
    .then(() => runCursorRestoreNow(reason, attempts));
  cursorRestoreChain = task.catch(() => false);

  let tracked: Promise<boolean>;
  tracked = task.finally(() => {
    if (cursorRestorePromise === tracked) {
      cursorRestorePromise = null;
    }
  });
  cursorRestorePromise = tracked;
  return tracked;
}

async function runCursorRestoreNow(
  reason: string,
  attempts: number,
): Promise<boolean> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const files = ensureCursorHiderFiles();
      await runPowerShellAsync(
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-WindowStyle',
          'Hidden',
          '-File',
          files.scriptPath,
          '-RestoreOnly',
          '-LogPath',
          files.logPath,
        ],
        cursorHelperEnvironment(files),
        5000,
        `restore:${reason}:attempt-${attempt}`,
      );

      console.log(
        `[cursor] system cursor restored reason=${reason} attempt=${attempt}`,
      );
      logCrash(`System cursor restore: ${reason} attempt=${attempt}`);
      return true;
    } catch (error) {
      lastError = error;
      console.warn(
        `[cursor] restore attempt ${attempt}/${attempts} failed (${reason})`,
        error,
      );
      logCrash(
        `System cursor restore attempt ${attempt}/${attempts} failed ` +
          `(${reason}): ${describeError(error)}`,
      );
      if (attempt < attempts) {
        await delay(CURSOR_RESTORE_RETRY_DELAY_MS);
      }
    }
  }

  console.error(
    `[cursor] FAILED to restore system cursor after ${attempts} attempts (${reason})`,
    lastError,
  );
  logCrash(
    `System cursor restore FAILED after ${attempts} attempts (${reason}): ` +
      describeError(lastError),
  );
  return false;
}

function startSystemCursorHider(reason: string): Promise<void> {
  // Keep every caller (bootstrap, overlay toggle, settings close, tray close)
  // consistent with the persisted switch. The env override is an emergency
  // escape hatch for users who never want their cursor touched.
  if (
    process.platform !== 'win32' ||
    !appConfig.hideSystemCursor ||
    process.env.KNIFE_CURSOR_KEEP_SYSTEM_CURSOR === '1'
  ) {
    cursorDesiredHidden = false;
    return Promise.resolve();
  }

  cursorDesiredHidden = true;

  if (cursorStartPromise !== null) {
    return cursorStartPromise;
  }

  const task = startSystemCursorHiderNow(reason);
  let tracked: Promise<void>;
  tracked = task.finally(() => {
    if (cursorStartPromise === tracked) {
      cursorStartPromise = null;
    }
  });
  cursorStartPromise = tracked;
  return tracked;
}

async function startSystemCursorHiderNow(reason: string): Promise<void> {
  if (
    process.platform !== 'win32' ||
    !appConfig.hideSystemCursor ||
    process.env.KNIFE_CURSOR_KEEP_SYSTEM_CURSOR === '1' ||
    !overlayVisible ||
    !cursorDesiredHidden ||
    quitting
  ) {
    return;
  }

  // A tray menu can close before the previous restore has finished. Hide only
  // after the whole stop sequence is done, otherwise the arrow can reappear
  // over the overlay while the helper believes it is active.
  await cursorStopChain.catch(() => undefined);
  if (cursorRestorePromise !== null) {
    await cursorRestorePromise.catch(() => false);
  }

  if (
    !appConfig.hideSystemCursor ||
    process.env.KNIFE_CURSOR_KEEP_SYSTEM_CURSOR === '1' ||
    !overlayVisible ||
    !cursorDesiredHidden ||
    quitting
  ) {
    return;
  }

  if (
    cursorHiderActive &&
    cursorHiderPid !== null &&
    isProcessAlive(cursorHiderPid)
  ) {
    return;
  }

  let diagnosticFiles: CursorHiderFiles | null = null;

  try {
    const files = ensureCursorHiderFiles();
    diagnosticFiles = files;
    fs.rmSync(files.stdoutPath, { force: true });
    fs.rmSync(files.stderrPath, { force: true });
    fs.rmSync(files.logPath, { force: true });
    logCursorHelperPaths(files, reason);

    if (!fs.existsSync(files.scriptPath)) {
      throw new Error(`Cursor helper script missing: ${files.scriptPath}`);
    }

    // A helper left over from a previous run might still own the cursor.
    const stalePid = readCursorHiderPid(files);
    if (stalePid !== null && isProcessAlive(stalePid)) {
      try {
        fs.writeFileSync(files.stopPath, 'stop', 'utf8');
        process.kill(stalePid);
      } catch {
        // The stale helper will also self-terminate when its parent is gone.
      }
    }

    fs.rmSync(files.stopPath, { force: true });
    fs.rmSync(files.pidPath, { force: true });

    // Start-Process creates a separate, hidden PowerShell console. That
    // detachment is essential: closing the terminal kills the npm/Electron
    // console group, but must not kill the cursor guard before it restores.
    // A direct `detached: true` spawn makes PowerShell exit before the script
    // runs in this Electron build, so use this one-shot launcher instead.
    const helperArgs = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-WindowStyle',
      'Hidden',
      '-File',
      files.scriptPath,
      '-ParentPid',
      String(process.pid),
      '-CursorPath',
      files.cursorPath,
      '-StopPath',
      files.stopPath,
      '-LogPath',
      files.logPath,
    ];
    // Start-Process does not preserve embedded quotes when an array is passed to
    // -ArgumentList. A single pre-quoted string keeps "Knife Cursor" (the
    // packaged userData path has a space) as one -File argument.
    const quotedArgs = helperArgs.map(psDoubleQuoted).join(' ');
    const launcherCommand = [
      "$ErrorActionPreference = 'Stop'",
      '$helper = Start-Process -FilePath ' +
        "'powershell.exe' -WindowStyle Hidden -PassThru " +
        `-RedirectStandardOutput ${psSingleQuoted(files.stdoutPath)} ` +
        `-RedirectStandardError ${psSingleQuoted(files.stderrPath)} ` +
        `-ArgumentList ${psSingleQuoted(quotedArgs)}`,
      'if ($null -eq $helper) { exit 2 }',
      'Set-Content -LiteralPath ' +
        `${psSingleQuoted(files.pidPath)} -Value $helper.Id -Encoding ASCII`,
    ].join('; ');
    const encodedLauncher = Buffer.from(
      launcherCommand,
      'utf16le',
    ).toString('base64');

    await runPowerShellAsync(
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        encodedLauncher,
      ],
      cursorHelperEnvironment(files),
      5000,
      `start-helper-launcher:${reason}`,
    );

    if (!cursorDesiredHidden || quitting) {
      fs.writeFileSync(files.stopPath, 'stop', 'utf8');
      return;
    }

    const deadline = Date.now() + CURSOR_HELPER_START_TIMEOUT_MS;
    let helperPid: number | null = null;

    while (Date.now() < deadline) {
      helperPid = readCursorHiderPid(files);
      if (helperPid !== null && isProcessAlive(helperPid)) {
        break;
      }
      helperPid = null;
      await delay(50);
      if (!cursorDesiredHidden || quitting) {
        fs.writeFileSync(files.stopPath, 'stop', 'utf8');
        return;
      }
    }

    if (helperPid === null) {
      throw new Error('Cursor helper did not publish a live pid');
    }

    if (!cursorDesiredHidden || quitting) {
      try {
        fs.writeFileSync(files.stopPath, 'stop', 'utf8');
      } catch {
        // The helper will also exit when its parent disappears.
      }
      return;
    }

    cursorHiderPid = helperPid;
    cursorHiderActive = true;
    startCursorHiderWatchdog();

    console.log(
      `[cursor] system cursor hider started reason=${reason} pid=${helperPid}`,
    );
    logCrash(`System cursor hider started: ${reason} pid=${helperPid}`);
  } catch (error) {
    cursorHiderPid = null;
    cursorHiderActive = false;
    stopCursorHiderWatchdog();

    // A slow Start-Process may publish its pid just after our timeout. Ask any
    // such late helper to stop, then restore so we cannot leave the cursor
    // hidden while the watchdog believes nothing is running.
    try {
      const files = ensureCursorHiderFiles();
      fs.writeFileSync(files.stopPath, 'stop', 'utf8');
    } catch {
      // Best effort; the restore attempt below is the important part.
    }
    await runCursorRestore('helper-start-failed', 3);

    console.warn('[cursor] failed to hide system cursor', error);
    logCrash(`System cursor hide failed (${reason}): ${describeError(error)}`);
    if (diagnosticFiles !== null) {
      logCursorHelperOutput(diagnosticFiles, 'helper-start-failed');
    }
  }
}

function stopSystemCursorHider(reason: string): Promise<void> {
  cursorDesiredHidden = false;
  // Do not let a start that is still waiting on the restore cache block a new
  // "hide" toggle. Its checks will see cursorDesiredHidden=false and abort.
  cursorStartPromise = null;

  const task = cursorStopChain
    .catch(() => undefined)
    .then(() => stopSystemCursorHiderNow(reason));
  cursorStopChain = task.catch(() => undefined);
  return task;
}

async function stopSystemCursorHiderNow(reason: string): Promise<void> {
  if (process.platform !== 'win32') {
    return;
  }

  let files: CursorHiderFiles | null = null;
  let helperPid = cursorHiderPid;

  try {
    files = ensureCursorHiderFiles();
    helperPid = helperPid ?? readCursorHiderPid(files);
    fs.writeFileSync(files.stopPath, 'stop', 'utf8');
  } catch (error) {
    console.warn('[cursor] failed to write stop request', error);
  }

  const wasActive = cursorHiderActive;
  const helperWasAlive =
    helperPid !== null ? isProcessAlive(helperPid) : false;
  console.log(
    `[cursor] stop requested reason=${reason} active=${String(wasActive)} ` +
      `pid=${String(helperPid ?? 'none')} alive=${String(helperWasAlive)}`,
  );

  cursorHiderActive = false;
  cursorHiderPid = null;
  stopCursorHiderWatchdog();

  // Kill the owner before restoring. If the helper is hung in SetSystemCursor,
  // a restore that races it can finish first and the helper can then put the
  // blank handle back. taskkill is scoped to the helper PID/tree; never use
  // `/IM powershell.exe`, which would also kill the user's terminals and IDE.
  if (helperPid !== null && isProcessAlive(helperPid)) {
    await killCursorHelperProcess(helperPid, reason);
  } else if (files !== null) {
    // helper.pid can be lost after a crash. Remove only processes running our
    // exact copied script, not every PowerShell process.
    await killOrphanCursorHelpers(files, reason);
  }

  // Always restore. Do not skip this when our in-memory state says "inactive":
  // a helper from a previous force-restore or a lost PID must still be cleaned
  // up, and Windows 11 needs the active SetSystemCursor restore, not just an
  // SPI_SETCURSORS no-op. This is also the path used by Ctrl+Alt+0.
  const restored = await runCursorRestore(
    reason,
    CURSOR_RESTORE_MAX_ATTEMPTS,
  );

  if (!restored) {
    logCrash(
      `System cursor restore still failed after killing helper (${reason})`,
    );
  }

  // A taskkill timeout can leave the helper alive. Do one final precise kill
  // after the restore; this must not depend on restore success.
  if (helperPid !== null && isProcessAlive(helperPid)) {
    await killCursorHelperProcess(helperPid, `${reason}-post-restore`);
  }
}

function forceRestoreSystemCursor(): void {
  console.log('[cursor] force restore requested');
  logCrash('Force system cursor restore requested');
  // stop() always runs the active Windows 11 restore path now, even when the
  // in-memory PID is already gone. Do not run a second 1-second restore here.
  void stopSystemCursorHider('force-restore-shortcut');
}

function installTerminationHandlers(): void {
  const handleSignal = (signal: NodeJS.Signals): void => {
    if (terminationSignalHandled) {
      return;
    }

    terminationSignalHandled = true;
    console.warn(`[main] received ${signal}; restoring system cursor`);
    logCrash(`Received ${signal}; restoring system cursor before exit`);

    let exited = false;
    const exitNow = (): void => {
      if (exited) {
        return;
      }
      exited = true;
      try {
        app.exit(0);
      } catch {
        process.exit(0);
      }
    };

    // Closing a terminal can kill the console group at any moment. Keep the
    // fallback timer short; the detached helper also restores by itself when
    // the parent disappears.
    const fallback = setTimeout(exitNow, 2500);

    void stopSystemCursorHider(`signal-${signal}`)
      .then(() =>
        runCursorRestore(
          `signal-${signal}-final`,
          CURSOR_RESTORE_MAX_ATTEMPTS,
        ),
      )
      .catch((error: unknown) => {
        console.warn('[cursor] signal restore failed', error);
      })
      .finally(() => {
        clearTimeout(fallback);
        exitNow();
      });
  };

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    try {
      process.on(signal, () => handleSignal(signal));
    } catch (error) {
      console.warn(`[main] could not register ${signal} handler`, error);
    }
  }
}

function showTrayMenu(): void {
  if (tray === null || trayMenu === null) {
    return;
  }

  // The native menu needs a visible pointer. Start the restore but do not wait:
  // the native popup must appear immediately. menu-will-close starts the hider
  // again, and startSystemCursorHider() waits for this restore first.
  void stopSystemCursorHider('tray-menu-open');

  try {
    tray.popUpContextMenu(trayMenu);
  } catch (error) {
    console.warn('[tray] popUpContextMenu failed', error);
    void startSystemCursorHider('tray-menu-failed');
  }
}

/**
 * Chromium writes its singleton lock and GPU cache inside userData before any
 * window exists. If that directory is not writable, Electron exits silently.
 * Choose a writable directory before requestSingleInstanceLock().
 */
function resolveUserDataDirectory(): string {
  const explicitPath =
    process.env.KNIFE_CURSOR_USER_DATA ??
    app.commandLine.getSwitchValue('user-data-dir');

  if (explicitPath.trim() !== '') {
    const resolved = path.resolve(cleanPathValue(explicitPath));
    if (canWriteDirectory(resolved)) {
      return resolved;
    }

    console.warn(`[main] userData is not writable: ${resolved}; falling back`);
  }

  const appData =
    process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  const localAppData =
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');

  const candidates = [
    path.join(appData, APP_NAME),
    path.join(localAppData, APP_NAME),
    path.join(path.dirname(process.execPath), 'KnifeCursorData'),
    path.join(os.homedir(), '.knife-cursor'),
    path.join(os.tmpdir(), APP_NAME),
  ];

  for (const candidate of new Set(candidates)) {
    if (canWriteDirectory(candidate)) {
      return candidate;
    }
  }

  return path.join(os.tmpdir(), APP_NAME);
}

const userDataDirectory = resolveUserDataDirectory();

try {
  app.setPath('userData', userDataDirectory);
  console.log(`[main] userData=${userDataDirectory}`);
  logCrash(`User data resolved: ${userDataDirectory}`);
} catch (error) {
  console.error('[main] could not set userData path', error);
  logCrash(`Could not set user data path: ${describeError(error)}`);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
logCrash(`Single instance lock=${String(hasSingleInstanceLock)}`);

if (!hasSingleInstanceLock) {
  console.error('[main] another instance is already running; exiting');
  logCrash('Another instance is already running; exiting');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!app.isReady()) {
      return;
    }

    if (!overlayVisible) {
      setOverlayEnabled(true);
      return;
    }

    showAllOverlays();
  });

  app.whenReady()
    .then(() => {
      logCrash('Electron app ready');
      bootstrap();
      logCrash('Bootstrap complete; app should now stay resident');
    })
    .catch((error: unknown) => {
      console.error('[main] failed to start', error);
      logCrash(`Failed to start: ${describeError(error)}`);
      dialog.showErrorBox(
        'Knife Cursor 启动失败',
        describeError(error),
      );
      app.quit();
    });

  app.on('before-quit', (event) => {
    logCrash('Event before-quit');

    if (quitCleanupComplete) {
      return;
    }

    // Cursor restore is asynchronous so it never freezes the UI. Delay the
    // actual quit until it finishes; otherwise app.quit() would tear down the
    // process while PowerShell is still restoring the arrow.
    event.preventDefault();
    if (quitCleanupStarted) {
      return;
    }

    quitCleanupStarted = true;
    void teardown()
      .catch((error: unknown) => {
        console.error('[main] teardown failed', error);
        logCrash(`Teardown failed: ${describeError(error)}`);
      })
      .finally(() => {
        quitCleanupComplete = true;
        app.quit();
      });
  });

  app.on('will-quit', () => {
    logCrash('Event will-quit');
  });

  app.on('quit', (_event, exitCode: number) => {
    logCrash(`Event quit exitCode=${exitCode}`);
  });

  app.on('window-all-closed', () => {
    // Deliberately do not call app.quit(). This utility is tray/hook resident;
    // even if every overlay disappears, the main process must remain alive so
    // the fallback shortcut can recreate the windows.
    logCrash('Event window-all-closed; keeping main process alive');
    startKeepAliveTimer();
  });

  app.on('child-process-gone', (_event, details) => {
    logCrash(
      `Event child-process-gone type=${details.type} ` +
        `reason=${details.reason} exitCode=${details.exitCode} ` +
        `service=${details.serviceName ?? '(none)'}`,
    );
  });
}

function bootstrap(): void {
  logCrash('Bootstrap begin');
  Menu.setApplicationMenu(null);

  loadAppConfig();
  registerCustomSkinProtocol();
  loadCustomSkinFromConfig();
  registerIpcHandlers();
  registerPowerEvents();
  registerShortcuts();
  logCrash('Bootstrap: config/IPC/power/shortcuts registered');

  logCrash('Bootstrap: creating tray');
  createTray();
  logCrash('Bootstrap: tray phase done');

  logCrash('Bootstrap: creating overlay windows');
  syncOverlays();
  logCrash('Bootstrap: overlay phase done');

  // Clear a blank cursor left behind by a previous hard kill, then hide the
  // real Windows cursors for as long as the overlay is active. The helper
  // restores the user's scheme when this process exits or is paused.
  void runCursorRestore('startup-guard');
  void startSystemCursorHider('bootstrap');

  logCrash('Bootstrap: starting keyboard hook');
  startKeyboardHook();
  logCrash('Bootstrap: keyboard hook phase done');

  startCursorLoop();
  startKeepAliveTimer();
  logCrash('Bootstrap: cursor loop and keepalive armed');

  screen.on('display-added', scheduleDisplaySync);
  screen.on('display-removed', scheduleDisplaySync);
  screen.on('display-metrics-changed', scheduleDisplaySync);

  app.on('activate', () => {
    logCrash('Event activate');
    if (!overlayVisible) {
      setOverlayEnabled(true);
      return;
    }

    showAllOverlays();
  });

  console.log(
    `[main] ready electron=${process.versions.electron} ` +
      `userData=${app.getPath('userData')} packaged=${app.isPackaged} ` +
      `temp=${app.getPath('temp')} envTEMP=${process.env.TEMP ?? '<unset>'} ` +
      `envTMP=${process.env.TMP ?? '<unset>'}`,
  );

  // Development-only smoke-test hook: the tray is unavailable in some remote
  // Windows sessions, so allow opening the settings window directly.
  if (!app.isPackaged && process.env.KNIFE_CURSOR_OPEN_SETTINGS === '1') {
    openSettingsWindow();
  }
}

function startKeepAliveTimer(): void {
  if (keepAliveTimer !== null || quitting) {
    return;
  }

  // A live timer is the last line of defence against an accidental
  // window-all-closed exit. The interval is deliberately empty: it only keeps
  // the main process' event loop alive, and costs effectively nothing.
  keepAliveTimer = setInterval(() => {
    if (quitting) {
      return;
    }
  }, 30_000);

  logCrash('Main-process keepalive timer armed (30s)');
}

function stopKeepAliveTimer(): void {
  if (keepAliveTimer === null) {
    return;
  }

  clearInterval(keepAliveTimer);
  keepAliveTimer = null;
}

function loadAppConfig(): void {
  configFilePath = path.join(app.getPath('userData'), CONFIG_FILENAME);
  const result = loadConfig(configFilePath);
  appConfig = result.config;
  overlayVisible = appConfig.overlayEnabled;

  if (result.warning !== null) {
    console.warn(`[config] ${result.warning}; using defaults`);
  }

  console.log(
    `[config] path=${configFilePath} retriggerMode=${appConfig.retriggerMode} ` +
      `overlayEnabled=${appConfig.overlayEnabled} ` +
      `duration=${appConfig.inspectionDurationMs}ms ` +
      `size=${appConfig.knifeDisplaySize}px`,
  );
}

function persistAppConfig(reason: string): void {
  if (configSaveTimer !== null) {
    clearTimeout(configSaveTimer);
    configSaveTimer = null;
  }
  pendingConfigSaveReason = '';

  try {
    saveConfig(configFilePath, appConfig);
    console.log(
      `[config] saved reason=${reason} retriggerMode=${appConfig.retriggerMode} ` +
        `overlayEnabled=${appConfig.overlayEnabled} ` +
        `duration=${appConfig.inspectionDurationMs}ms ` +
        `size=${appConfig.knifeDisplaySize}px`,
    );
  } catch (error) {
    console.error('[config] save failed', error);
  }

  refreshTrayMenu();
}

/**
 * Slider input can fire dozens of times per second. Apply each change in
 * memory immediately, but coalesce disk writes so dragging does not hammer
 * the config file.
 */
function schedulePersistAppConfig(reason: string): void {
  pendingConfigSaveReason = reason;

  if (configSaveTimer !== null) {
    return;
  }

  configSaveTimer = setTimeout(() => {
    configSaveTimer = null;
    persistAppConfig(pendingConfigSaveReason || 'display-settings');
  }, CONFIG_SAVE_DEBOUNCE_MS);
}

function flushPendingConfigSave(): void {
  if (configSaveTimer === null) {
    return;
  }

  persistAppConfig(pendingConfigSaveReason || 'quit');
}

function setRetriggerMode(mode: RetriggerMode): void {
  if (!isRetriggerMode(mode) || appConfig.retriggerMode === mode) {
    refreshTrayMenu();
    return;
  }

  appConfig = { ...appConfig, retriggerMode: mode };
  console.log(`[inspect] retriggerMode=${mode}`);
  persistAppConfig(`retriggerMode=${mode}`);
}

function isInspectionFinished(value: unknown): value is InspectionFinished {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    Number.isInteger(record.instanceId) &&
    (record.instanceId as number) > 0 &&
    (record.reason === 'animationend' || record.reason === 'hidden')
  );
}

function currentDisplaySettings(): DisplaySettings {
  return {
    inspectionDurationMs: appConfig.inspectionDurationMs,
    knifeDisplaySize: appConfig.knifeDisplaySize,
    offsetX: appConfig.offsetX,
    offsetY: appConfig.offsetY,
    smoothingLevel: appConfig.smoothingLevel,
    hideSystemCursor: appConfig.hideSystemCursor,
  };
}

function isSettingsSender(senderId: number): boolean {
  return (
    settingsWindow !== null &&
    !settingsWindow.isDestroyed() &&
    settingsWindow.webContents.id === senderId
  );
}

function sendDisplaySettingsToOverlays(): void {
  const settings = currentDisplaySettings();

  for (const overlay of overlays.values()) {
    if (overlay.window.isDestroyed() || !overlay.loaded) {
      continue;
    }

    overlay.window.webContents.send(IPC_CHANNELS.displaySettings, settings);
  }
}

function isSafeCustomSkinFileName(fileName: string): boolean {
  return (
    fileName.toLowerCase() === CUSTOM_SKIN_IDLE_FILENAME ||
    CUSTOM_SKIN_FRAME_PATTERN.test(fileName)
  );
}

function frameNumber(fileName: string): number {
  const match = CUSTOM_SKIN_FRAME_PATTERN.exec(fileName);
  return match === null ? Number.MAX_SAFE_INTEGER : Number.parseInt(match[1], 10);
}

function customSkinUrl(fileName: string): string {
  return (
    `${CUSTOM_SKIN_SCHEME}://${CUSTOM_SKIN_HOST}/` +
    `${encodeURIComponent(fileName)}?v=${customSkinRevision}`
  );
}

function sameDirectory(a: string, b: string): boolean {
  const normalize = (value: string): string =>
    process.platform === 'win32' ? value.toLowerCase() : value;
  return normalize(path.resolve(a)) === normalize(path.resolve(b));
}

function inspectCustomSkinDirectory(directory: string): CustomSkinInspection {
  const resolved = path.resolve(directory);

  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      return {
        ok: false,
        directory: resolved,
        frames: [],
        idleFile: null,
        error: '所选路径不是文件夹',
      };
    }

    const entries = fs
      .readdirSync(resolved, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() && CUSTOM_SKIN_FRAME_PATTERN.test(entry.name),
      )
      .map((entry) => entry.name)
      .sort((a, b) => {
        const delta = frameNumber(a) - frameNumber(b);
        return delta !== 0 ? delta : a.localeCompare(b);
      });

    if (entries.length === 0) {
      return {
        ok: false,
        directory: resolved,
        frames: [],
        idleFile: null,
        error: '未找到有效的 frame_*.png 序列帧',
      };
    }

    const idleEntry = fs
      .readdirSync(resolved, { withFileTypes: true })
      .find(
        (entry) =>
          entry.isFile() &&
          entry.name.toLowerCase() === CUSTOM_SKIN_IDLE_FILENAME,
      );

    return {
      ok: true,
      directory: resolved,
      frames: entries,
      idleFile: idleEntry?.name ?? null,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      directory: resolved,
      frames: [],
      idleFile: null,
      error: `无法读取文件夹：${describeError(error)}`,
    };
  }
}

function currentSkinState(): SkinState {
  if (activeCustomSkin !== null) {
    return {
      mode: 'custom',
      customPath: appConfig.customSkinPath,
      frameCount: activeCustomSkin.frameCount,
      idleUrl: activeCustomSkin.idleUrl,
      frameUrls: [...activeCustomSkin.frameUrls],
      error: null,
    };
  }

  return {
    mode: 'builtin',
    customPath: appConfig.customSkinPath,
    frameCount: 0,
    idleUrl: null,
    frameUrls: [],
    error: customSkinError,
  };
}

function sendSkinToOverlays(): void {
  const skin = currentSkinState();

  for (const overlay of overlays.values()) {
    if (overlay.window.isDestroyed() || !overlay.loaded) {
      continue;
    }

    overlay.window.webContents.send(IPC_CHANNELS.skinChanged, skin);
  }
}

function loadCustomSkinFromConfig(): void {
  activeCustomSkin = null;
  customSkinError = null;
  customSkinRevision += 1;

  const configuredPath = appConfig.customSkinPath;
  if (configuredPath === null) {
    console.log('[skin] using built-in artwork');
    return;
  }

  const inspection = inspectCustomSkinDirectory(configuredPath);
  if (!inspection.ok || inspection.error !== null) {
    customSkinError =
      inspection.error ?? '自定义素材不可用，已回退内置素材';
    console.warn(
      `[skin] custom folder rejected path=${configuredPath}: ${customSkinError}`,
    );
    return;
  }

  const idleFile = inspection.idleFile ?? inspection.frames[0];
  activeCustomSkin = {
    directory: inspection.directory,
    idleUrl: customSkinUrl(idleFile),
    frameUrls: inspection.frames.map((fileName) => customSkinUrl(fileName)),
    frameCount: inspection.frames.length,
  };

  console.log(
    `[skin] custom artwork loaded path=${inspection.directory} ` +
      `frames=${inspection.frames.length} idle=${idleFile}`,
  );
}

let skinProtocolRegistered = false;

function registerCustomSkinProtocol(): void {
  if (skinProtocolRegistered) {
    return;
  }
  skinProtocolRegistered = true;

  protocol.handle(CUSTOM_SKIN_SCHEME, async (request) => {
    try {
      const parsed = new URL(request.url);
      if (parsed.hostname !== CUSTOM_SKIN_HOST) {
        return new Response('Not found', { status: 404 });
      }

      const fileName = decodeURIComponent(
        parsed.pathname.replace(/^\/+/, ''),
      );
      const skin = activeCustomSkin;

      if (
        skin === null ||
        !isSafeCustomSkinFileName(fileName) ||
        !sameDirectory(path.dirname(path.join(skin.directory, fileName)), skin.directory)
      ) {
        return new Response('Not found', { status: 404 });
      }

      const filePath = path.join(skin.directory, fileName);
      if (!fs.existsSync(filePath)) {
        return new Response('Not found', { status: 404 });
      }

      return await net.fetch(pathToFileURL(filePath).toString());
    } catch (error) {
      logCrash(`Custom skin protocol failed: ${describeError(error)}`);
      return new Response('Asset error', { status: 500 });
    }
  });
}

function setCustomSkin(directory: string | null): SkinSelectionResult {
  const previousPath = appConfig.customSkinPath;
  const previousMode = activeCustomSkin === null ? 'builtin' : 'custom';

  if (directory === null) {
    appConfig = { ...appConfig, customSkinPath: null };
    activeCustomSkin = null;
    customSkinError = null;
    customSkinRevision += 1;
  } else {
    const inspection = inspectCustomSkinDirectory(directory);
    if (!inspection.ok || inspection.error !== null) {
      return {
        canceled: false,
        changed: false,
        error: inspection.error ?? '未找到有效的 frame_*.png 序列帧',
        skin: currentSkinState(),
      };
    }

    appConfig = { ...appConfig, customSkinPath: inspection.directory };
    activeCustomSkin = null;
    customSkinError = null;
    customSkinRevision += 1;

    const idleFile = inspection.idleFile ?? inspection.frames[0];
    activeCustomSkin = {
      directory: inspection.directory,
      idleUrl: customSkinUrl(idleFile),
      frameUrls: inspection.frames.map((fileName) => customSkinUrl(fileName)),
      frameCount: inspection.frames.length,
    };
  }

  const changed =
    previousPath !== appConfig.customSkinPath ||
    previousMode !== (activeCustomSkin === null ? 'builtin' : 'custom');

  persistAppConfig('custom-skin');
  sendSkinToOverlays();

  console.log(
    `[skin] changed mode=${activeCustomSkin === null ? 'builtin' : 'custom'} ` +
      `path=${appConfig.customSkinPath ?? '(none)'} changed=${changed}`,
  );

  return {
    canceled: false,
    changed,
    error: null,
    skin: currentSkinState(),
  };
}

async function chooseCustomSkin(): Promise<SkinSelectionResult> {
  const owner = settingsWindow;
  if (owner === null || owner.isDestroyed()) {
    return {
      canceled: true,
      changed: false,
      error: '设置窗口不可用',
      skin: currentSkinState(),
    };
  }

  const selection = await dialog.showOpenDialog(owner, {
    title: '选择蝴蝶刀素材文件夹',
    buttonLabel: '使用此文件夹',
    properties: ['openDirectory'],
  });

  if (selection.canceled || selection.filePaths.length === 0) {
    return {
      canceled: true,
      changed: false,
      error: null,
      skin: currentSkinState(),
    };
  }

  const inspection = inspectCustomSkinDirectory(selection.filePaths[0]);
  if (!inspection.ok || inspection.error !== null) {
    const message = inspection.error ?? '未找到有效的 frame_*.png 序列帧';
    await dialog.showMessageBox(owner, {
      type: 'warning',
      title: '素材文件夹无效',
      message: '未找到有效的 frame_*.png 序列帧',
      detail: `${message}\n\n请选择包含 frame_000.png、frame_001.png … 的文件夹。当前素材未改变。`,
      buttons: ['知道了'],
      noLink: true,
    });

    return {
      canceled: false,
      changed: false,
      error: message,
      skin: currentSkinState(),
    };
  }

  const result = setCustomSkin(inspection.directory);
  if (result.changed) {
    console.log(
      `[skin] selected path=${inspection.directory} frames=${inspection.frames.length}`,
    );
  }

  return result;
}

function resetCustomSkin(): SkinSelectionResult {
  return setCustomSkin(null);
}

function updateDisplaySettings(patch: unknown): DisplaySettings {
  if (typeof patch !== 'object' || patch === null) {
    throw new Error('invalid settings payload');
  }

  const record = patch as Record<string, unknown>;
  let nextDuration = appConfig.inspectionDurationMs;
  let nextSize = appConfig.knifeDisplaySize;
  let nextOffsetX = appConfig.offsetX;
  let nextOffsetY = appConfig.offsetY;
  let nextSmoothingLevel = appConfig.smoothingLevel;
  let nextHideSystemCursor = appConfig.hideSystemCursor;

  if ('inspectionDurationMs' in record) {
    if (
      typeof record.inspectionDurationMs !== 'number' ||
      !Number.isFinite(record.inspectionDurationMs)
    ) {
      throw new Error('inspectionDurationMs must be a finite number');
    }
    nextDuration = normalizeInspectionDuration(record.inspectionDurationMs);
  }

  if ('knifeDisplaySize' in record) {
    if (
      typeof record.knifeDisplaySize !== 'number' ||
      !Number.isFinite(record.knifeDisplaySize)
    ) {
      throw new Error('knifeDisplaySize must be a finite number');
    }
    nextSize = normalizeKnifeDisplaySize(record.knifeDisplaySize);
  }

  if ('offsetX' in record) {
    if (
      typeof record.offsetX !== 'number' ||
      !Number.isFinite(record.offsetX)
    ) {
      throw new Error('offsetX must be a finite number');
    }
    nextOffsetX = normalizeOffset(record.offsetX);
  }

  if ('offsetY' in record) {
    if (
      typeof record.offsetY !== 'number' ||
      !Number.isFinite(record.offsetY)
    ) {
      throw new Error('offsetY must be a finite number');
    }
    nextOffsetY = normalizeOffset(record.offsetY);
  }

  if ('smoothingLevel' in record) {
    if (
      typeof record.smoothingLevel !== 'number' ||
      !Number.isFinite(record.smoothingLevel)
    ) {
      throw new Error('smoothingLevel must be a finite number');
    }
    nextSmoothingLevel = normalizeSmoothingLevel(record.smoothingLevel);
  }

  if ('hideSystemCursor' in record) {
    if (typeof record.hideSystemCursor !== 'boolean') {
      throw new Error('hideSystemCursor must be a boolean');
    }
    nextHideSystemCursor = record.hideSystemCursor;
  }

  const durationChanged = nextDuration !== appConfig.inspectionDurationMs;
  const sizeChanged = nextSize !== appConfig.knifeDisplaySize;
  const offsetChanged =
    nextOffsetX !== appConfig.offsetX || nextOffsetY !== appConfig.offsetY;
  const smoothingChanged = nextSmoothingLevel !== appConfig.smoothingLevel;
  const hideChanged = nextHideSystemCursor !== appConfig.hideSystemCursor;

  if (
    !durationChanged &&
    !sizeChanged &&
    !offsetChanged &&
    !smoothingChanged &&
    !hideChanged
  ) {
    return currentDisplaySettings();
  }

  appConfig = {
    ...appConfig,
    inspectionDurationMs: nextDuration,
    knifeDisplaySize: nextSize,
    offsetX: nextOffsetX,
    offsetY: nextOffsetY,
    smoothingLevel: nextSmoothingLevel,
    hideSystemCursor: nextHideSystemCursor,
  };

  if (sizeChanged || offsetChanged || smoothingChanged) {
    // Reposition every loaded overlay immediately. Size, hotspot offset and
    // cursor damping are all applied by the renderer around the cursor point.
    sendDisplaySettingsToOverlays();
  }

  if (hideChanged) {
    if (nextHideSystemCursor) {
      // Apply immediately, including while the settings window is open. The
      // overlay stays above it and acts as the pointer, so the controls remain
      // usable even though the Windows arrow is hidden.
      void startSystemCursorHider('settings-toggle-on');
    } else {
      // Kill the helper first, then restore, so a hung SetSystemCursor call
      // cannot put the blank handle back after our restore. Unconditional.
      void stopSystemCursorHider('settings-toggle-off');
    }
  }

  console.log(
    `[settings] duration=${nextDuration}ms size=${nextSize}px ` +
      `offset=${nextOffsetX},${nextOffsetY} smoothing=${nextSmoothingLevel} ` +
      `hideCursor=${nextHideSystemCursor} ` +
      `activeInspection=${activeInspectionId !== 0 ? activeInspectionId : 'none'}`,
  );

  schedulePersistAppConfig(
    `settings duration=${nextDuration}ms size=${nextSize}px ` +
      `offset=${nextOffsetX},${nextOffsetY} ` +
      `smoothing=${nextSmoothingLevel} hideCursor=${nextHideSystemCursor}`,
  );
  refreshTrayMenu();

  return currentDisplaySettings();
}

function registerIpcHandlers(): void {
  ipcMain.on(IPC_CHANNELS.inspectionFinished, (event, payload: unknown) => {
    if (!isInspectionFinished(payload)) {
      return;
    }

    const senderId = event.sender.id;
    const senderIsOverlay = [...overlays.values()].some(
      (overlay) =>
        !overlay.window.isDestroyed() &&
        overlay.window.webContents.id === senderId,
    );

    if (!senderIsOverlay) {
      return;
    }

    if (payload.instanceId !== activeInspectionId) {
      console.log(
        `[inspect] ignored finish instance=${payload.instanceId} ` +
          `current=${activeInspectionId}`,
      );
      return;
    }

    activeInspectionId = 0;
    clearInspectionSafetyTimer();
    console.log(
      `[inspect] finished instance=${payload.instanceId} reason=${payload.reason}`,
    );
  });

  ipcMain.handle(IPC_CHANNELS.settingsGet, (event) => {
    if (!isSettingsSender(event.sender.id)) {
      throw new Error('settings IPC is only available to the settings window');
    }

    return currentDisplaySettings();
  });

  ipcMain.handle(IPC_CHANNELS.settingsUpdate, (event, patch: unknown) => {
    if (!isSettingsSender(event.sender.id)) {
      throw new Error('settings IPC is only available to the settings window');
    }

    return updateDisplaySettings(patch);
  });

  ipcMain.handle(IPC_CHANNELS.skinGet, (event) => {
    if (!isSettingsSender(event.sender.id)) {
      throw new Error('settings IPC is only available to the settings window');
    }

    return currentSkinState();
  });

  ipcMain.handle(IPC_CHANNELS.skinChoose, (event) => {
    if (!isSettingsSender(event.sender.id)) {
      throw new Error('settings IPC is only available to the settings window');
    }

    return chooseCustomSkin();
  });

  ipcMain.handle(IPC_CHANNELS.skinReset, (event) => {
    if (!isSettingsSender(event.sender.id)) {
      throw new Error('settings IPC is only available to the settings window');
    }

    return resetCustomSkin();
  });
}

function clearInspectionSafetyTimer(): void {
  if (inspectionSafetyTimer === null) {
    return;
  }

  clearTimeout(inspectionSafetyTimer);
  inspectionSafetyTimer = null;
}

function hasLoadedOverlay(): boolean {
  for (const overlay of overlays.values()) {
    if (!overlay.window.isDestroyed() && overlay.loaded) {
      return true;
    }
  }

  return false;
}

function sendInspectionStart(start: InspectionStart): number {
  let sent = 0;

  for (const overlay of overlays.values()) {
    if (overlay.window.isDestroyed() || !overlay.loaded) {
      continue;
    }

    overlay.window.webContents.send(IPC_CHANNELS.inspectionStart, start);
    sent += 1;
  }

  return sent;
}

function sendInspectionReset(reset: InspectionReset): number {
  let sent = 0;

  for (const overlay of overlays.values()) {
    if (overlay.window.isDestroyed() || !overlay.loaded) {
      continue;
    }

    overlay.window.webContents.send(IPC_CHANNELS.inspectionReset, reset);
    sent += 1;
  }

  return sent;
}

function requestInspection(source: string): void {
  if (!overlayVisible || quitting) {
    return;
  }

  if (!hasLoadedOverlay()) {
    console.warn(`[inspect] ignored trigger source=${source}: window not loaded`);
    return;
  }

  const now = Date.now();

  if (activeInspectionId !== 0) {
    if (appConfig.retriggerMode === 'ignore') {
      console.log(`[inspect] ignored trigger source=${source} mode=ignore`);
      return;
    }

    if (now - lastInspectionStartedAt < MIN_RETRIGGER_INTERVAL_MS) {
      console.log(`[inspect] ignored restart inside 50ms source=${source}`);
      return;
    }
  }

  inspectionSequence += 1;
  const instanceId = inspectionSequence;
  activeInspectionId = instanceId;
  lastInspectionStartedAt = now;

  const durationMs = appConfig.inspectionDurationMs;
  const sent = sendInspectionStart({
    instanceId,
    durationMs,
  });

  if (sent === 0) {
    activeInspectionId = 0;
    return;
  }

  clearInspectionSafetyTimer();
  inspectionSafetyTimer = setTimeout(() => {
    inspectionSafetyTimer = null;
    if (activeInspectionId === instanceId) {
      console.warn(`[inspect] safety timeout instance=${instanceId}`);
      forceIdle('inspection-safety-timeout');
    }
  }, durationMs + INSPECTION_SAFETY_MARGIN_MS);

  console.log(
    `[inspect] start instance=${instanceId} source=${source} ` +
      `mode=${appConfig.retriggerMode} duration=${durationMs}ms windows=${sent}`,
  );
}

function forceIdle(reason: string): void {
  const hadActiveInspection = activeInspectionId !== 0;
  fKeyDown = false;
  activeInspectionId = 0;
  clearInspectionSafetyTimer();

  inspectionSequence += 1;
  const sent = sendInspectionReset({
    instanceId: inspectionSequence,
    reason,
  });

  console.log(
    `[inspect] force idle reason=${reason} hadActive=${hadActiveInspection} ` +
      `windows=${sent}`,
  );
}

function handleHookKeyDown(event: HookKeyEvent): void {
  console.log(`[hook] keydown=${event.keycode}`);

  if (event.keycode !== F_KEYCODE || fKeyDown) {
    return;
  }

  // The lock is released only by keyup. OS auto-repeat therefore cannot start
  // a second inspection while F is held.
  fKeyDown = true;
  requestInspection('uiohook');
}

function handleHookKeyUp(event: HookKeyEvent): void {
  if (event.keycode !== F_KEYCODE) {
    return;
  }

  fKeyDown = false;
  console.log('[hook] F keyup (unlocked)');
}

function startKeyboardHook(): void {
  if (uiohookStarted || quitting) {
    return;
  }

  if (DISABLE_HOOK_FOR_DIAGNOSTICS) {
    uiohookError = 'disabled by KNIFE_CURSOR_DISABLE_HOOK=1';
    logCrash('Keyboard hook skipped by KNIFE_CURSOR_DISABLE_HOOK=1');
    refreshTrayMenu();
    return;
  }

  try {
    logCrash('Keyboard hook: requiring uiohook-napi');
    const module =
      uiohookModule ??
      (require('uiohook-napi') as UiohookModule);

    uiohookModule = module;
    logCrash('Keyboard hook: module loaded; attaching listeners');

    if (!uiohookListenersAttached) {
      module.uIOhook.on('keydown', handleHookKeyDown);
      module.uIOhook.on('keyup', handleHookKeyUp);
      uiohookListenersAttached = true;
    }

    logCrash('Keyboard hook: calling uIOhook.start()');
    module.uIOhook.start();
    uiohookStarted = true;
    uiohookError = null;
    uiohookErrorShown = false;
    console.log(`[hook] uiohook started F=${F_KEYCODE}`);
    logCrash('Keyboard hook: uIOhook.start() returned');
    refreshTrayMenu();
  } catch (error) {
    const message = describeError(error);
    uiohookError = message;
    console.error('[hook] uiohook start failed', error);
    logCrash(`Keyboard hook start failed: ${message}`);
    refreshTrayMenu();

    if (!uiohookErrorShown) {
      uiohookErrorShown = true;
      dialog.showErrorBox(
        '全局键盘钩子启动失败',
        `无法启动 uiohook-napi。\n\n${message}\n\n` +
          `仍可使用 ${FALLBACK_TRIGGER_SHORTCUT} 触发检视，` +
          `托盘菜单和 ${EMERGENCY_QUIT_SHORTCUT} 退出仍然可用。`,
      );
    }
  }
}

function stopKeyboardHook(): void {
  if (!uiohookStarted || uiohookModule === null) {
    return;
  }

  try {
    uiohookModule.uIOhook.stop();
  } catch (error) {
    console.warn('[hook] uiohook stop failed', error);
  }

  if (uiohookListenersAttached) {
    try {
      uiohookModule.uIOhook.off('keydown', handleHookKeyDown);
      uiohookModule.uIOhook.off('keyup', handleHookKeyUp);
    } catch (error) {
      console.warn('[hook] remove listeners failed', error);
    }
    uiohookListenersAttached = false;
  }

  uiohookStarted = false;
}

function restartKeyboardHook(reason: string): void {
  console.log(`[hook] restarting reason=${reason}`);
  stopKeyboardHook();
  startKeyboardHook();
}

function registerPowerEvents(): void {
  powerMonitor.on('lock-screen', () => {
    console.log('[power] lock-screen');
    forceIdle('lock-screen');
    // Do not leave the secure/lock desktop without a pointer.
    void stopSystemCursorHider('lock-screen');
  });

  powerMonitor.on('unlock-screen', () => {
    console.log('[power] unlock-screen');
    forceIdle('unlock-screen');
    restartKeyboardHook('unlock-screen');
    void startSystemCursorHider('unlock-screen');
  });

  powerMonitor.on('suspend', () => {
    console.log('[power] suspend');
    forceIdle('suspend');
    void stopSystemCursorHider('suspend');
  });

  powerMonitor.on('resume', () => {
    console.log('[power] resume');
    forceIdle('resume');
    restartKeyboardHook('resume');
    void startSystemCursorHider('resume');
  });
}

function registerShortcuts(): void {
  const register = (
    accelerator: string,
    label: string,
    handler: () => void,
  ): void => {
    try {
      if (!globalShortcut.register(accelerator, handler)) {
        console.error(`[shortcut] could not register ${accelerator} (${label})`);
        return;
      }

      console.log(`[shortcut] registered ${accelerator} (${label})`);
    } catch (error) {
      console.error(`[shortcut] registration failed ${accelerator}`, error);
    }
  };

  for (const shortcut of RETRIGGER_MODE_SHORTCUTS) {
    register(shortcut.accelerator, `retriggerMode=${shortcut.mode}`, () => {
      setRetriggerMode(shortcut.mode);
    });
  }

  register(OVERLAY_TOGGLE_SHORTCUT, 'toggle overlay', () => {
    setOverlayEnabled(!overlayVisible);
  });

  register(FALLBACK_TRIGGER_SHORTCUT, 'fallback inspection', () => {
    requestInspection('fallback-shortcut');
  });

  register(FORCE_CURSOR_RESTORE_SHORTCUT, 'force cursor restore', () => {
    forceRestoreSystemCursor();
  });

  register(EMERGENCY_QUIT_SHORTCUT, 'emergency quit', () => {
    app.quit();
  });
}

function scheduleDisplaySync(): void {
  if (quitting) {
    return;
  }

  if (displaySyncTimer !== null) {
    clearTimeout(displaySyncTimer);
  }

  displaySyncTimer = setTimeout(() => {
    displaySyncTimer = null;
    syncOverlays();
  }, DISPLAY_SYNC_DEBOUNCE_MS);
}

function normalizeBounds(bounds: Rectangle): Rectangle {
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height)),
  };
}

function syncOverlays(): void {
  if (quitting) {
    return;
  }

  const nextDisplays = screen.getAllDisplays();
  const nextDisplayIds = new Set(nextDisplays.map((display) => display.id));
  displays = nextDisplays;
  logCrash(`syncOverlays begin displays=${nextDisplays.length}`);

  for (const [displayId, overlay] of [...overlays]) {
    if (nextDisplayIds.has(displayId)) {
      continue;
    }

    overlays.delete(displayId);
    if (!overlay.window.isDestroyed()) {
      overlay.window.destroy();
    }
  }

  for (const display of nextDisplays) {
    const bounds = normalizeBounds(display.bounds);
    const existing = overlays.get(display.id);

    if (!existing || existing.window.isDestroyed()) {
      if (existing) {
        overlays.delete(display.id);
      }

      try {
        overlays.set(display.id, createOverlay(display, bounds));
      } catch (error) {
        console.error(`[overlay] create failed display=${display.id}`, error);
        logCrash(
          `Overlay create failed display=${display.id}: ${describeError(error)}`,
        );
      }
      continue;
    }

    const currentBounds = existing.window.getBounds();
    if (
      currentBounds.x !== bounds.x ||
      currentBounds.y !== bounds.y ||
      currentBounds.width !== bounds.width ||
      currentBounds.height !== bounds.height
    ) {
      existing.window.setBounds(bounds);
    }
  }

  pumpCursor(true);
  logCrash(`syncOverlays complete overlays=${overlays.size}`);
}

let sandboxFallbackRelaunching = false;

function relaunchWithoutSandboxOnce(
  reason: string,
  exitCode: number,
): boolean {
  if (
    sandboxFallbackRelaunching ||
    !app.isPackaged ||
    process.platform !== 'win32' ||
    reason !== 'launch-failed' ||
    app.commandLine.hasSwitch('no-sandbox')
  ) {
    return false;
  }

  // Some Windows endpoint-security products and restricted sessions reject
  // Chromium's sandbox helper process with exit code 18. The renderer never
  // starts, so retrying inside the same process cannot help. Relaunch exactly
  // once with --no-sandbox; the new process sees the switch and will not loop.
  sandboxFallbackRelaunching = true;
  const args = [...process.argv.slice(1), '--no-sandbox'];
  logCrash(
    `Renderer launch-failed exitCode=${exitCode}; ` +
      `relaunching once with --no-sandbox args=${JSON.stringify(args)}`,
  );
  app.relaunch({ args });
  app.exit(0);
  return true;
}

function createOverlay(
  display: Display,
  bounds: Rectangle,
): OverlayWindow {
  console.log(
    `[overlay] create display=${display.id} bounds=${JSON.stringify(bounds)} ` +
      `scale=${display.scaleFactor}`,
  );

  logCrash(
    `createOverlay begin display=${display.id} bounds=${JSON.stringify(bounds)}`,
  );

  const overlayWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    show: false,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    acceptFirstMouse: false,
    title: OVERLAY_WINDOW_TITLE,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      backgroundThrottling: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });

  logCrash(`createOverlay BrowserWindow constructed display=${display.id}`);

  const overlay: OverlayWindow = {
    displayId: display.id,
    window: overlayWindow,
    loaded: false,
  };

  overlayWindow.setMenuBarVisibility(false);
  overlayWindow.setFocusable(false);
  overlayWindow.setSkipTaskbar(true);
  overlayWindow.setResizable(false);
  overlayWindow.setMovable(false);
  overlayWindow.setMinimizable(false);
  overlayWindow.setMaximizable(false);
  overlayWindow.setFullScreenable(false);
  overlayWindow.setAlwaysOnTop(true);
  applyClickThrough(overlayWindow);

  overlayWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  overlayWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error('[overlay] preload error', preloadPath, error);
    logCrash(
      `Overlay preload error path=${preloadPath}: ${describeError(error)}`,
    );
  });

  overlayWindow.webContents.on(
    'console-message',
    (_event, level, message, line, sourceId) => {
      console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
    },
  );

  const devServerUrl = DEV_RENDERER_URL;

  overlayWindow.webContents.on('will-navigate', (event, url) => {
    if (!devServerUrl || !url.startsWith(devServerUrl)) {
      event.preventDefault();
    }
  });

  overlayWindow.once('ready-to-show', () => {
    logCrash(`Overlay ready-to-show display=${display.id}`);
    revealOverlay(overlay, 'ready-to-show');
  });

  overlayWindow.webContents.on('did-finish-load', () => {
    logCrash(`Overlay did-finish-load display=${display.id}`);
    overlay.loaded = true;
    applyClickThrough(overlayWindow);
    // Renderer starts at the compile-time defaults; replace them with the
    // persisted, user-tuned values before the first frame is shown.
    overlayWindow.webContents.send(
      IPC_CHANNELS.displaySettings,
      currentDisplaySettings(),
    );
    overlayWindow.webContents.send(
      IPC_CHANNELS.skinChanged,
      currentSkinState(),
    );
    revealOverlay(overlay, 'did-finish-load');
    pumpCursor(true);
  });

  overlayWindow.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL) => {
      console.error(
        `[overlay] load failed (${errorCode}): ${errorDescription} ${validatedURL}`,
      );
      logCrash(
        `Overlay load failed display=${display.id} code=${errorCode} ` +
          `description=${errorDescription} url=${validatedURL}`,
      );
    },
  );

  overlayWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[overlay] renderer gone: ${details.reason}`);
    logCrash(
      `Overlay render-process-gone display=${display.id} ` +
        `reason=${details.reason} exitCode=${details.exitCode}`,
    );
    if (relaunchWithoutSandboxOnce(details.reason, details.exitCode)) {
      return;
    }
    forceIdle('renderer-gone');
  });

  overlayWindow.webContents.on('unresponsive', () => {
    logCrash(`Overlay renderer unresponsive display=${display.id}`);
  });

  overlayWindow.on('closed', () => {
    logCrash(`Overlay window closed display=${display.id}`);
    overlays.delete(display.id);
  });

  if (devServerUrl) {
    void overlayWindow
      .loadURL(`${devServerUrl}/index.html`)
      .catch((error: unknown) => {
        console.error('[overlay] loadURL failed', error);
      });
  } else {
    const rendererHtml = path.join(RENDERER_DIR, 'index.html');

    logCrash(`Overlay loadFile start display=${display.id} path=${rendererHtml}`);
    void overlayWindow
      .loadFile(rendererHtml)
      .then(() => {
        logCrash(`Overlay loadFile resolved display=${display.id}`);
      })
      .catch((error: unknown) => {
        console.error('[overlay] loadFile failed', error);
        logCrash(
          `Overlay loadFile rejected display=${display.id}: ${describeError(error)}`,
        );
      });
  }

  return overlay;
}

function applyClickThrough(window: ElectronBrowserWindow): void {
  if (process.platform === 'win32' || process.platform === 'darwin') {
    window.setIgnoreMouseEvents(true, { forward: true });
    return;
  }

  window.setIgnoreMouseEvents(true);
}

function revealOverlay(overlay: OverlayWindow, reason: string): void {
  if (!overlayVisible || quitting || overlay.window.isDestroyed()) {
    logCrash(
      `Overlay reveal skipped display=${overlay.displayId} reason=${reason} ` +
        `visibleFlag=${overlayVisible} quitting=${quitting} ` +
        `destroyed=${overlay.window.isDestroyed()}`,
    );
    return;
  }

  applyClickThrough(overlay.window);

  try {
    logCrash(`Overlay show start display=${overlay.displayId} reason=${reason}`);
    if (!overlay.window.isVisible()) {
      overlay.window.showInactive();
      logCrash(
        `Overlay showInactive returned display=${overlay.displayId} ` +
          `visible=${overlay.window.isVisible()}`,
      );
    }
    overlay.window.moveTop();
    overlay.window.setFocusable(false);
    overlay.window.setSkipTaskbar(true);
    applyClickThrough(overlay.window);
  } catch (error) {
    console.error(`[overlay] reveal failed display=${overlay.displayId}`, error);
    logCrash(
      `Overlay reveal failed display=${overlay.displayId}: ${describeError(error)}`,
    );
  }

  console.log(
    `[overlay] reveal display=${overlay.displayId} reason=${reason} ` +
      `visible=${overlay.window.isVisible()}`,
  );
}

function showAllOverlays(): void {
  for (const overlay of overlays.values()) {
    if (!overlay.window.isDestroyed() && overlay.loaded) {
      revealOverlay(overlay, 'show-all');
    }
  }
}

function startCursorLoop(): void {
  if (cursorPoller !== null || quitting) {
    return;
  }

  lastCursorPoint = null;
  cursorPoller = setInterval(() => {
    pumpCursor();
  }, CURSOR_POLL_INTERVAL_MS);

  pumpCursor(true);
}

function stopCursorLoop(): void {
  if (cursorPoller === null) {
    return;
  }

  clearInterval(cursorPoller);
  cursorPoller = null;
}

function hideOverlay(overlay: OverlayWindow): void {
  if (overlay.window.isDestroyed()) {
    return;
  }

  if (overlay.loaded) {
    overlay.window.webContents.send(IPC_CHANNELS.cursorUpdate, {
      displayId: overlay.displayId,
      x: 0,
      y: 0,
      visible: false,
    } satisfies CursorUpdate);
  }

  if (overlay.window.isVisible()) {
    overlay.window.hide();
  }
}

function pumpCursor(force = false): void {
  if (!overlayVisible || quitting) {
    return;
  }

  let point: ScreenPoint;

  try {
    point = screen.getCursorScreenPoint();
  } catch (error) {
    console.error('[cursor] getCursorScreenPoint failed', error);
    return;
  }

  if (
    !force &&
    lastCursorPoint !== null &&
    point.x === lastCursorPoint.x &&
    point.y === lastCursorPoint.y
  ) {
    return;
  }

  lastCursorPoint = point;

  const activeDisplay = screen.getDisplayNearestPoint(point);
  const activeOverlay = overlays.get(activeDisplay.id);

  for (const overlay of overlays.values()) {
    if (overlay !== activeOverlay) {
      hideOverlay(overlay);
    }
  }

  if (
    !activeOverlay ||
    !activeOverlay.loaded ||
    activeOverlay.window.isDestroyed()
  ) {
    return;
  }

  const update: CursorUpdate = {
    displayId: activeDisplay.id,
    x: point.x - activeDisplay.bounds.x,
    y: point.y - activeDisplay.bounds.y,
    visible: true,
  };

  try {
    activeOverlay.window.webContents.send(IPC_CHANNELS.cursorUpdate, update);
  } catch (error) {
    console.error('[cursor] send failed', error);
    return;
  }

  if (!activeOverlay.window.isVisible()) {
    revealOverlay(activeOverlay, 'cursor-enter-display');
  }
}

function setOverlayEnabled(nextEnabled: boolean): void {
  if (overlayVisible === nextEnabled) {
    refreshTrayMenu();
    return;
  }

  overlayVisible = nextEnabled;
  appConfig = { ...appConfig, overlayEnabled: nextEnabled };

  if (!overlayVisible) {
    void stopSystemCursorHider('overlay-disabled');
    forceIdle('overlay-disabled');
    stopCursorLoop();
    lastCursorPoint = null;

    for (const overlay of overlays.values()) {
      hideOverlay(overlay);
    }
  } else {
    showAllOverlays();
    startCursorLoop();
    pumpCursor(true);
    void startSystemCursorHider('overlay-enabled');
  }

  persistAppConfig(`overlayEnabled=${nextEnabled}`);
  refreshTrayMenu();
}

function openSettingsWindow(): void {
  if (quitting) {
    return;
  }

  if (settingsWindow !== null && !settingsWindow.isDestroyed()) {
    void stopSystemCursorHider('settings-focus');
    if (settingsWindow.isMinimized()) {
      settingsWindow.restore();
    }
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }

  // A globally hidden cursor would make the sliders unusable. Start the restore
  // without waiting; the settings window must appear immediately.
  void stopSystemCursorHider('settings-open');

  const window = new BrowserWindow({
    width: 540,
    height: 1040,
    minWidth: 500,
    minHeight: 760,
    show: false,
    frame: true,
    transparent: false,
    backgroundColor: '#171b22',
    title: `${APP_NAME} 设置`,
    autoHideMenuBar: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      additionalArguments: [SETTINGS_WINDOW_ARG],
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });

  settingsWindow = window;
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  const devServerUrl = DEV_RENDERER_URL;
  window.webContents.on('will-navigate', (event, url) => {
    const allowed = devServerUrl
      ? url.startsWith(devServerUrl)
      : url.startsWith('file://');
    if (!allowed) {
      event.preventDefault();
    }
  });

  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error('[settings] preload error', preloadPath, error);
  });

  window.webContents.on(
    'console-message',
    (_event, level, message, line, sourceId) => {
      console.log(`[settings:${level}] ${message} (${sourceId}:${line})`);
    },
  );

  window.once('ready-to-show', () => {
    if (!window.isDestroyed()) {
      window.show();
      window.focus();
    }
  });

  window.webContents.on('did-finish-load', () => {
    console.log('[settings] window loaded');
  });

  window.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL) => {
      console.error(
        `[settings] load failed (${errorCode}): ${errorDescription} ${validatedURL}`,
      );
    },
  );

  window.on('closed', () => {
    if (settingsWindow === window) {
      settingsWindow = null;
    }
    console.log('[settings] window closed');
    if (appConfig.hideSystemCursor) {
      void startSystemCursorHider('settings-closed');
    }
  });

  if (devServerUrl) {
    const settingsUrl = new URL(
      'settings.html',
      devServerUrl.endsWith('/') ? devServerUrl : `${devServerUrl}/`,
    ).toString();

    void window.loadURL(settingsUrl).catch((error: unknown) => {
      console.error('[settings] loadURL failed', error);
    });
  } else {
    const settingsHtml = path.join(RENDERER_DIR, 'settings.html');

    void window.loadFile(settingsHtml).catch((error: unknown) => {
      console.error('[settings] loadFile failed', error);
    });
  }

  console.log('[settings] window created');
}

function trayIconCandidates(): string[] {
  return [
    path.join(app.getAppPath(), 'assets', 'tray.png'),
    path.join(process.resourcesPath, 'app.asar', 'assets', 'tray.png'),
    path.join(process.cwd(), 'assets', 'tray.png'),
  ];
}

/**
 * Tray icon: one ordinary PNG file on disk. No base64, no generated bitmap.
 * createFromPath reads from app.asar transparently on Windows.
 */
function resolveTrayIcon(): NativeImage {
  for (const candidate of trayIconCandidates()) {
    if (!fs.existsSync(candidate)) {
      continue;
    }

    const icon = nativeImage.createFromPath(candidate);
    if (!icon.isEmpty()) {
      return icon;
    }
  }

  throw new Error(
    'assets/tray.png was not found or could not be decoded. ' +
      'Check that electron-builder includes /assets/tray.png.',
  );
}

function createTray(): void {
  if (DISABLE_TRAY_FOR_DIAGNOSTICS) {
    tray = null;
    logCrash('Tray skipped by KNIFE_CURSOR_DISABLE_TRAY=1');
    return;
  }

  try {
    logCrash('Tray: resolving icon');
    tray = new Tray(resolveTrayIcon());
    tray.setToolTip(`${APP_NAME} — F 检视`);
    // Do not let Electron open the menu automatically: showTrayMenu restores
    // the native pointer first, otherwise the menu is impossible to aim at.
    tray.on('click', showTrayMenu);
    tray.on('right-click', showTrayMenu);
    refreshTrayMenu();
    console.log('[tray] created');
    logCrash('Tray: created');
  } catch (error) {
    tray = null;
    console.error('[tray] creation failed', error);
    logCrash(`Tray creation failed: ${describeError(error)}`);
    dialog.showErrorBox(
      '托盘创建失败',
      `托盘图标未能创建。\n\n${describeError(error)}\n\n` +
        `仍可使用 ${FALLBACK_TRIGGER_SHORTCUT} 触发检视，` +
        `${EMERGENCY_QUIT_SHORTCUT} 退出。`,
    );
  }
}

function refreshTrayMenu(): void {
  if (tray === null) {
    return;
  }

  const hookLabel = uiohookStarted
    ? '全局键盘钩子：F 已启用'
    : uiohookError !== null
      ? '全局键盘钩子：启动失败'
      : '全局键盘钩子：未启动';

  const menu = Menu.buildFromTemplate([
    {
      label: '启用覆盖层（取消勾选即暂停）',
      type: 'checkbox',
      checked: overlayVisible,
      click: (menuItem) => {
        setOverlayEnabled(menuItem.checked);
      },
    },
    { type: 'separator' },
    {
      label: '检视触发方式',
      submenu: [
        {
          label: '忽略（播放中不响应）',
          type: 'radio',
          checked: appConfig.retriggerMode === 'ignore',
          click: () => {
            setRetriggerMode('ignore');
          },
        },
        {
          label: '立即重播（从第 0 帧重新开始）',
          type: 'radio',
          checked: appConfig.retriggerMode === 'restart',
          click: () => {
            setRetriggerMode('restart');
          },
        },
      ],
    },
    { label: hookLabel, enabled: false },
    { label: `备用触发：${FALLBACK_TRIGGER_SHORTCUT}`, enabled: false },
    { type: 'separator' },
    {
      label: '⚙️ 设置...',
      click: () => {
        openSettingsWindow();
      },
    },
    {
      label:
        `动画 ${appConfig.inspectionDurationMs}ms · ` +
        `光标 ${appConfig.knifeDisplaySize}px · ` +
        `偏移 ${appConfig.offsetX},${appConfig.offsetY} · ` +
        `松紧 ${appConfig.smoothingLevel} · ` +
        `系统光标${appConfig.hideSystemCursor ? '隐藏' : '显示'}`,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: '退出 Knife Cursor',
      click: () => {
        app.quit();
      },
    },
  ]);

  trayMenu = menu;

  menu.on('menu-will-close', () => {
    // menu-will-close fires for popup menus as well as application menus.
    if (appConfig.hideSystemCursor) {
      void startSystemCursorHider('tray-menu-closed');
    }
  });
}

async function teardown(): Promise<void> {
  if (quitting) {
    return;
  }

  quitting = true;
  logCrash('Teardown begin');

  // before-quit waits for this promise. The UI can disappear immediately
  // afterwards; keeping the process alive until the arrow is restored is what
  // makes an ordinary quit deterministic without blocking the main thread.
  await stopSystemCursorHider('teardown');
  logCrash('Teardown: cursor restore finished');

  stopKeepAliveTimer();
  flushPendingConfigSave();
  stopCursorLoop();
  stopKeyboardHook();

  if (settingsWindow !== null && !settingsWindow.isDestroyed()) {
    settingsWindow.destroy();
  }
  settingsWindow = null;

  if (displaySyncTimer !== null) {
    clearTimeout(displaySyncTimer);
    displaySyncTimer = null;
  }

  clearInspectionSafetyTimer();

  const remainingOverlays = [...overlays.values()];
  overlays.clear();

  for (const overlay of remainingOverlays) {
    if (!overlay.window.isDestroyed()) {
      overlay.window.destroy();
    }
  }

  if (tray !== null) {
    tray.destroy();
    tray = null;
  }

  try {
    globalShortcut.unregisterAll();
  } catch (error) {
    console.warn('[shortcut] unregisterAll failed', error);
  }

  console.log('[main] teardown complete');
  logCrash('Teardown complete');
}
```

## `src/preload.ts`

```ts
import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import { IPC_CHANNELS, SETTINGS_WINDOW_ARG } from './shared/ipc';
import type {
  CursorUpdate,
  DisplaySettings,
  InspectionFinished,
  InspectionReset,
  InspectionStart,
  KnifeCursorApi,
  SettingsApi,
  SkinState,
} from './shared/ipc';

type CursorListener = (event: IpcRendererEvent, update: CursorUpdate) => void;
type InspectionStartListener = (
  event: IpcRendererEvent,
  start: InspectionStart,
) => void;
type InspectionResetListener = (
  event: IpcRendererEvent,
  reset: InspectionReset,
) => void;
type DisplaySettingsListener = (
  event: IpcRendererEvent,
  settings: DisplaySettings,
) => void;
type SkinChangedListener = (event: IpcRendererEvent, skin: SkinState) => void;

let cursorListener: CursorListener | null = null;
let inspectionStartListener: InspectionStartListener | null = null;
let inspectionResetListener: InspectionResetListener | null = null;
let displaySettingsListener: DisplaySettingsListener | null = null;
let skinChangedListener: SkinChangedListener | null = null;

const api: KnifeCursorApi = {
  onCursorUpdate(callback) {
    if (cursorListener !== null) {
      ipcRenderer.removeListener(IPC_CHANNELS.cursorUpdate, cursorListener);
    }

    cursorListener = (_event, update) => {
      callback(update);
    };
    ipcRenderer.on(IPC_CHANNELS.cursorUpdate, cursorListener);
  },

  offCursorUpdate() {
    if (cursorListener === null) {
      return;
    }

    ipcRenderer.removeListener(IPC_CHANNELS.cursorUpdate, cursorListener);
    cursorListener = null;
  },

  onInspectionStart(callback) {
    if (inspectionStartListener !== null) {
      ipcRenderer.removeListener(
        IPC_CHANNELS.inspectionStart,
        inspectionStartListener,
      );
    }

    inspectionStartListener = (_event, start) => {
      callback(start);
    };
    ipcRenderer.on(IPC_CHANNELS.inspectionStart, inspectionStartListener);
  },

  offInspectionStart() {
    if (inspectionStartListener === null) {
      return;
    }

    ipcRenderer.removeListener(
      IPC_CHANNELS.inspectionStart,
      inspectionStartListener,
    );
    inspectionStartListener = null;
  },

  onInspectionReset(callback) {
    if (inspectionResetListener !== null) {
      ipcRenderer.removeListener(
        IPC_CHANNELS.inspectionReset,
        inspectionResetListener,
      );
    }

    inspectionResetListener = (_event, reset) => {
      callback(reset);
    };
    ipcRenderer.on(IPC_CHANNELS.inspectionReset, inspectionResetListener);
  },

  offInspectionReset() {
    if (inspectionResetListener === null) {
      return;
    }

    ipcRenderer.removeListener(
      IPC_CHANNELS.inspectionReset,
      inspectionResetListener,
    );
    inspectionResetListener = null;
  },

  onDisplaySettings(callback) {
    if (displaySettingsListener !== null) {
      ipcRenderer.removeListener(
        IPC_CHANNELS.displaySettings,
        displaySettingsListener,
      );
    }

    displaySettingsListener = (_event, settings) => {
      callback(settings);
    };
    ipcRenderer.on(IPC_CHANNELS.displaySettings, displaySettingsListener);
  },

  offDisplaySettings() {
    if (displaySettingsListener === null) {
      return;
    }

    ipcRenderer.removeListener(
      IPC_CHANNELS.displaySettings,
      displaySettingsListener,
    );
    displaySettingsListener = null;
  },

  onSkinChanged(callback) {
    if (skinChangedListener !== null) {
      ipcRenderer.removeListener(
        IPC_CHANNELS.skinChanged,
        skinChangedListener,
      );
    }

    skinChangedListener = (_event, skin) => {
      callback(skin);
    };
    ipcRenderer.on(IPC_CHANNELS.skinChanged, skinChangedListener);
  },

  offSkinChanged() {
    if (skinChangedListener === null) {
      return;
    }

    ipcRenderer.removeListener(IPC_CHANNELS.skinChanged, skinChangedListener);
    skinChangedListener = null;
  },

  notifyInspectionFinished(finished: InspectionFinished) {
    ipcRenderer.send(IPC_CHANNELS.inspectionFinished, finished);
  },
};

const settingsApi: SettingsApi = {
  get() {
    return ipcRenderer.invoke(IPC_CHANNELS.settingsGet);
  },

  update(patch) {
    return ipcRenderer.invoke(IPC_CHANNELS.settingsUpdate, patch);
  },

  getSkin() {
    return ipcRenderer.invoke(IPC_CHANNELS.skinGet);
  },

  chooseSkin() {
    return ipcRenderer.invoke(IPC_CHANNELS.skinChoose);
  },

  resetSkin() {
    return ipcRenderer.invoke(IPC_CHANNELS.skinReset);
  },
};

// The overlay and the settings window share one preload bundle. Only expose the
// privileged settings bridge to the window that main explicitly tagged.
if (process.argv.includes(SETTINGS_WINDOW_ARG)) {
  contextBridge.exposeInMainWorld('knifeSettings', settingsApi);
} else {
  contextBridge.exposeInMainWorld('knifeCursor', api);
}
```

## `src/renderer.ts`

```ts
import './index.css';
import {
  DEFAULT_INSPECTION_DURATION_MS,
  DEFAULT_KNIFE_DISPLAY_SIZE,
  DEFAULT_OFFSET,
  DEFAULT_SMOOTHING_LEVEL,
  MAX_OFFSET,
  MAX_SMOOTHING_LEVEL,
  MIN_OFFSET,
  MIN_SMOOTHING_LEVEL,
} from './shared/ipc';
import type {
  CursorUpdate,
  DisplaySettings,
  InspectionReset,
  InspectionStart,
  SkinState,
} from './shared/ipc';
import {
  loadKnifeAssets,
  preloadKnifeAssets,
} from './renderer/knife-assets';

const SNAP_EPSILON_PX = 0.05;
const MAX_FRAME_DELTA_MS = 64;
const DEFAULT_FRAME_DELTA_MS = 16;

let knifeDisplaySize = DEFAULT_KNIFE_DISPLAY_SIZE;
let halfKnifeSize = knifeDisplaySize / 2;
let knifeOffsetX = DEFAULT_OFFSET;
let knifeOffsetY = DEFAULT_OFFSET;
let smoothingLevel = DEFAULT_SMOOTHING_LEVEL;
const proxy = document.getElementById('cursor-proxy');
const knife = document.getElementById('knife-image');

if (!(proxy instanceof HTMLDivElement)) {
  throw new Error('Missing #cursor-proxy element');
}

if (!(knife instanceof HTMLImageElement)) {
  throw new Error('Missing #knife-image element');
}

const proxyElement: HTMLDivElement = proxy;
const knifeImage: HTMLImageElement = knife;
let assets = loadKnifeAssets();

proxyElement.style.width = `${knifeDisplaySize}px`;
proxyElement.style.height = `${knifeDisplaySize}px`;
knifeImage.draggable = false;

type InspectionState = 'idle' | 'inspecting';

let targetX = 0;
let targetY = 0;
let currentX = 0;
let currentY = 0;
let hasPosition = false;
let visible = false;
let frameRequest: number | null = null;
let lastFrameTimestamp = 0;

let inspectionState: InspectionState = 'idle';
let activeInstanceId = 0;

let playbackFrame: number | null = null;
let playbackEndTimer: number | null = null;
let playbackFrameUrls: readonly string[] = [];
let playbackStartedAt = 0;
let playbackDurationMs = 0;
let playbackIndex = -1;
let currentImageUrl = '';

function setKnifeImage(url: string): void {
  if (currentImageUrl === url) {
    return;
  }

  currentImageUrl = url;
  knifeImage.src = url;
}

function applyPosition(x: number, y: number): void {
  proxyElement.style.transform =
    `translate3d(${x - halfKnifeSize + knifeOffsetX}px, ` +
    `${y - halfKnifeSize + knifeOffsetY}px, 0)`;
}

function clampOffset(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_OFFSET;
  }

  return Math.min(MAX_OFFSET, Math.max(MIN_OFFSET, Math.round(numeric)));
}

function clampSmoothingLevel(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_SMOOTHING_LEVEL;
  }

  return Math.min(
    MAX_SMOOTHING_LEVEL,
    Math.max(MIN_SMOOTHING_LEVEL, Math.round(numeric)),
  );
}

function applyDisplaySettings(settings: DisplaySettings): void {
  const requestedSize = Number(settings.knifeDisplaySize);
  const nextSize =
    Number.isFinite(requestedSize) && requestedSize > 0
      ? Math.round(requestedSize)
      : DEFAULT_KNIFE_DISPLAY_SIZE;

  knifeDisplaySize = nextSize;
  halfKnifeSize = nextSize / 2;
  knifeOffsetX = clampOffset(settings.offsetX);
  knifeOffsetY = clampOffset(settings.offsetY);
  smoothingLevel = clampSmoothingLevel(settings.smoothingLevel);
  proxyElement.style.width = `${nextSize}px`;
  proxyElement.style.height = `${nextSize}px`;

  if (hasPosition) {
    applyPosition(currentX, currentY);
  }

  console.log(
    `[renderer] display size=${nextSize}px offset=${knifeOffsetX},${knifeOffsetY} ` +
      `smoothing=${smoothingLevel}`,
  );
}

function cancelScheduledFrame(): void {
  if (frameRequest === null) {
    return;
  }

  cancelAnimationFrame(frameRequest);
  frameRequest = null;
}

function setProxyVisible(nextVisible: boolean): void {
  if (visible === nextVisible) {
    return;
  }

  visible = nextVisible;
  proxyElement.classList.toggle('is-visible', nextVisible);

  if (!nextVisible) {
    cancelScheduledFrame();
    hasPosition = false;
    lastFrameTimestamp = 0;
  }
}

function requestFrame(): void {
  if (!visible || frameRequest !== null) {
    return;
  }

  frameRequest = requestAnimationFrame(step);
}

function step(timestamp: number): void {
  frameRequest = null;

  if (!visible || !hasPosition) {
    return;
  }

  const elapsed =
    lastFrameTimestamp === 0
      ? DEFAULT_FRAME_DELTA_MS
      : Math.min(MAX_FRAME_DELTA_MS, Math.max(1, timestamp - lastFrameTimestamp));
  lastFrameTimestamp = timestamp;

  if (smoothingLevel <= 0) {
    currentX = targetX;
    currentY = targetY;
    applyPosition(currentX, currentY);
    lastFrameTimestamp = 0;
    return;
  }

  const deltaX = targetX - currentX;
  const deltaY = targetY - currentY;
  // The slider value doubles as the time constant in milliseconds. At 45 it
  // reproduces the previous fixed 45ms feel; 100 gives a clearly visible lag.
  const alpha = 1 - Math.exp(-elapsed / smoothingLevel);

  currentX += deltaX * alpha;
  currentY += deltaY * alpha;

  if (
    Math.abs(targetX - currentX) <= SNAP_EPSILON_PX &&
    Math.abs(targetY - currentY) <= SNAP_EPSILON_PX
  ) {
    currentX = targetX;
    currentY = targetY;
    applyPosition(currentX, currentY);
    lastFrameTimestamp = 0;
    return;
  }

  applyPosition(currentX, currentY);
  requestFrame();
}

function revealAt(x: number, y: number): void {
  targetX = x;
  targetY = y;
  currentX = x;
  currentY = y;
  hasPosition = true;
  lastFrameTimestamp = 0;
  applyPosition(currentX, currentY);
  setProxyVisible(true);
}

function handleCursorUpdate(update: CursorUpdate): void {
  if (!update.visible) {
    setProxyVisible(false);
    return;
  }

  const x = Number.isFinite(update.x) ? update.x : 0;
  const y = Number.isFinite(update.y) ? update.y : 0;

  if (!hasPosition || !visible) {
    revealAt(x, y);
    return;
  }

  targetX = x;
  targetY = y;

  if (smoothingLevel <= 0) {
    // Hard bind: apply the fresh IPC sample in the same task instead of waiting
    // for another animation frame.
    currentX = targetX;
    currentY = targetY;
    lastFrameTimestamp = 0;
    applyPosition(currentX, currentY);
    return;
  }

  requestFrame();
}

function cancelInspectionPlayback(): void {
  if (playbackFrame !== null) {
    cancelAnimationFrame(playbackFrame);
    playbackFrame = null;
  }

  if (playbackEndTimer !== null) {
    window.clearTimeout(playbackEndTimer);
    playbackEndTimer = null;
  }

  playbackFrameUrls = [];
  playbackIndex = -1;
}

function showInspectionFrame(frameIndex: number): void {
  if (playbackFrameUrls.length === 0) {
    return;
  }

  const clamped = Math.min(
    playbackFrameUrls.length - 1,
    Math.max(0, frameIndex),
  );

  if (clamped === playbackIndex) {
    return;
  }

  playbackIndex = clamped;
  setKnifeImage(playbackFrameUrls[clamped]);
}

/**
 * Every playback gets an instanceId from main. The rAF loop and the safety
 * timer both check it, and finishInspection checks it again, so an old
 * playback can never end a newer restart. This replaces the old
 * animationend-based guard but keeps the same contract.
 */
function finishInspection(instanceId: number): void {
  if (inspectionState !== 'inspecting' || instanceId !== activeInstanceId) {
    return;
  }

  cancelInspectionPlayback();
  inspectionState = 'idle';
  setKnifeImage(assets.idleUrl);
  proxyElement.classList.remove('is-inspecting');

  window.knifeCursor?.notifyInspectionFinished({
    instanceId,
    reason: 'animationend',
  });

  console.log(
    `[renderer] inspection finished instance=${instanceId} ` +
      `frames=${assets.inspectFrameUrls.length}`,
  );
}

function startInspection(start: InspectionStart): void {
  if (!Number.isInteger(start.instanceId) || start.instanceId <= 0) {
    return;
  }

  if (start.instanceId <= activeInstanceId) {
    console.warn(
      `[renderer] ignored stale inspection start=${start.instanceId} ` +
        `current=${activeInstanceId}`,
    );
    return;
  }

  const wasInspecting = inspectionState === 'inspecting';
  cancelInspectionPlayback();

  activeInstanceId = start.instanceId;
  inspectionState = 'inspecting';

  const durationMs =
    Number.isFinite(start.durationMs) && start.durationMs > 0
      ? start.durationMs
      : DEFAULT_INSPECTION_DURATION_MS;

  playbackFrameUrls = assets.inspectFrameUrls;
  playbackDurationMs = durationMs;
  playbackIndex = -1;
  setKnifeImage(playbackFrameUrls[0] ?? assets.idleUrl);

  proxyElement.classList.remove('is-inspecting');
  // Force the browser to paint the idle/removed state before re-adding the
  // class; this keeps fast restarts visually distinct without a CSS keyframe.
  void proxyElement.offsetWidth;
  proxyElement.classList.add('is-inspecting');

  playbackStartedAt = performance.now();
  const instanceId = start.instanceId;

  const tick = (timestamp: number): void => {
    playbackFrame = null;

    if (instanceId !== activeInstanceId || inspectionState !== 'inspecting') {
      return;
    }

    const elapsed = Math.max(0, timestamp - playbackStartedAt);

    if (elapsed >= playbackDurationMs) {
      showInspectionFrame(playbackFrameUrls.length - 1);
      finishInspection(instanceId);
      return;
    }

    const frameIndex = Math.min(
      playbackFrameUrls.length - 1,
      Math.floor((elapsed / playbackDurationMs) * playbackFrameUrls.length),
    );
    showInspectionFrame(frameIndex);
    playbackFrame = requestAnimationFrame(tick);
  };

  playbackFrame = requestAnimationFrame(tick);

  // requestAnimationFrame is throttled when a window is occluded. This timer
  // guarantees that main still receives the completion and leaves inspecting.
  playbackEndTimer = window.setTimeout(() => {
    playbackEndTimer = null;

    if (instanceId !== activeInstanceId || inspectionState !== 'inspecting') {
      return;
    }

    showInspectionFrame(playbackFrameUrls.length - 1);
    finishInspection(instanceId);
  }, playbackDurationMs + 80);

  console.log(
    `[renderer] inspection start instance=${instanceId} ` +
      `duration=${durationMs}ms frames=${playbackFrameUrls.length} ` +
      `mode=${wasInspecting ? 'restart' : 'first'} source=${assets.source}`,
  );
}

function handleInspectionReset(reset: InspectionReset): void {
  cancelInspectionPlayback();
  activeInstanceId = Math.max(activeInstanceId, reset.instanceId);
  inspectionState = 'idle';
  setKnifeImage(assets.idleUrl);
  proxyElement.classList.remove('is-inspecting');

  console.log(
    `[renderer] inspection reset instance=${activeInstanceId} reason=${reset.reason}`,
  );
}

function handleVisibilityChange(): void {
  if (document.visibilityState !== 'hidden') {
    return;
  }

  if (inspectionState !== 'inspecting') {
    return;
  }

  const instanceId = activeInstanceId;
  cancelInspectionPlayback();
  inspectionState = 'idle';
  setKnifeImage(assets.idleUrl);
  proxyElement.classList.remove('is-inspecting');

  window.knifeCursor?.notifyInspectionFinished({
    instanceId,
    reason: 'hidden',
  });

  console.log(
    `[renderer] inspection aborted instance=${instanceId} reason=hidden`,
  );
}

function applySkinState(skin: SkinState): void {
  const nextAssets = loadKnifeAssets(skin);

  // A skin switch during an inspection should not keep playing frames from the
  // previous folder. Finish the current instance first, then show the new idle.
  if (inspectionState === 'inspecting') {
    assets = nextAssets;
    finishInspection(activeInstanceId);
  } else {
    assets = nextAssets;
    setKnifeImage(assets.idleUrl);
    proxyElement.classList.remove('is-inspecting');
  }

  console.log(
    `[assets] skin changed mode=${skin.mode} source=${assets.source} ` +
      `frames=${assets.inspectFrameUrls.length} path=${skin.customPath ?? '(builtin)'}`,
  );

  if (skin.error !== null) {
    console.warn(`[assets] ${skin.error}`);
  }

  void preloadKnifeAssets(assets);
}

function boot(): void {
  setKnifeImage(assets.idleUrl);

  console.log(
    `[assets] source=${assets.source} frames=${assets.inspectFrameUrls.length} ` +
      `realFrames=${assets.realFrameCount} size=${knifeDisplaySize}px`,
  );

  if (assets.usingFallbackFrames) {
    console.warn(
      '[assets] no frame_*.png found; using the built-in SVG animation. ' +
        'Drop real PNGs into src/renderer/assets/cursor/butterfly/inspect/.',
    );
  }

  void preloadKnifeAssets(assets);

  const api = window.knifeCursor;
  if (!api) {
    console.error('[renderer] preload bridge is unavailable');
    return;
  }

  api.onCursorUpdate(handleCursorUpdate);
  api.onInspectionStart(startInspection);
  api.onInspectionReset(handleInspectionReset);
  api.onDisplaySettings(applyDisplaySettings);
  api.onSkinChanged(applySkinState);

  document.addEventListener('visibilitychange', handleVisibilityChange);

  window.addEventListener(
    'beforeunload',
    () => {
      cancelInspectionPlayback();
      api.offCursorUpdate();
      api.offInspectionStart();
      api.offInspectionReset();
      api.offDisplaySettings();
      api.offSkinChanged();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    },
    { once: true },
  );
}

boot();
```

## `src/renderer/knife-assets.ts`

```ts
/// <reference types="vite/client" />

import type { SkinState } from '../shared/ipc';

/**
 * Asset discovery for the cursor art.
 *
 * Put the real files here (paths are relative to this file):
 *   assets/cursor/butterfly/idle.png
 *   assets/cursor/butterfly/inspect/frame_000.png ... frame_023.png
 *
 * The glob is eager so Vite fingerprints the images at build time. The
 * generated SVG fallback keeps `npm start` useful before any art exists.
 */

const idleModules = import.meta.glob<string>(
  './assets/cursor/butterfly/idle.png',
  {
    eager: true,
    query: '?url',
    import: 'default',
  },
);

const inspectModules = import.meta.glob<string>(
  './assets/cursor/butterfly/inspect/frame_*.png',
  {
    eager: true,
    query: '?url',
    import: 'default',
  },
);

/**
 * The rendered size is a runtime setting (`knifeDisplaySize` in config.json),
 * so it deliberately is not baked into this module.
 */

/** Number of generated SVG frames used only when no real PNGs are present. */
export const FALLBACK_FRAME_COUNT = 24;

export interface KnifeAssets {
  idleUrl: string;
  inspectFrameUrls: readonly string[];
  usingFallbackFrames: boolean;
  realFrameCount: number;
  source: 'files' | 'fallback' | 'mixed' | 'custom';
}

function numberFromFrameKey(key: string): number {
  const match = /frame_(\d+)\.png$/i.exec(key);
  return match === null ? Number.MAX_SAFE_INTEGER : Number.parseInt(match[1], 10);
}

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * A small balisong silhouette. The frame index rotates the whole knife and
 * flips it around the vertical axis, so the generated fallback exercises the
 * same frame player as real artwork.
 */
function fallbackSvg(angleDegrees: number, scaleX: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
  <defs>
    <linearGradient id="blade" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f7fafc"/>
      <stop offset="0.48" stop-color="#aebbc9"/>
      <stop offset="1" stop-color="#e8eef5"/>
    </linearGradient>
    <linearGradient id="handle" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#4b5563"/>
      <stop offset="0.5" stop-color="#20252d"/>
      <stop offset="1" stop-color="#596273"/>
    </linearGradient>
    <filter id="shadow" x="-60%" y="-60%" width="220%" height="220%">
      <feDropShadow dx="0" dy="3" stdDeviation="2.4" flood-color="#000000" flood-opacity="0.38"/>
    </filter>
  </defs>
  <g filter="url(#shadow)" transform="translate(48 48) rotate(${angleDegrees.toFixed(2)}) scale(${scaleX.toFixed(3)} 1) translate(-48 -48)">
    <path d="M48 7 C54 13 58 23 57 35 L54 61 L48 68 L42 61 L39 35 C38 23 42 13 48 7 Z"
      fill="url(#blade)" stroke="#dbe4ee" stroke-width="1"/>
    <path d="M48 11 L52 33 L49 57 L48 62 L47 57 L44 33 Z" fill="#ffffff" opacity="0.42"/>
    <path d="M42 63 L46 63 L45 88 L40 88 Z" fill="url(#handle)" stroke="#8a6b3f" stroke-width="1"/>
    <path d="M50 63 L54 63 L56 88 L51 88 Z" fill="url(#handle)" stroke="#8a6b3f" stroke-width="1"/>
    <circle cx="44" cy="67" r="1.7" fill="#e0c58a"/>
    <circle cx="52" cy="67" r="1.7" fill="#e0c58a"/>
    <path d="M40 88 L56 88" stroke="#c9a96a" stroke-width="2" stroke-linecap="round"/>
  </g>
</svg>`;
}

function makeFallbackFrames(count: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const progress = count > 1 ? index / count : 0;
    const angle = progress * 360;
    const flip = Math.cos(progress * Math.PI * 2);
    const scaleX = Math.sign(flip || 1) * Math.max(0.22, Math.abs(flip));

    return svgDataUrl(fallbackSvg(angle, scaleX));
  });
}

export function loadKnifeAssets(skin?: SkinState | null): KnifeAssets {
  if (
    skin?.mode === 'custom' &&
    skin.idleUrl !== null &&
    skin.frameUrls.length > 0
  ) {
    return {
      idleUrl: skin.idleUrl,
      inspectFrameUrls: skin.frameUrls,
      usingFallbackFrames: false,
      realFrameCount: skin.frameCount,
      source: 'custom',
    };
  }

  const realFrames = Object.entries(inspectModules)
    .sort(([keyA], [keyB]) => {
      const numberDelta = numberFromFrameKey(keyA) - numberFromFrameKey(keyB);
      return numberDelta !== 0 ? numberDelta : keyA.localeCompare(keyB);
    })
    .map(([, url]) => url);

  const realIdleUrl = Object.values(idleModules)[0];
  const fallbackFrames = makeFallbackFrames(FALLBACK_FRAME_COUNT);
  const fallbackIdleUrl = svgDataUrl(fallbackSvg(-14, 1));

  const usingFallbackFrames = realFrames.length === 0;
  const inspectFrameUrls = usingFallbackFrames ? fallbackFrames : realFrames;

  let idleUrl = realIdleUrl;
  if (idleUrl === undefined) {
    // Partial asset drops are common while iterating. Prefer a real inspect
    // frame over the placeholder, but never leave the <img> without a URL.
    idleUrl = inspectFrameUrls[0] ?? fallbackIdleUrl;
  }

  const source: KnifeAssets['source'] =
    usingFallbackFrames && realIdleUrl === undefined
      ? 'fallback'
      : usingFallbackFrames || realIdleUrl === undefined
        ? 'mixed'
        : 'files';

  return {
    idleUrl,
    inspectFrameUrls,
    usingFallbackFrames,
    realFrameCount: realFrames.length,
    source,
  };
}

/**
 * Decode every image once before it is needed. A failed decode is not fatal:
 * the player falls back to the browser's normal per-frame loading.
 */
export async function preloadKnifeAssets(assets: KnifeAssets): Promise<void> {
  const urls = [...new Set([assets.idleUrl, ...assets.inspectFrameUrls])];

  const results = await Promise.allSettled(
    urls.map(async (url) => {
      const image = new Image();
      image.decoding = 'async';
      image.src = url;
      await image.decode();
    }),
  );

  const failedCount = results.filter(
    (result) => result.status === 'rejected',
  ).length;

  if (failedCount > 0) {
    console.warn(
      `[assets] preload failed for ${failedCount}/${urls.length} images; ` +
        'the frame player will continue with on-demand decoding.',
    );
  }
}
```

## `src/settings.ts`

```ts
import './settings.css';
import type {
  DisplaySettings,
  SettingsApi,
  SkinSelectionResult,
  SkinState,
} from './shared/ipc';

function requireElement<T extends HTMLElement>(
  id: string,
  constructor: new (...args: never[]) => T,
): T {
  const element = document.getElementById(id);
  if (!(element instanceof constructor)) {
    throw new Error(`Missing #${id}`);
  }

  return element;
}

const durationInput = requireElement('duration', HTMLInputElement);
const durationValue = requireElement('duration-value', HTMLOutputElement);
const sizeInput = requireElement('size', HTMLInputElement);
const sizeValue = requireElement('size-value', HTMLOutputElement);
const offsetXInput = requireElement('offset-x', HTMLInputElement);
const offsetXValue = requireElement('offset-x-value', HTMLOutputElement);
const offsetYInput = requireElement('offset-y', HTMLInputElement);
const offsetYValue = requireElement('offset-y-value', HTMLOutputElement);
const smoothingInput = requireElement('smoothing', HTMLInputElement);
const smoothingValue = requireElement('smoothing-value', HTMLOutputElement);
const hideSystemCursorInput = requireElement(
  'hide-system-cursor',
  HTMLInputElement,
);
const resetOffsetsButton = requireElement(
  'reset-offsets',
  HTMLButtonElement,
);
const chooseSkinButton = requireElement('choose-skin', HTMLButtonElement);
const resetSkinButton = requireElement('reset-skin', HTMLButtonElement);
const skinKind = requireElement('skin-kind', HTMLSpanElement);
const skinCurrent = requireElement('skin-current', HTMLParagraphElement);
const status = requireElement('status', HTMLParagraphElement);
const closeButton = requireElement('close', HTMLButtonElement);

type NumericSettingField =
  | 'inspectionDurationMs'
  | 'knifeDisplaySize'
  | 'offsetX'
  | 'offsetY'
  | 'smoothingLevel';

let changeSequence = 0;
let skinBusy = false;

function describeSettings(settings: DisplaySettings): string {
  return (
    `动画 ${settings.inspectionDurationMs}ms / ` +
    `光标 ${settings.knifeDisplaySize}px / ` +
    `偏移 ${settings.offsetX},${settings.offsetY}px / ` +
    `松紧 ${settings.smoothingLevel} / ` +
    `系统光标${settings.hideSystemCursor ? '隐藏' : '显示'}`
  );
}

function setStatus(message: string, tone: 'idle' | 'busy' | 'ok' | 'error'): void {
  status.textContent = message;
  status.dataset.tone = tone;
}

function renderSettings(settings: DisplaySettings): void {
  durationInput.value = String(settings.inspectionDurationMs);
  durationValue.textContent = `${settings.inspectionDurationMs} ms`;

  sizeInput.value = String(settings.knifeDisplaySize);
  sizeValue.textContent = `${settings.knifeDisplaySize} px`;

  offsetXInput.value = String(settings.offsetX);
  offsetXValue.textContent = `${settings.offsetX} px`;

  offsetYInput.value = String(settings.offsetY);
  offsetYValue.textContent = `${settings.offsetY} px`;

  smoothingInput.value = String(settings.smoothingLevel);
  smoothingValue.textContent = String(settings.smoothingLevel);

  hideSystemCursorInput.checked = settings.hideSystemCursor;
}

function renderSkin(skin: SkinState): void {
  const custom = skin.mode === 'custom';
  skinKind.textContent = custom ? '自定义' : '内置';
  skinKind.dataset.mode = custom ? 'custom' : 'builtin';

  if (custom) {
    skinCurrent.textContent =
      `当前素材：自定义素材（${skin.frameCount} 帧）\n` +
      `路径：${skin.customPath ?? '(未知)'}`;
    skinCurrent.dataset.tone = 'ok';
    return;
  }

  if (skin.customPath !== null) {
    skinCurrent.textContent =
      '当前素材：内置素材\n' +
      `已保存的自定义路径不可用：${skin.customPath}` +
      (skin.error === null ? '' : `\n${skin.error}`);
    skinCurrent.dataset.tone = 'error';
    return;
  }

  skinCurrent.textContent = '当前素材：内置素材（编译进应用的默认素材）';
  skinCurrent.dataset.tone = 'idle';
}

function setSkinBusy(busy: boolean): void {
  skinBusy = busy;
  chooseSkinButton.disabled = busy;
  resetSkinButton.disabled = busy;
  chooseSkinButton.textContent = busy ? '正在应用…' : '选择自定义素材文件夹';
}

async function runSkinAction(
  api: SettingsApi,
  action: () => Promise<SkinSelectionResult>,
  busyMessage: string,
): Promise<void> {
  if (skinBusy) {
    return;
  }

  setSkinBusy(true);
  setStatus(busyMessage, 'busy');

  try {
    const result = await action();
    renderSkin(result.skin);

    if (result.canceled) {
      setStatus('已取消，当前素材未改变。', 'idle');
      return;
    }

    if (result.error !== null) {
      setStatus(`素材未改变：${result.error}`, 'error');
      return;
    }

    if (!result.changed) {
      setStatus('当前已经在使用这套素材。', 'idle');
      return;
    }

    setStatus(
      result.skin.mode === 'custom'
        ? `已换皮：${result.skin.frameCount} 帧自定义素材`
        : '已恢复内置素材',
      'ok',
    );
  } catch (error) {
    console.error('[settings] skin action failed', error);
    setStatus(`素材操作失败：${describeError(error)}`, 'error');
  } finally {
    setSkinBusy(false);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function commit(
  api: SettingsApi,
  patch: Partial<DisplaySettings>,
  busyMessage = '正在应用…',
): Promise<void> {
  const sequence = ++changeSequence;
  setStatus(busyMessage, 'busy');

  try {
    const current = await api.update(patch);

    // Ignore an older response if the user kept dragging. The newest request
    // contains the authoritative merged config from main.
    if (sequence !== changeSequence) {
      return;
    }

    renderSettings(current);
    setStatus(`已应用并保存 · ${describeSettings(current)}`, 'ok');
  } catch (error) {
    if (sequence !== changeSequence) {
      return;
    }

    console.error('[settings] update failed', error);
    setStatus(`保存失败：${describeError(error)}`, 'error');
  }
}

function bindSlider(
  api: SettingsApi,
  input: HTMLInputElement,
  output: HTMLOutputElement,
  unit: 'ms' | 'px' | '',
  field: NumericSettingField,
): void {
  input.addEventListener('input', () => {
    const value = Number(input.value);
    output.textContent = unit === '' ? String(value) : `${value} ${unit}`;
    void commit(api, { [field]: value });
  });
}

function disableControls(message: string): void {
  durationInput.disabled = true;
  sizeInput.disabled = true;
  offsetXInput.disabled = true;
  offsetYInput.disabled = true;
  smoothingInput.disabled = true;
  hideSystemCursorInput.disabled = true;
  resetOffsetsButton.disabled = true;
  chooseSkinButton.disabled = true;
  resetSkinButton.disabled = true;
  closeButton.disabled = true;
  setStatus(message, 'error');
}

async function boot(): Promise<void> {
  const api = window.knifeSettings;
  if (!api) {
    disableControls('设置桥接不可用：preload 未加载。');
    return;
  }

  bindSlider(api, durationInput, durationValue, 'ms', 'inspectionDurationMs');
  bindSlider(api, sizeInput, sizeValue, 'px', 'knifeDisplaySize');
  bindSlider(api, offsetXInput, offsetXValue, 'px', 'offsetX');
  bindSlider(api, offsetYInput, offsetYValue, 'px', 'offsetY');
  bindSlider(api, smoothingInput, smoothingValue, '', 'smoothingLevel');

  hideSystemCursorInput.addEventListener('change', () => {
    const hidden = hideSystemCursorInput.checked;
    void commit(
      api,
      { hideSystemCursor: hidden },
      hidden ? '正在隐藏系统光标…' : '正在恢复系统光标…',
    );
  });

  resetOffsetsButton.addEventListener('click', () => {
    offsetXInput.value = '0';
    offsetYInput.value = '0';
    offsetXValue.textContent = '0 px';
    offsetYValue.textContent = '0 px';
    void commit(api, { offsetX: 0, offsetY: 0 });
  });

  chooseSkinButton.addEventListener('click', () => {
    void runSkinAction(
      api,
      () => api.chooseSkin(),
      '正在打开素材文件夹…',
    );
  });

  resetSkinButton.addEventListener('click', () => {
    void runSkinAction(
      api,
      () => api.resetSkin(),
      '正在恢复内置素材…',
    );
  });

  closeButton.addEventListener('click', () => {
    window.close();
  });

  try {
    const [settings, skin] = await Promise.all([api.get(), api.getSkin()]);
    renderSettings(settings);
    renderSkin(skin);

    if (skin.error !== null) {
      setStatus(`已加载，但自定义素材不可用：${skin.error}`, 'error');
    } else {
      setStatus(`已加载 · ${describeSettings(settings)}`, 'idle');
    }

    console.log(
      `[settings] loaded ${describeSettings(settings)} ` +
        `skin=${skin.mode} frames=${skin.frameCount}`,
    );
  } catch (error) {
    console.error('[settings] initial load failed', error);
    disableControls(`读取配置失败：${describeError(error)}`);
  }
}

void boot();
```

## `src/index.css`

```css
:root {
  color-scheme: dark;
}

html,
body {
  width: 100%;
  height: 100%;
  margin: 0;
  padding: 0;
  overflow: hidden;
  background: transparent;
}

body {
  user-select: none;
  -webkit-user-drag: none;
}

/* Do not set cursor:none here at all. The global PowerShell helper hides the
   Windows cursor, and any CSS `none` in this full-screen click-through window
   can keep suppressing the arrow after the helper has restored it. When the
   helper is stopped, the real system cursor must be free to appear. */

/* The outer node is the cursor anchor. Keeping position on this node and the
   artwork scale/fade on its child means the player can never overwrite the
   translate3d() that follows the mouse. */
#cursor-proxy {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 2147483647;
  box-sizing: border-box;
  width: 96px;
  height: 96px;
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  contain: layout style paint;
  will-change: transform;
  transition: none;
  transform: translate3d(-100px, -100px, 0);
}

#cursor-proxy.is-visible {
  opacity: 1;
  visibility: visible;
}

.knife-visual {
  display: block;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  object-fit: contain;
  pointer-events: none;
  user-select: none;
  -webkit-user-drag: none;
  transform-origin: 50% 50%;
  backface-visibility: hidden;
  filter: drop-shadow(0 3px 4px rgba(0, 0, 0, 0.42));
  will-change: transform;
  opacity: 1;
  transform: none;
  transition: none;
}

#cursor-proxy.is-inspecting .knife-visual {
  opacity: 1;
}
```

## `src/settings.css`

```css
:root {
  color-scheme: dark;
  font-family:
    "Segoe UI",
    "Microsoft YaHei UI",
    system-ui,
    -apple-system,
    sans-serif;
  background: #171b22;
  color: #eef3f8;
}

* {
  box-sizing: border-box;
}

html,
body {
  min-width: 100%;
  min-height: 100%;
  margin: 0;
}

body {
  display: flex;
  align-items: flex-start;
  justify-content: center;
  min-height: 100vh;
  overflow-y: auto;
  padding: 7px;
  background:
    radial-gradient(circle at 80% -10%, rgba(110, 154, 190, 0.18), transparent 45%),
    #171b22;
  user-select: none;
}

.settings-card {
  width: 100%;
  max-width: 460px;
  margin: auto;
  padding: 16px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 14px;
  background: rgba(27, 32, 41, 0.96);
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.38);
}

.settings-header {
  margin-bottom: 10px;
}

.eyebrow {
  margin: 0 0 8px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.18em;
  color: #8fb4d0;
}

h1 {
  margin: 0;
  font-size: 26px;
  font-weight: 650;
  letter-spacing: 0.01em;
}

.subtitle {
  margin: 8px 0 0;
  font-size: 13px;
  line-height: 1.55;
  color: #9aa8b7;
}

.setting {
  padding: 8px 0;
  border-top: 1px solid rgba(255, 255, 255, 0.07);
}

.setting-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 5px;
}

.setting-head label {
  font-size: 15px;
  font-weight: 600;
}

output {
  min-width: 82px;
  padding: 5px 10px;
  border: 1px solid rgba(143, 180, 208, 0.28);
  border-radius: 999px;
  background: rgba(143, 180, 208, 0.1);
  color: #cfe4f4;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  text-align: center;
}

input[type="range"] {
  width: 100%;
  height: 18px;
  margin: 0;
  accent-color: #7fb8e6;
  cursor: pointer;
}

input[type="range"]:focus-visible {
  outline: 2px solid #9bd3ff;
  outline-offset: 4px;
  border-radius: 6px;
}

.range-hint {
  display: flex;
  justify-content: space-between;
  margin-top: 2px;
  font-size: 11px;
  color: #718091;
  font-variant-numeric: tabular-nums;
}

.status {
  min-height: 18px;
  margin: 8px 0 0;
  padding: 7px 10px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.04);
  font-size: 12px;
  line-height: 1.5;
  color: #9fb0c1;
}

.status[data-tone="busy"] {
  color: #d8c48e;
}

.status[data-tone="ok"] {
  color: #9fd8b4;
}

.status[data-tone="error"] {
  color: #f0a5a5;
  background: rgba(214, 96, 96, 0.12);
}

.toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.toggle-label {
  font-size: 15px;
  font-weight: 600;
}

.toggle-input {
  width: 20px;
  height: 20px;
  margin: 0;
  accent-color: #7fb8e6;
  cursor: pointer;
}

.toggle-input:focus-visible {
  outline: 2px solid #9bd3ff;
  outline-offset: 3px;
}

.setting-title {
  font-size: 15px;
  font-weight: 600;
}

.skin-badge {
  padding: 4px 9px;
  border: 1px solid rgba(143, 180, 208, 0.28);
  border-radius: 999px;
  background: rgba(143, 180, 208, 0.1);
  color: #cfe4f4;
  font-size: 11px;
  white-space: nowrap;
}

.skin-badge[data-mode="custom"] {
  border-color: rgba(120, 201, 160, 0.34);
  background: rgba(120, 201, 160, 0.12);
  color: #9fd8b4;
}

.skin-current {
  margin: 0 0 8px;
  min-height: 34px;
  padding: 7px 9px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.035);
  color: #9fb0c1;
  font-size: 11px;
  line-height: 1.5;
  white-space: pre-line;
  word-break: break-all;
}

.skin-current[data-tone="ok"] {
  color: #9fd8b4;
}

.skin-current[data-tone="error"] {
  color: #f0a5a5;
  background: rgba(214, 96, 96, 0.1);
}

.skin-actions {
  display: flex;
  gap: 8px;
}

.skin-actions button {
  flex: 1;
  min-width: 0;
  padding-left: 8px;
  padding-right: 8px;
}

.toggle-hint {
  margin: 6px 0 0;
  font-size: 11px;
  line-height: 1.55;
  color: #718091;
}

.offset-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 10px;
}

.offset-note {
  flex: 1;
  font-size: 11px;
  line-height: 1.4;
  color: #718091;
}

.settings-footer {
  display: flex;
  justify-content: flex-end;
  margin-top: 8px;
}

button {
  min-width: 92px;
  padding: 9px 18px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.08);
  color: #eef3f8;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

button:hover {
  background: rgba(255, 255, 255, 0.13);
}

.button-secondary {
  min-width: 128px;
  border-color: rgba(143, 180, 208, 0.26);
  background: rgba(143, 180, 208, 0.08);
  color: #cfe4f4;
}

button:focus-visible {
  outline: 2px solid #9bd3ff;
  outline-offset: 2px;
}

button:disabled {
  cursor: default;
  opacity: 0.45;
}
```

## `scripts/dev.js`

```ts
#!/usr/bin/env node
'use strict';

/*
 * Development launcher without Electron Forge.
 *
 * - Builds main/preload once with Vite.
 * - Starts the Vite renderer dev server (HMR for renderer/settings CSS/TS).
 * - Starts Electron with the dev server URL in KNIFE_CURSOR_DEV_SERVER_URL.
 *
 * Restart this command after changing src/main.ts or src/preload.ts; Vite
 * rebuilds them here, but Electron must be restarted to load new main code.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { build, createServer } = require('vite');

const projectRoot = path.resolve(__dirname, '..');

function ensureWritableDirectory(preferred) {
  const candidates = [
    preferred,
    path.join(projectRoot, '.userdata'),
    path.join(os.tmpdir(), 'knife-cursor-dev'),
  ];

  for (const candidate of new Set(candidates)) {
    try {
      fs.mkdirSync(candidate, { recursive: true });
      const probe = path.join(
        candidate,
        `.write-probe-${process.pid}-${Date.now()}`,
      );
      fs.writeFileSync(probe, 'probe');
      fs.unlinkSync(probe);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }

  return path.join(os.tmpdir(), 'knife-cursor-dev');
}

const userDataDir = ensureWritableDirectory(
  process.env.KNIFE_CURSOR_USER_DATA || path.join(projectRoot, '.userdata'),
);
const logPath = path.join(userDataDir, 'dev.log');

try {
  fs.writeFileSync(logPath, '', 'utf8');
} catch {
  // Logging must not stop development.
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  console.log(message);
  try {
    fs.appendFileSync(logPath, line, 'utf8');
  } catch {
    // Ignore.
  }
}

function appendOutput(streamName, chunk) {
  try {
    fs.appendFileSync(
      logPath,
      `\n--- ${streamName} ${new Date().toISOString()} ---\n${chunk}`,
      'utf8',
    );
  } catch {
    // Ignore.
  }
}

async function buildMainProcess() {
  fs.rmSync(path.join(projectRoot, '.vite', 'build'), {
    recursive: true,
    force: true,
  });

  for (const configFile of ['vite.main.config.ts', 'vite.preload.config.ts']) {
    log(`[dev] building ${configFile}`);
    await build({
      root: projectRoot,
      configFile: path.join(projectRoot, configFile),
      mode: 'development',
    });
  }
}

async function main() {
  const inheritedRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.KNIFE_CURSOR_USER_DATA = userDataDir;
  // Do not write crash.log into node_modules/electron/dist; electron-builder
  // copies that directory and would otherwise ship a stale development log.
  env.KNIFE_CURSOR_CRASH_DIR = userDataDir;
  env.ELECTRON_ENABLE_LOGGING = '1';

  log(
    `[dev] cwd=${projectRoot} userData=${userDataDir} ` +
      `inheritedRunAsNode=${inheritedRunAsNode ?? '(unset)'}`,
  );

  await buildMainProcess();

  const server = await createServer({
    root: projectRoot,
    configFile: path.join(projectRoot, 'vite.renderer.config.ts'),
    mode: 'development',
  });
  await server.listen();
  server.printUrls();

  const devServerUrl = server.resolvedUrls?.local?.[0];
  if (!devServerUrl) {
    throw new Error('Vite renderer dev server did not publish a local URL');
  }

  env.KNIFE_CURSOR_DEV_SERVER_URL = devServerUrl.replace(/\/+$/, '');

  const electronPath = require('electron');
  if (typeof electronPath !== 'string' || !fs.existsSync(electronPath)) {
    throw new Error(`Electron executable not found: ${String(electronPath)}`);
  }

  const args = [
    '.',
    `--user-data-dir=${userDataDir}`,
    '--enable-logging=stderr',
  ];

  const useNoSandbox = process.env.KNIFE_CURSOR_ENABLE_SANDBOX !== '1';
  if (useNoSandbox) {
    args.push('--no-sandbox');
  }

  if (process.env.KNIFE_CURSOR_DISABLE_GPU === '1') {
    args.push('--disable-gpu');
  }

  // npm start -- --remote-debugging-port=9222
  args.push(...process.argv.slice(2).filter((arg) => arg !== '--'));

  log(
    `[dev] electron=${electronPath} ` +
      `noSandbox=${useNoSandbox} url=${env.KNIFE_CURSOR_DEV_SERVER_URL}`,
  );

  const child = spawn(electronPath, args, {
    cwd: projectRoot,
    env,
    stdio: ['inherit', 'pipe', 'pipe'],
    windowsHide: false,
  });

  child.stdout.on('data', (chunk) => {
    process.stdout.write(chunk);
    appendOutput('stdout', chunk);
  });
  child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk);
    appendOutput('stderr', chunk);
  });

  child.on('error', (error) => {
    log(`[dev] failed to launch Electron: ${error.stack ?? error}`);
    void server.close();
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    log(
      `[dev] Electron exited code=${code ?? 'null'} ` +
        `signal=${signal ?? 'null'}`,
    );
    void server.close().finally(() => {
      process.exit(signal ? 0 : code ?? 0);
    });
  });

  for (const forwardedSignal of ['SIGINT', 'SIGTERM']) {
    process.on(forwardedSignal, () => {
      log(`[dev] received ${forwardedSignal}, stopping Electron`);
      if (!child.killed) {
        child.kill(forwardedSignal);
      }
    });
  }
}

main().catch((error) => {
  log(`[dev] failed: ${error.stack ?? error}`);
  process.exit(1);
});
```

## `scripts/build.js`

```ts
#!/usr/bin/env node
'use strict';

/*
 * Production build without Electron Forge.
 *
 * Outputs:
 *   .vite/build/main.js       main process
 *   .vite/build/preload.js    shared preload
 *   .vite/renderer/main_window/index.html
 *   .vite/renderer/main_window/settings.html
 */

const fs = require('node:fs');
const path = require('node:path');
const { build } = require('vite');

const projectRoot = path.resolve(__dirname, '..');
const viteDir = path.join(projectRoot, '.vite');

async function runBuild(configFile) {
  console.log(`[build] ${configFile}`);
  await build({
    root: projectRoot,
    configFile: path.join(projectRoot, configFile),
    mode: 'production',
  });
}

function requireFile(relativePath, minBytes = 1) {
  const absolutePath = path.join(projectRoot, relativePath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`missing build output: ${relativePath}`);
  }

  const size = fs.statSync(absolutePath).size;
  if (size < minBytes) {
    throw new Error(`build output is empty: ${relativePath}`);
  }

  console.log(`[build] ${relativePath} (${size} bytes)`);
}

async function main() {
  fs.rmSync(viteDir, { recursive: true, force: true });

  await runBuild('vite.main.config.ts');
  await runBuild('vite.preload.config.ts');
  await runBuild('vite.renderer.config.ts');

  requireFile('.vite/build/main.js', 1000);
  requireFile('.vite/build/preload.js', 1000);
  requireFile('.vite/renderer/main_window/index.html', 100);
  requireFile('.vite/renderer/main_window/settings.html', 100);

  console.log('[build] complete');
}

main().catch((error) => {
  console.error('[build] failed', error);
  process.exit(1);
});
```

## `scripts/verify-package.js`

```ts
#!/usr/bin/env node
'use strict';

/*
 * Verify the electron-builder --dir output before zipping/distributing.
 * The native hook is useless if uiohook-napi's .node file stayed inside
 * app.asar or was omitted by the files allowlist.
 */

const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const resources = path.join(projectRoot, 'dist', 'win-unpacked', 'resources');
const appAsar = path.join(resources, 'app.asar');
const nativeBinding = path.join(
  resources,
  'app.asar.unpacked',
  'node_modules',
  'uiohook-napi',
  'prebuilds',
  'win32-x64',
  'node.napi.node',
);
const nodeGypBuild = path.join(
  resources,
  'app.asar.unpacked',
  'node_modules',
  'node-gyp-build',
);

function requirePath(target, kind) {
  if (!fs.existsSync(target)) {
    throw new Error(`missing ${kind}: ${target}`);
  }

  const stats = fs.statSync(target);
  if (kind === 'file' && stats.size === 0) {
    throw new Error(`empty file: ${target}`);
  }

  console.log(`[verify] ${kind}: ${target} (${stats.isFile() ? stats.size : 'dir'})`);
}

function main() {
  requirePath(appAsar, 'file');
  requirePath(nativeBinding, 'file');
  requirePath(nodeGypBuild, 'dir');

  const size = fs.statSync(nativeBinding).size;
  if (size < 100_000) {
    throw new Error(
      `native binding is unexpectedly small (${size} bytes); ` +
        'check the x64 prebuild and electron-builder asarUnpack',
    );
  }

  console.log('[verify] native hook unpacked correctly');
}

try {
  main();
} catch (error) {
  console.error(`[verify] failed: ${error.message}`);
  process.exit(1);
}
```

## `scripts/clean.js`

```ts
#!/usr/bin/env node
'use strict';

/*
 * Safe project cleanup.
 *
 * Default is a dry run: it only prints what would be removed. Pass --yes to
 * delete. `dist` and the old Forge `out` directory are kept unless --all (or
 * --dist) is given, because the packaged zip is a deliverable.
 *
 * Protected by construction: src/, assets/, scripts/, package.json,
 * package-lock.json, electron-builder.yml, all Vite configs, index.html,
 * settings.html, tsconfig.json, README.md and MATERIALS.md.
 */

const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const args = new Set(process.argv.slice(2));
const apply = args.has('--yes');
const removeDist = args.has('--all') || args.has('--dist');
const finalBundle = path.join(projectRoot, 'MILESTONE_FINAL_CODE.md');

const REQUIRED_PATHS = [
  'src',
  'assets',
  'scripts',
  'package.json',
  'package-lock.json',
  'electron-builder.yml',
  'vite.main.config.ts',
  'vite.preload.config.ts',
  'vite.renderer.config.ts',
  'index.html',
  'settings.html',
  'tsconfig.json',
  'README.md',
  'MATERIALS.md',
];

const protectedPaths = new Set(
  REQUIRED_PATHS.map((relativePath) => path.resolve(projectRoot, relativePath)),
);

const targets = [
  {
    relativePath: '.vite',
    description: 'Vite build output (recreated by npm run build/start)',
  },
  {
    relativePath: '.userdata',
    description: 'development userData, crash.log, dev.log and cursor helper files',
  },
  {
    relativePath: '.cursor-integration',
    description: 'cursor helper integration-test logs',
  },
  {
    relativePath: 'crash.log',
    description: 'old crash log at project root',
  },
  {
    relativePath: 'system-cursor.log',
    description: 'old cursor helper log at project root',
  },
  {
    relativePath: 'dev.log',
    description: 'old development log at project root',
  },
  {
    relativePath: 'forge-output.log',
    description: 'old Forge packaging log',
  },
  {
    relativePath: 'launcher.log',
    description: 'old launcher log',
  },
  {
    relativePath: path.join('node_modules', 'electron', 'dist', 'crash.log'),
    description: 'stale crash.log copied into the Electron distribution',
  },
  {
    relativePath: 'out',
    description: 'old Electron Forge output',
    optional: true,
  },
  {
    relativePath: 'dist',
    description: 'electron-builder output (zip/unpacked app)',
    optional: true,
    keepByDefault: true,
  },
];

const ROOT_JUNK_PATTERNS = [
  /^\.cursor-.*/,
  /^\.detached-.*/,
  /^\.terminal-close-.*/,
  /^\.capture-.*/,
  /^\.pkgtest$/,
  /^\.packaged-test$/,
  /^\.finaltest$/,
];

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function pathSize(targetPath) {
  let total = 0;

  try {
    const stat = fs.lstatSync(targetPath);
    if (!stat.isDirectory()) {
      return stat.size;
    }

    for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
      total += pathSize(path.join(targetPath, entry.name));
    }
  } catch {
    return total;
  }

  return total;
}

function isInsideProject(targetPath) {
  const relative = path.relative(projectRoot, targetPath);
  return (
    relative !== '' &&
    !relative.startsWith('..') &&
    !path.isAbsolute(relative)
  );
}

function assertSafe(targetPath) {
  if (!isInsideProject(targetPath)) {
    throw new Error(`refusing to touch a path outside the project: ${targetPath}`);
  }
  if (targetPath === projectRoot) {
    throw new Error('refusing to delete the project root');
  }
  if (protectedPaths.has(targetPath)) {
    throw new Error(`refusing to delete protected path: ${targetPath}`);
  }
}

const planned = [];
const plannedPaths = new Set();

function plan(relativePath, description, optional = false) {
  const absolutePath = path.resolve(projectRoot, relativePath);
  if (!fs.existsSync(absolutePath) || plannedPaths.has(absolutePath)) {
    return;
  }

  assertSafe(absolutePath);
  plannedPaths.add(absolutePath);
  planned.push({ absolutePath, description, optional });
}

for (const target of targets) {
  if (target.keepByDefault && !removeDist) {
    continue;
  }
  plan(target.relativePath, target.description, target.optional === true);
}

for (const entry of fs.readdirSync(projectRoot, { withFileTypes: true })) {
  if (ROOT_JUNK_PATTERNS.some((pattern) => pattern.test(entry.name))) {
    plan(entry.name, 'temporary test artifact');
  }
}

const milestones = fs
  .readdirSync(projectRoot, { withFileTypes: true })
  .filter(
    (entry) =>
      entry.isFile() &&
      /^MILESTONE.*\.md$/i.test(entry.name) &&
      entry.name !== 'MILESTONE_FINAL_CODE.md',
  );

if (milestones.length > 0 && !fs.existsSync(finalBundle)) {
  console.warn(
    'MILESTONE_FINAL_CODE.md is missing. Old milestone files will be kept so ' +
      'the final source bundle is not lost. Create the final bundle first.',
  );
} else {
  for (const entry of milestones) {
    plan(entry.name, 'superseded milestone source bundle');
  }
}

planned.sort((left, right) =>
  left.absolutePath.localeCompare(right.absolutePath),
);

if (planned.length === 0) {
  console.log('Nothing to clean.');
  process.exit(0);
}

let totalBytes = 0;

console.log(
  apply
    ? 'Cleanup plan (will delete):'
    : 'Cleanup plan (dry run; pass --yes to delete):',
);

for (const item of planned) {
  const bytes = pathSize(item.absolutePath);
  totalBytes += bytes;
  console.log(`  - ${path.relative(projectRoot, item.absolutePath)}`);
  console.log(`      ${item.description}; ${formatBytes(bytes)}`);
}

console.log(`\nTotal: ${formatBytes(totalBytes)} in ${planned.length} item(s).`);
console.log('\nAlways kept:');
for (const requiredPath of REQUIRED_PATHS) {
  console.log(`  + ${requiredPath}`);
}
if (!removeDist) {
  console.log('  + dist (packaged artifact; use --all to remove it)');
}

if (!apply) {
  console.log('\nDry run only. Review the list, then run:');
  console.log('  npm run clean:apply');
  console.log('To also remove dist:');
  console.log('  npm run clean:all');
  process.exit(0);
}

let failures = 0;
for (const item of planned) {
  try {
    fs.rmSync(item.absolutePath, { recursive: true, force: true });
    console.log(`removed ${path.relative(projectRoot, item.absolutePath)}`);
  } catch (error) {
    failures += 1;
    console.error(
      `failed to remove ${path.relative(projectRoot, item.absolutePath)}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

if (failures > 0) {
  console.error(`\n${failures} item(s) could not be removed. Close the app and retry.`);
  process.exit(1);
}

console.log('\nCleanup complete.');
```

## `assets/system-cursor.ps1`

```powershell
param(
  [int]$ParentPid = 0,
  [string]$CursorPath = '',
  [string]$StopPath = '',
  [string]$LogPath = '',
  [switch]$RestoreOnly
)

$ErrorActionPreference = 'SilentlyContinue'

function Write-HelperLog([string]$Message) {
  if (-not $LogPath) {
    return
  }

  try {
    $line = '[' + (Get-Date).ToUniversalTime().ToString('o') + '] ' + $Message
    Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
  } catch {
    # Logging must not stop the cursor guard.
  }
}

Write-HelperLog "start parent=$ParentPid cursor=$CursorPath stop=$StopPath restoreOnly=$RestoreOnly"
Write-HelperLog "env TEMP=$env:TEMP TMP=$env:TMP cwd=$((Get-Location).Path) ps=$($PSVersionTable.PSVersion)"

try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class KnifeCursorNative
{
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT
    {
        public int X;
        public int Y;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr LoadCursorFromFile(string path);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetSystemCursor(IntPtr hcur, uint id);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SystemParametersInfo(uint action, uint param, IntPtr data, uint flags);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetCursorPos(out POINT point);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr LoadCursor(IntPtr hInstance, IntPtr cursorName);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SetCursor(IntPtr hCursor);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern void mouse_event(
        uint flags,
        int dx,
        int dy,
        uint data,
        UIntPtr extraInfo);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr WindowFromPoint(POINT point);

    [DllImport("user32.dll", EntryPoint = "SendMessageTimeout", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr SendMessageTimeoutCursor(
        IntPtr hWnd,
        uint msg,
        IntPtr wParam,
        IntPtr lParam,
        uint flags,
        uint timeout,
        out UIntPtr result);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr SendMessageTimeout(
        IntPtr hWnd,
        uint msg,
        UIntPtr wParam,
        string lParam,
        uint flags,
        uint timeout,
        out UIntPtr result);
}
'@ -ErrorAction Stop
} catch {
  Write-HelperLog "Add-Type failed: $($_.Exception.Message)"
  exit 1
}

# Every standard Windows cursor id. Replacing only OCR_NORMAL leaves the I-beam,
# hand and resize arrows visible over text fields and window borders.
$cursorIds = @(
  32512, 32513, 32514, 32515, 32516,
  32631, 32640, 32641, 32642, 32643, 32644,
  32645, 32646, 32647, 32648, 32649, 32650, 32651
)

$cursorRegistryNames = @{
  32512 = 'Arrow'
  32513 = 'IBeam'
  32514 = 'Wait'
  32515 = 'Crosshair'
  32516 = 'UpArrow'
  32631 = 'Pin'
  32640 = 'SizeAll'
  32641 = 'Icon'
  32642 = 'SizeNWSE'
  32643 = 'SizeNESW'
  32644 = 'SizeWE'
  32645 = 'SizeNS'
  32646 = 'SizeAll'
  32647 = 'Icon'
  32648 = 'No'
  32649 = 'Hand'
  32650 = 'AppStarting'
  32651 = 'Help'
}

$script:cursorScheme = Get-ItemProperty `
  -Path 'HKCU:\Control Panel\Cursors' `
  -ErrorAction SilentlyContinue

$defaultArrow = Join-Path $env:SystemRoot 'Cursors\aero_arrow.cur'
if (-not (Test-Path -LiteralPath $defaultArrow)) {
  $defaultArrow = Join-Path $env:SystemRoot 'Cursors\arrow.cur'
}
if (-not (Test-Path -LiteralPath $defaultArrow)) {
  $defaultArrow = ''
}

function Get-CursorPath([int]$CursorId) {
  $name = $cursorRegistryNames[$CursorId]
  if ($name -and $null -ne $script:cursorScheme) {
    $property = $script:cursorScheme.PSObject.Properties[$name]
    if ($null -ne $property) {
      $raw = [string]$property.Value
      if ($raw) {
        $expanded = [Environment]::ExpandEnvironmentVariables($raw)
        if (Test-Path -LiteralPath $expanded) {
          return $expanded
        }
      }
    }
  }

  return $defaultArrow
}

function Set-CursorFromFile([string]$Path, [uint32]$CursorId) {
  if (-not $Path) {
    Write-HelperLog "restore: no cursor file for id=$CursorId"
    return $false
  }

  $handle = [KnifeCursorNative]::LoadCursorFromFile($Path)
  if ($handle -eq [IntPtr]::Zero) {
    Write-HelperLog "restore: LoadCursorFromFile failed id=$CursorId path=$Path"
    return $false
  }

  $ok = [KnifeCursorNative]::SetSystemCursor($handle, $CursorId)
  if (-not $ok) {
    # SetSystemCursor destroys the handle, so there is nothing to free here.
    Write-HelperLog "restore: SetSystemCursor failed id=$CursorId path=$Path"
  }
  return $ok
}

function Restore-KnifeCursor {
  Write-HelperLog "restore: applying cursor files; arrow=$defaultArrow"

  # Do not rely on SPI_SETCURSORS alone. It reloads the registry scheme but on
  # Windows 11 the current pointer can keep the blank handle until it is
  # re-set. Restore the real files for every cursor id first.
  foreach ($id in $cursorIds) {
    $path = Get-CursorPath -CursorId $id
    [void](Set-CursorFromFile -Path $path -CursorId ([uint32]$id))
  }

  # Reload the user's scheme. This also broadcasts WM_SETTINGCHANGE, but we
  # send an explicit Cursor broadcast below for shells that ignore it.
  [KnifeCursorNative]::SystemParametersInfo(0x0057, 0, [IntPtr]::Zero, 3) | Out-Null

  # The normal arrow is the one users notice. Force a real aero arrow after the
  # scheme reload, even if the scheme's Arrow value is empty or custom.
  if ($defaultArrow) {
    [void](Set-CursorFromFile -Path $defaultArrow -CursorId 32512)
  }

  # SetSystemCursor changes the cursor table; it does not necessarily change
  # the currently displayed handle. SetCursor + a real one-pixel mouse move
  # forces the window under the pointer to process WM_SETCURSOR again.
  $arrow = [KnifeCursorNative]::LoadCursor([IntPtr]::Zero, [IntPtr]32512)
  if ($arrow -ne [IntPtr]::Zero) {
    [KnifeCursorNative]::SetCursor($arrow) | Out-Null
  }

  $broadcastResult = [UIntPtr]::Zero
  [KnifeCursorNative]::SendMessageTimeout(
    [IntPtr]0xffff,
    0x001A,
    [UIntPtr]::Zero,
    'Cursor',
    2,
    100,
    [ref]$broadcastResult
  ) | Out-Null

  $point = [KnifeCursorNative+POINT]::new()
  if ([KnifeCursorNative]::GetCursorPos([ref]$point)) {
    # The current cursor can still point at the destroyed transparent handle
    # even after SetSystemCursor succeeds. Ask the window under the pointer to
    # process WM_SETCURSOR again so Windows installs a fresh, valid arrow.
    $under = [KnifeCursorNative]::WindowFromPoint($point)
    if ($under -ne [IntPtr]::Zero) {
      # lParam = MAKELPARAM(HTCLIENT, WM_MOUSEMOVE)
      $cursorLParam = [IntPtr]((0x0200 -shl 16) -bor 1)
      $cursorResult = [UIntPtr]::Zero
      [KnifeCursorNative]::SendMessageTimeoutCursor(
        $under,
        0x0020,
        $under,
        $cursorLParam,
        2,
        100,
        [ref]$cursorResult
      ) | Out-Null
      Write-HelperLog "restore: WM_SETCURSOR sent hwnd=$under"
    }

    # mouse_event is closer to real input than SetCursorPos on Windows 11;
    # some shells ignore a programmatic SetCursorPos but redraw for a move.
    [KnifeCursorNative]::mouse_event(0x0001, 1, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 40
    [KnifeCursorNative]::mouse_event(0x0001, -1, 0, 0, [UIntPtr]::Zero)
    Write-HelperLog "restore: pointer refresh at $($point.X),$($point.Y)"
  } else {
    Write-HelperLog 'restore: GetCursorPos failed; pointer refresh skipped'
  }

  # Last resort from the Windows shell: reload the per-user cursor scheme.
  # This is deliberately fire-and-forget; waiting on rundll32 can stall exit.
  try {
    Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\rundll32.exe') `
      -ArgumentList 'user32.dll,UpdatePerUserSystemParameters' `
      -WindowStyle Hidden | Out-Null
    Write-HelperLog 'restore: UpdatePerUserSystemParameters requested'
  } catch {
    Write-HelperLog "restore: rundll32 failed: $($_.Exception.Message)"
  }

  Write-HelperLog 'restore: complete'
}

if ($RestoreOnly) {
  Write-HelperLog 'restore-only'
  Restore-KnifeCursor
  exit 0
}

try {
  Write-HelperLog 'replacing cursor ids'
  foreach ($id in $cursorIds) {
    $handle = [KnifeCursorNative]::LoadCursorFromFile($CursorPath)
    if ($handle -ne [IntPtr]::Zero) {
      $ok = [KnifeCursorNative]::SetSystemCursor($handle, [uint32]$id)
      if (-not $ok) {
        Write-HelperLog "SetSystemCursor failed id=$id"
      }
    } else {
      Write-HelperLog "LoadCursorFromFile failed id=$id"
    }
  }
  Write-HelperLog 'cursor ids replaced; entering wait loop'

  # Stay alive with the overlay so a crash, task-manager kill or normal quit
  # still restores the user's real cursor. The main process can also request a
  # prompt restore by creating the stop file.
  #
  # Parent PID alone is not enough. If Electron is killed by closing the
  # terminal, Windows may terminate the whole console process group before the
  # parent check gets a chance to run. This guard is started through
  # Start-Process (a separate console), so it survives that close; once the
  # parent disappears it waits at most five seconds, then force-restores.
  $parentMissingSince = $null
  $maxParentMissingSeconds = 5

  while ($true) {
    if ($StopPath -and (Test-Path -LiteralPath $StopPath)) {
      Write-HelperLog 'stop file detected'
      break
    }

    if ($ParentPid -gt 0) {
      $parent = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
      if ($null -eq $parent) {
        if ($null -eq $parentMissingSince) {
          $parentMissingSince = [DateTime]::UtcNow
          Write-HelperLog "parent process $ParentPid not found; waiting up to ${maxParentMissingSeconds}s before restore"
        } elseif (([DateTime]::UtcNow - $parentMissingSince).TotalSeconds -ge $maxParentMissingSeconds) {
          Write-HelperLog "parent process $ParentPid still missing after ${maxParentMissingSeconds}s; forcing restore"
          break
        }
      } else {
        $parentMissingSince = $null
      }
    }

    Start-Sleep -Milliseconds 200
  }
}
catch {
  Write-HelperLog "caught: $($_.Exception.Message)"
}
finally {
  Write-HelperLog 'restoring and exiting'
  Restore-KnifeCursor
}
```
