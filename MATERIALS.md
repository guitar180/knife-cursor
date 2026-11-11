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