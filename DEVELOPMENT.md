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

### 覆盖层层级（Z-order）

覆盖层使用 Electron 在 Windows 上的最高常规层级 `screen-saver`：

```ts
overlayWindow.setAlwaysOnTop(true, 'screen-saver');
overlayWindow.moveTop();
overlayWindow.setIgnoreMouseEvents(true, { forward: true });
```

这三句的组合顺序很重要：层级只设置一次不够，设置窗口、任务栏或开始菜单获得焦点时，Windows 会重排 topmost band。主进程因此会在以下时机重新执行 `setAlwaysOnTop` → `moveTop` → `setIgnoreMouseEvents`：

- 覆盖层 `ready-to-show` / `did-finish-load`；
- 设置窗口的 `focus`、`ready-to-show`、`did-finish-load`，以及重复打开设置窗口；
- 鼠标坐标每次更新（约 5 次/秒）；
- 任意全局 keydown / mousedown；
- 500 ms watchdog 兜底，覆盖 Win 键打开开始菜单、任务栏自动弹出这类 uiohook 可能收不到的事件。

设置窗口本身明确 `alwaysOnTop: false`，并在创建后再次 `setAlwaysOnTop(false)`；它永远不会抢覆盖层的 topmost 层级。提升后立即恢复 `setIgnoreMouseEvents(true, { forward: true })`，所以覆盖层仍然完全点击穿透。

不引入 `ffi-napi` / `ref-napi`：Electron 在 Windows 上已经把 `setAlwaysOnTop(..., 'screen-saver')` 映射到 `HWND_TOPMOST`，`moveTop()` 映射到 `SetWindowPos(HWND_TOP, ...)`。自建原生绑定反而会新增 ABI、签名和解包风险。UAC 安全桌面、锁屏等 secure desktop 不属于普通桌面层级，任何普通用户态窗口都无法覆盖，这是 Windows 的设计限制。

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
27. 打开设置窗口并切换焦点：日志出现 `z-order raised reason=settings-focus count=1`（或 `settings-loaded`）；蝴蝶刀始终在设置窗口之上，设置窗口本身不是 always-on-top。
28. 打开 Windows 11 任务栏/开始菜单并在其上来回移动鼠标：日志持续出现 `z-order raised reason=cursor-move` / `watchdog`；正常桌面下蝴蝶刀保持在任务栏和开始菜单之上。UAC/锁屏属于 secure desktop，不在覆盖范围内。