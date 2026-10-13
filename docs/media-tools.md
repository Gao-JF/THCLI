[English](./media-tools.en.md) | 简体中文

# 媒体处理工具（`+tool` / `tools`）

通过 TokenHub 网关的媒体处理接口，对**图片 / 视频 / 音频**做 AI 处理：超分、抠图、扩图、擦除、转码、增强、插帧、打码、翻译配音、降噪、人声分离等。

命令分两组：

| 命令 | 前缀 | 用途 | 联网 |
|---|---|---|---|
| `tools list` | 无 | 列出可用工具（本地元数据） | 否 |
| `+tool <tool_id> …` | `+` | 真正提交并处理媒体 | 是 |

> `+` 前缀表示**会真正打到数据面**（与 `+chat` 一致）；`tools` 是管控面命令，只做本地展示。

---

## 1. 快速上手

```shell
# 1. 看有哪些工具（--json 给机读 schema，见 §4）
thcli tools list

# 2. 准备数据面 API Key
thcli key create --name mykey --scope all       # 在云端创建一把 Key
thcli chat-config set --value <明文>             # 存到本机，供 +chat / +tool 调用

# 3. 提交任务（默认异步，立即返回 task_id）
thcli +tool image-cutout https://example.com/a.png --version cutout-1.0-flash

# 4. 取结果
thcli +tool task image-cutout <task_id>
```

> `+tool` 与 `+chat` 用的是**同一把数据面 API Key**（本地存在 `chat-config`）。
> 若你已为 `+chat` 配过，第 2 步可跳过。

输入地址（作为位置参数传入）支持两种写法：

| 写法 | 示例 |
|---|---|
| 公网 URL | `https://example.com/a.png` |
| base64 | `data:image/png;base64,iVBORw0KGgo...` |

URL 必须**公网可访问**；内网地址或需鉴权的 URL 会失败，此时改用 base64。

---

## 2. 异步（默认）与同步等待

Tool 接口本身**全是异步任务**（提交 → 轮询）。媒体任务耗时可能很长（视频 / 音频几小时都可能），
所以 CLI **默认不帮你等**——提交后立即返回 `task_id`，由你决定何时取结果。

### 异步（默认）

```shell
thcli +tool image-erase https://example.com/a.png --prompt "擦除右下角水印"
```

```
已提交: task_id=221073-ProcessImageAsync-xxx          ← stderr（任何模式都会打，见下）
已创建任务
  task_id:    221073-ProcessImageAsync-xxx
  request_id: 8f3a...                                  ← stdout

查询：thcli +tool task image-erase 221073-ProcessImageAsync-xxx
```

> **提交成功后，`task_id` 会无条件打到 stderr**（含 `--json` 模式）。这样即使进程随后
> 被外部超时杀掉、或你只捕获了 stdout，也能从 stderr 找回 `task_id`，任务不会变成
> 「在跑、扣了额度、却查不到」的孤儿。Agent 尤其应当捕获 stderr。

### 同步等待（`--wait`）

想一条命令直接拿结果时加 `--wait`：提交后 CLI 内部轮询到终态，打印结果地址。

```shell
thcli +tool image-super-resolution https://example.com/a.png --mode percent --percent 2 --wait
```

> ⚠️ **Agent 慎用 `--wait`**：媒体任务耗时可能超过你的单命令超时，进程会被强杀。
> 若一定要用，请把 `--timeout` 设成**小于你的 shell/agent 超时**，CLI 会在此之前
> 优雅退出并提示 `task_id`（且 stderr 里已有该 `task_id`）。

### 查询任务

```shell
thcli +tool task <tool_id> <task_id>
```

只查**一次快照**、不轮询，打印当前状态（可能仍是 `in_progress`）；已完成则同时给出结果地址。`<tool_id>` 用提交时那个（同一工具的任务查询路径不同）。要一次拿到终态结果用提交时的 `--wait`。

---

## 3. 通用选项

所有工具都支持：

| 选项 | 说明 |
|---|---|
| `--wait` | 同步等待：提交后轮询到终态并打印结果（**默认异步，只提交**） |
| `--interval <sec>` | 轮询间隔，默认 `3` |
| `--timeout <sec>` | 轮询超时（秒），**仅 `--wait` 生效**。默认按工具类型：图片 `600` / 视频音频 `1800` |
| `--alias <alias>` | API Key 别名，默认 `default` |
| `--area <area>` | 地域，默认 `gz` |
| `--api-key <key>` | 临时指定 API Key（默认取本地 chat-config） |

全局选项（`--json` / `--profile` / `--site` / `--region` / `--lang` 等）在所有命令上都可用，见主 README。

---

## 4. 工具清单

### 图片工具（`image-*`）

| tool_id | 能力 | 必填参数 |
|---|---|---|
| `image-super-resolution` | 图片超分（放大 / 高清化） | 场景相关，见下 |
| `image-outpainting` | AI 扩图（换宽高比 / 补画布） | 无（可全默认） |
| `image-cutout` | AI 抠图（去背景，输出透明底） | `--version` |
| `image-erase` | 擦除（水印 / 文字） | `--prompt` |

### 视频工具（`video-*`）

| tool_id | 能力 | 必填参数 |
|---|---|---|
| `video-transcode` | 极速高清转码 / 压缩 | 无 |
| `video-enhance-premium` | 大模型增强（生成式画质增强） | 无 |
| `video-interpolate-frames` | 插帧（补帧到目标帧率） | `--fps` |
| `video-enhance-color` | 色彩增强（调色） | 无 |
| `video-erase` | 擦除（去字幕等） | 无 |
| `video-privacy-mask` | 隐私打码（人脸 / 车牌模糊） | 无 |
| `dubbing` | AI 翻译配音 | `--dst-language` |

### 音频工具（`audio-*`）

| tool_id | 能力 | 必填参数 |
|---|---|---|
| `audio-denoise` | 降噪 | 无 |
| `audio-separate` | 人声背景声分离 | `--track` |

> 图片增强（`image-enhance`）当前网关**未上线**，`tools list` 不列出。

### 机读 schema（`tools list --json`）

供脚本与 AI Agent 使用，一次调用即可拿到每个工具的完整参数定义（名称 / flag / 类型 /
是否必填 / 枚举 / 默认 / 说明），**无需解析人类可读的 `--help`**：

```shell
thcli tools list --json
```

```json
[
  {
    "id": "image-cutout",
    "category": "image",
    "description": "图片 AI 抠图（去背景，输出透明底）",
    "input": { "field": "image_url", "required": true },
    "params": [
      { "name": "version", "flag": "--version", "type": "string", "required": true,
        "description": "抠图模型", "choices": ["cutout-1.0-lite", "cutout-1.0-flash"] },
      { "name": "wait", "flag": "--wait", "type": "boolean", "required": false,
        "description": "同步等待：..." },
      { "name": "interval", "flag": "--interval", "type": "int", "required": false, "default": 3 },
      { "name": "timeout", "flag": "--timeout", "type": "int", "required": false, "default": 600 }
    ]
  }
]
```

> 人类可读的参数说明仍以 `thcli +tool <tool_id> --help` 为准。

---

## 5. 各工具参数

### 5.1 图片超分 `image-super-resolution`

按场景组合 `--mode` 与尺寸参数：

| 场景 | 参数 |
|---|---|
| 按倍率 | `--mode percent --percent 2`（放大 2 倍） |
| 指定分辨率 | `--mode fixed`，尺寸用 `--width` / `--height`（精确宽高），或用 `--long-side` / `--short-side`（约束单边，另一边等比缩放） |
| 自适应 | `--mode aspect --short-side 1440` |

```shell
thcli +tool image-super-resolution https://example.com/a.png --mode percent --percent 2
thcli +tool image-super-resolution https://example.com/a.png --mode fixed --width 1920 --height 1080
```

- `--type`：算法，`standard` / `super` / `ultra`（默认）。如无必要不要传，默认即推荐效果。

### 5.2 图片扩图 `image-outpainting`

三个参数都可选，可单独或组合传：

```shell
thcli +tool image-outpainting https://example.com/a.png --aspect-ratio 16:9
thcli +tool image-outpainting https://example.com/a.png --width 1280
thcli +tool image-outpainting https://example.com/a.png --aspect-ratio 16:9 --width 1280
```

- `--aspect-ratio`：`1:1` `3:2` `2:3` `3:4` `4:3` `4:5` `5:4` `9:16` `16:9` `21:9`

### 5.3 图片抠图 `image-cutout`

```shell
thcli +tool image-cutout https://example.com/a.png --version cutout-1.0-flash
```

- `--version`（**必填**）：`cutout-1.0-lite`（最快）/ `cutout-1.0-flash`（质量-速度平衡）
- 未指定模型时推荐 `cutout-1.0-flash`；要快用 `cutout-1.0-lite`

### 5.4 图片擦除 `image-erase`

```shell
thcli +tool image-erase https://example.com/a.png --prompt "擦除画面右下角的水印"
```

- `--prompt`（**必填**）：自然语言描述擦除目标
- 走 agent 链路，**耗时明显长于其它图片工具**（其它约 2 分钟）
- 若图上无描述目标或服务端 agent 不可用，任务以 `failed` 结束，**不要重试同一个请求**

### 5.5 视频转码 `video-transcode`

```shell
thcli +tool video-transcode https://example.com/a.mp4 --resolution 1920x1080
thcli +tool video-transcode https://example.com/a.mp4 --compress-type ultra_compress   # 极致压缩，额外计费
thcli +tool video-transcode https://example.com/a.mp4 --remove-audio
```

输出规格：`--resolution`（`"宽x高"`）/ `--container`（`MP4`）/ `--codec`（`H264`/`H265`/`AV1`）/ `--max-video-bitrate` / `--fps`。

### 5.6 视频大模型增强 `video-enhance-premium`

```shell
thcli +tool video-enhance-premium https://example.com/a.mp4
```

参数均可选：输出规格（`--resolution` / `--container` / `--codec` / `--max-video-bitrate` / `--fps`）。

### 5.7 视频插帧 `video-interpolate-frames`

```shell
thcli +tool video-interpolate-frames https://example.com/a.mp4 --fps 60
```

- `--fps`（**必填**）：目标帧率，> 0
- 另有输出规格：`--resolution` / `--container` / `--codec` / `--max-video-bitrate`

### 5.8 视频色彩增强 `video-enhance-color`

```shell
thcli +tool video-enhance-color https://example.com/a.mp4 --level Strong
```

参数均可选：输出规格 + `--level`（`Weak`（默认，不传即此）/ `Normal` / `Strong`）。

### 5.9 视频擦除 `video-erase`

```shell
thcli +tool video-erase https://example.com/a.mp4 --version Premium
```

- `--version`：`Lite`（默认，轻量模型只擦字幕）/ `Premium`（大模型自动识别，价格高）

### 5.10 视频隐私打码 `video-privacy-mask`

```shell
thcli +tool video-privacy-mask https://example.com/a.mp4 --target FacePlate --effect Mosaic
```

- `--target`：`Face`（默认，仅人脸）/ `FacePlate`（人脸+车牌）
- `--effect`：`Blur`（默认）/ `Mosaic`

### 5.11 AI 翻译配音 `dubbing`

```shell
thcli +tool dubbing https://example.com/a.mp4 --dst-language en
```

- `--dst-language`（**必填**）：`zh` / `en`（源语言固定 auto、模型固定默认档）

### 5.12 音频降噪 `audio-denoise`

```shell
thcli +tool audio-denoise https://example.com/a.mp3 --container mp3
```

音频输出规格：`--container`（`m4a` 默认 / `mp3` / `flac` / `ogg`）/ `--codec`（`aac` 默认 / `mp3` / `flac` / `ac3`）/ `--sample-rate`（`44100` 默认 / `32000` / `48000`）。

### 5.13 人声背景声分离 `audio-separate`

```shell
thcli +tool audio-separate https://example.com/a.mp3 --track Vocal
```

- `--track`（**必填**）：`Vocal` 人声 / `Background` 背景声（两者互斥，只能选一个）
- `--scene`：`Normal`（默认）/ `Music`（哑参数，暂未生效）

---

## 6. 输出

- **默认（异步）stdout**：`task_id` + `request_id`（`--json` 时为 `{task_id, status, request_id}`）
- **`--wait` 成功 stdout**：结果地址（`output.file_url`）；`--json` 时为网关原始响应
- **stderr**：提交后**无条件**打印 `task_id`；`--wait` 下还有进度与错误信息
- **退出码**：`0` 成功 / `1` 参数或业务错误 / `130` 用户中断

`--wait` 成功示例（`--json`）：

```json
{
  "task_id": "221073-ProcessImageAsync-xxx",
  "status": "completed",
  "progress": 100,
  "output": {
    "file_id": "387702305799999",
    "file_url": "https://.../out.png",
    "file_type": "png",
    "media_name": "ProcessImageFile"
  }
}
```

> 视频 / 音频工具的查询响应，`output` 只含 `file_url`（不含 `file_id` / `file_type` / `media_name`）。

失败时 `status` 为 `failed`，`error` 给出原因：

```json
{"task_id": "...", "status": "failed", "error": {"code": "InternalError", "message": "..."}}
```

---

## 7. 状态与错误

### 状态机

| 状态值 | 是否终态 | 描述 |
|---|---|---|
| `queued` | 否 | 已排队 |
| `in_progress` | 否 | 处理中 |
| `completed` | 是 | 成功，`output` 有内容 |
| `failed` | 是 | 失败，看 `error` |

### 错误码

| HTTP | type | 含义 |
|---|---|---|
| 400 | `invalid_request_error` | 参数错误：地址缺失/非法、枚举非法、必填缺失、未知字段、task_id 不存在 |
| 401 | `invalid_api_key` | apikey 缺失或无效 |
| 404 | `not_found` | 路径不存在 |
| 405 | `method_not_allowed` | 方法不允许 |
| 429 | `rate_limit_exceeded` | QPS 超限 |
| 429 | `quota_exceeded` | 配额用尽 |
| 500 | `server_error` | 服务内部错误 |

已知错误码会附上原因与修复建议；未知码可用 `thcli doctor error <code>` 查。

> 参数错误在网关侧就被拦下（不消耗额度、不产生任务）。

---

## 8. 注意事项

- 处理完成后把 `output.file_url` 交给用户。
- 失败时如实转达原因，**不要重试同一个请求**（参数错误重试也不会成功）。
- 多步处理（如先抠图再扩图）时，把上一步的 `output.file_url` 作为下一步的输入地址传入。
- 不要并发轮询同一个任务；一个任务一个轮询循环。
- base64 内容不要打进日志或回显。
- 限频：提交默认 `20 QPS`、查询默认 `100 QPS`（per appid）。

---

## 9. 相关资源

- 各工具参数以 `thcli +tool <tool_id> --help` 为准
- 网关侧图片处理接入文档：`vod-gateway/docs/imageprocess/README.md`
- 其它 Agent Skills 形态的同类能力：`tencent-tokenhub-tool`（Python，功能对齐）
