English | [简体中文](./media-tools.md)

# Media Processing Tools (`+tool` / `tools`)

Process **images / videos / audio** through the TokenHub gateway's media APIs: super-resolution, cutout, outpainting, erase, transcode, enhance, frame interpolation, privacy mask, dubbing, denoise, vocal separation, and more.

Two command groups:

| Command | Prefix | Purpose | Network |
|---|---|---|---|
| `tools list` | none | List available tools (local metadata) | No |
| `+tool <tool_id> …` | `+` | Actually submit and process media | Yes |

> The `+` prefix means it **actually hits the data plane** (same as `+chat`); `tools` is a control-plane command that only renders local metadata.

---

## 1. Quick start

```shell
# 1. See what tools exist (--json gives a machine-readable schema, see §4)
thcli tools list

# 2. Prepare a data-plane API key
thcli key create --name mykey --scope all       # create a key in the cloud
thcli chat-config set --value <plaintext>        # store it locally for +chat / +tool

# 3. Submit a task (async by default, returns task_id immediately)
thcli +tool image-cutout https://example.com/a.png --version cutout-1.0-flash

# 4. Fetch the result
thcli +tool task image-cutout <task_id>
```

> `+tool` and `+chat` use the **same data-plane API key** (stored locally via `chat-config`).
> If you already configured `+chat`, skip step 2.

The input URL (passed as a positional argument) accepts two forms:

| Form | Example |
|---|---|
| Public URL | `https://example.com/a.png` |
| base64 | `data:image/png;base64,iVBORw0KGgo...` |

The URL must be **publicly reachable**; private or authenticated URLs fail — use base64 instead.

---

## 2. Async (default) vs waiting

The gateway API is **entirely asynchronous** (submit → poll). Media tasks can take a long time
(video / audio may run for hours), so the CLI **does not wait by default** — it returns
`task_id` immediately and you decide when to fetch the result.

### Async (default)

```shell
thcli +tool image-erase https://example.com/a.png --prompt "erase the watermark at bottom-right"
```

```
已提交: task_id=221073-ProcessImageAsync-xxx          ← stderr (always printed, see below)
Task created
  task_id:    221073-ProcessImageAsync-xxx
  request_id: 8f3a...                                  ← stdout

Query: thcli +tool task image-erase 221073-ProcessImageAsync-xxx
```

> **After a successful submit, `task_id` is always printed to stderr** (even in `--json` mode).
> So if the process is later killed by an external timeout, or you only captured stdout, you can
> still recover `task_id` from stderr — the task never becomes an orphan (running, billed, but
> unfindable). Agents in particular should capture stderr.

### Waiting (`--wait`)

Add `--wait` to get the result in one command: the CLI polls internally to the terminal state.

```shell
thcli +tool image-super-resolution https://example.com/a.png --mode percent --percent 2 --wait
```

> ⚠️ **Agents should avoid `--wait`**: media tasks may exceed your per-command timeout and the
> process will be killed. If you must use it, set `--timeout` **below your shell/agent timeout**
> so the CLI exits gracefully first and prints `task_id` (which is already on stderr anyway).

### Query a task

```shell
thcli +tool task <tool_id> <task_id>
```

Queries the task **once** (no polling) and prints the current status (which may still be `in_progress`); prints the result URL if already completed. Pass the same `<tool_id>` used at submit time (each tool has its own task query path). Use `--wait` at submit time to get the terminal result in one command.

---

## 3. Common options

Every tool supports:

| Option | Description |
|---|---|
| `--wait` | Wait: submit then poll to the terminal state and print the result (**default is async: submit only**) |
| `--interval <sec>` | Polling interval, default `3` |
| `--timeout <sec>` | Polling timeout (seconds), **only with `--wait`**. Default by tool type: image `600` / video-audio `1800` |
| `--alias <alias>` | API key alias, default `default` |
| `--area <area>` | Region, default `gz` |
| `--api-key <key>` | Override API key (defaults to local chat-config) |

Global options (`--json` / `--profile` / `--site` / `--region` / `--lang`, etc.) are available on all commands — see the main README.

---

## 4. Tool list

### Image tools (`image_url`)

| tool_id | Capability | Required |
|---|---|---|
| `image-super-resolution` | Super-resolution (upscale / sharpen) | scenario-dependent, see below |
| `image-outpainting` | AI outpainting (change aspect ratio / extend canvas) | none |
| `image-cutout` | AI cutout (remove background, transparent output) | `--version` |
| `image-erase` | Erase (watermark / text) | `--prompt` |

### Video tools (`video_url`)

| tool_id | Capability | Required |
|---|---|---|
| `video-transcode` | High-speed transcode / compress | none |
| `video-enhance-premium` | Large-model enhance (generative quality boost) | none |
| `video-interpolate-frames` | Frame interpolation (to target fps) | `--fps` |
| `video-enhance-color` | Color enhance | none |
| `video-erase` | Erase (remove subtitles etc.) | none |
| `video-privacy-mask` | Privacy mask (blur faces / plates) | none |
| `dubbing` | AI translation dubbing | `--dst-language` |

### Audio tools (`audio_url`)

| tool_id | Capability | Required |
|---|---|---|
| `audio-denoise` | Denoise | none |
| `audio-separate` | Vocal / background separation | `--track` |

> Image enhance (`image-enhance`) is **not live** on the gateway, so `tools list` omits it.

### Machine-readable schema (`tools list --json`)

For scripts and AI agents: one call returns the full parameter definition of every tool
(name / flag / type / required / choices / default / description) — **no need to parse the
human-readable `--help`**:

```shell
thcli tools list --json
```

```json
[
  {
    "id": "image-cutout",
    "category": "image",
    "description": "Image AI cutout (remove background, transparent output)",
    "input": { "field": "image_url", "required": true },
    "params": [
      { "name": "version", "flag": "--version", "type": "string", "required": true,
        "description": "Cutout model", "choices": ["cutout-1.0-lite", "cutout-1.0-flash"] },
      { "name": "wait", "flag": "--wait", "type": "boolean", "required": false,
        "description": "Wait: ..." },
      { "name": "interval", "flag": "--interval", "type": "int", "required": false, "default": 3 },
      { "name": "timeout", "flag": "--timeout", "type": "int", "required": false, "default": 600 }
    ]
  }
]
```

> Human-readable parameter help is still in `thcli +tool <tool_id> --help`.

---

## 5. Per-tool parameters

### 5.1 Image super-resolution `image-super-resolution`

Combine `--mode` with size parameters:

| Scenario | Parameters |
|---|---|
| By scale | `--mode percent --percent 2` (2x) |
| Fixed resolution | `--mode fixed`, with size given by `--width` / `--height` (exact dimensions), or by `--long-side` / `--short-side` (constrain one side, the other scales proportionally) |
| Adaptive | `--mode aspect --short-side 1440` |

```shell
thcli +tool image-super-resolution https://example.com/a.png --mode percent --percent 2
thcli +tool image-super-resolution https://example.com/a.png --mode fixed --width 1920 --height 1080
```

- `--type`: algorithm, `standard` / `super` / `ultra` (default). Leave it out unless needed.

### 5.2 Image outpainting `image-outpainting`

All three are optional and can be combined:

```shell
thcli +tool image-outpainting https://example.com/a.png --aspect-ratio 16:9
thcli +tool image-outpainting https://example.com/a.png --width 1280
thcli +tool image-outpainting https://example.com/a.png --aspect-ratio 16:9 --width 1280
```

- `--aspect-ratio`: `1:1` `3:2` `2:3` `3:4` `4:3` `4:5` `5:4` `9:16` `16:9` `21:9`

### 5.3 Image cutout `image-cutout`

```shell
thcli +tool image-cutout https://example.com/a.png --version cutout-1.0-flash
```

- `--version` (**required**): `cutout-1.0-lite` (fastest) / `cutout-1.0-flash` (quality-speed balance)
- When unspecified, `cutout-1.0-flash` is recommended; use `cutout-1.0-lite` for speed

### 5.4 Image erase `image-erase`

```shell
thcli +tool image-erase https://example.com/a.png --prompt "erase the watermark at bottom-right"
```

- `--prompt` (**required**): natural-language description of what to erase
- Runs an agent pipeline, **noticeably slower than other image tools** (~2 min for others)
- If the described target is absent, or the server-side agent is unavailable, the task ends as `failed` — **do not retry the same request**

### 5.5 Video transcode `video-transcode`

```shell
thcli +tool video-transcode https://example.com/a.mp4 --resolution 1920x1080
thcli +tool video-transcode https://example.com/a.mp4 --compress-type ultra_compress   # extra-billed
thcli +tool video-transcode https://example.com/a.mp4 --remove-audio
```

Output spec: `--resolution` (`"WxH"`) / `--container` (`MP4`) / `--codec` (`H264`/`H265`/`AV1`) / `--max-video-bitrate` / `--fps`.

### 5.6 Video enhance (large model) `video-enhance-premium`

```shell
thcli +tool video-enhance-premium https://example.com/a.mp4
```

All parameters optional: output spec (`--resolution` / `--container` / `--codec` / `--max-video-bitrate` / `--fps`).

### 5.7 Video frame interpolation `video-interpolate-frames`

```shell
thcli +tool video-interpolate-frames https://example.com/a.mp4 --fps 60
```

- `--fps` (**required**): target frame rate, > 0
- Also output spec: `--resolution` / `--container` / `--codec` / `--max-video-bitrate`

### 5.8 Video color enhance `video-enhance-color`

```shell
thcli +tool video-enhance-color https://example.com/a.mp4 --level Strong
```

All parameters optional: output spec + `--level` (`Weak` (default, used when omitted) / `Normal` / `Strong`).

### 5.9 Video erase `video-erase`

```shell
thcli +tool video-erase https://example.com/a.mp4 --version Premium
```

- `--version`: `Lite` (default, lightweight model, subtitles only) / `Premium` (large model, auto-detect, pricier)

### 5.10 Video privacy mask `video-privacy-mask`

```shell
thcli +tool video-privacy-mask https://example.com/a.mp4 --target FacePlate --effect Mosaic
```

- `--target`: `Face` (default, faces only) / `FacePlate` (faces + plates)
- `--effect`: `Blur` (default) / `Mosaic`

### 5.11 AI translation dubbing `dubbing`

```shell
thcli +tool dubbing https://example.com/a.mp4 --dst-language en
```

- `--dst-language` (**required**): `zh` / `en` (source language fixed to auto, model fixed to default)

### 5.12 Audio denoise `audio-denoise`

```shell
thcli +tool audio-denoise https://example.com/a.mp3 --container mp3
```

Audio output spec: `--container` (`m4a` default / `mp3` / `flac` / `ogg`) / `--codec` (`aac` default / `mp3` / `flac` / `ac3`) / `--sample-rate` (`44100` default / `32000` / `48000`).

### 5.13 Vocal / background separation `audio-separate`

```shell
thcli +tool audio-separate https://example.com/a.mp3 --track Vocal
```

- `--track` (**required**): `Vocal` / `Background` (mutually exclusive — pick one)
- `--scene`: `Normal` (default) / `Music` (accepted but not yet effective)

---

## 6. Output

- **Default (async) stdout**: `task_id` + `request_id` (`{task_id, status, request_id}` with `--json`)
- **`--wait` success stdout**: the result URL (`output.file_url`); the gateway's raw response with `--json`
- **stderr**: `task_id` **always** printed after submit; progress and errors under `--wait`
- **Exit codes**: `0` success / `1` parameter or business error / `130` interrupted

`--wait` success example (`--json`):

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

> For video / audio tools, the query response's `output` contains only `file_url` (no `file_id` / `file_type` / `media_name`).

On failure, `status` is `failed` and `error` explains why:

```json
{"task_id": "...", "status": "failed", "error": {"code": "InternalError", "message": "..."}}
```

---

## 7. States and errors

### State machine

| Status | Terminal | Description |
|---|---|---|
| `queued` | No | Queued |
| `in_progress` | No | Processing |
| `completed` | Yes | Success, `output` populated |
| `failed` | Yes | Failure, see `error` |

### Error codes

| HTTP | type | Meaning |
|---|---|---|
| 400 | `invalid_request_error` | Bad params: missing/invalid URL, bad enum, missing required, unknown field, task_id not found |
| 401 | `invalid_api_key` | Missing or invalid API key |
| 404 | `not_found` | Path not found |
| 405 | `method_not_allowed` | Method not allowed |
| 429 | `rate_limit_exceeded` | QPS exceeded |
| 429 | `quota_exceeded` | Quota exhausted |
| 500 | `server_error` | Internal error |

Known codes come with a reason and a fix; look up unknown ones with `thcli doctor error <code>`.

> Parameter errors are rejected at the gateway (no quota consumed, no task created).

---

## 8. Notes

- Hand `output.file_url` to the user once done.
- On failure, relay the reason faithfully and **do not retry the same request** (parameter errors won't succeed on retry).
- For multi-step processing (e.g. cutout then outpaint), pass the previous step's `output.file_url` as the next input.
- Do not poll the same task concurrently; one polling loop per task.
- Do not log or echo base64 content.
- Rate limits: submit `20 QPS`, query `100 QPS` (per appid).

---

## 9. Related resources

- Per-tool parameters: `thcli +tool <tool_id> --help`
- Gateway image-process customer doc: `vod-gateway/docs/imageprocess/README.md`
- The equivalent Agent-Skill form: `tencent-tokenhub-tool` (Python, feature-parity)
