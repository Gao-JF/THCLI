/**
 * +tool 命令：调用 TokenHub 的 wand 媒体处理工具（图片 / 视频 / 音频）。
 *
 * 链路（与 +chat 同一条数据面通道，只是路径不同）：
 *   thcli +tool <tool_id> <input>
 *     → https://<chatHost>            apikey 鉴权（Authorization: Bearer <key>）
 *       → 网关内部转发 8080 → vod-gateway
 *         → POST /v1/wand/tool/<tool_id>                  提交，回 task_id
 *           GET  /v1/wand/tool/<tool_id>/tasks/<task_id>  轮询，到终态取结果
 *
 * 命名带 + 前缀：只有 +chat / +tool 会真正打到数据面，与管控面命令视觉区分。
 *
 * 工具元数据全在 core/tool-spec.ts，本文件只负责「提交 → 轮询 → 呈现」这一条
 * 与具体工具无关的流程。
 */
import { Command } from "commander";

import { chatHostOf, DEFAULT_REGION } from "../core/config.js";
import { type GlobalArgs, resolveEnv, resolveProfile, resolveSite } from "../core/credentials.js";
import { DEFAULT_ALIAS, loadDataConfig, resolveRegionKey } from "../core/keystore.js";
import { emitJson, isJson } from "../core/output.js";
import { lookupError } from "../core/errors.js";
import { logDataPlaneCall } from "../core/telemetry.js";
import { t } from "../core/i18n.js";
import { allToolIds, toolSpecOf, TOOL_SPECS, type ToolParam, type ToolSpec } from "../core/tool-spec.js";

/** 轮询默认间隔（秒） */
const DEFAULT_INTERVAL = 3;

/**
 * --wait 下的默认轮询超时，按工具类型区分。
 *
 * 图片约 2 分钟，视频/音频实测 > 5 分钟且可能更长，一刀切会让快的等太久、
 * 或慢的提前超时。默认异步（不等待）时该值无意义，仅在 --wait 生效。
 */
const WAIT_TIMEOUT_IMAGE = 600;
const WAIT_TIMEOUT_AV = 1800;

/** 按工具分类取 --wait 的默认超时（秒） */
function defaultTimeoutOf(spec: ToolSpec): number {
  return spec.category === "image" ? WAIT_TIMEOUT_IMAGE : WAIT_TIMEOUT_AV;
}

/** camelCase → kebab-case，供拼 CLI flag（如 "aspectRatio" → "aspect-ratio"） */
function kebab(flag: string): string {
  return flag.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

/**
 * 提交后「任务暂时查不到」的宽限期（秒）。
 *
 * 下游写入有延迟，刚提交的任务查询可能先返回 400 not found。这与「任务真的
 * 不存在」不是一回事，宽限期内继续轮询，超时后才判失败——否则会把正常任务
 * 误报为失败。（对齐参考实现 tencent-tokenhub-tool/scripts/_client.py）
 */
const NOT_FOUND_GRACE = 60;

/** 终态 */
const STATUS_COMPLETED = "completed";
const STATUS_FAILED = "failed";

/** 全部终态，供「是否还在处理中」判断 */
const TERMINAL_STATUS = new Set<string>([STATUS_COMPLETED, STATUS_FAILED]);

/** +tool 的选项 */
interface ToolOptions {
  wait?: boolean;
  interval?: string;
  timeout?: string;
  apiKey?: string;
  alias?: string;
  area?: string;
  json?: boolean;
  [key: string]: unknown;
}

/** 一次请求的结果 */
interface HttpResult {
  status: number;
  body: Record<string, unknown> | string;
  /** 网关真实返回的 request_id（从 header 或 body 兜底提取），用于日志与排障 */
  requestId?: string;
}

/** 提交成功后的响应 */
interface SubmitData {
  task_id?: string;
  status?: string;
  request_id?: string;
}

/** 提交结果：task_id 与 request_id 都要透传给用户（后者用于向网关侧定位问题） */
interface SubmitOutcome {
  taskId: string;
  requestId?: string;
}

/** 查询响应 */
interface QueryData {
  task_id?: string;
  status?: string;
  progress?: number;
  output?: { file_url?: string; file_id?: string; file_type?: string; media_name?: string };
  output_text?: string;
  error?: { code?: string; message?: string; Code?: string; Message?: string };
  request_id?: string;
  [key: string]: unknown;
}

/**
 * 解析轮询用的正数选项（--interval / --timeout）。
 *
 * 必须先校验再进轮询循环：若放行 NaN，「deadline = started + NaN」会让
 * 「Date.now() >= deadline」恒为 false（永不超时），且 setTimeout(NaN) 立即触发，
 * 变成不限速的热轮询，进程卡死在外面也退不出来。下限 >= 1（--interval 0 同样是紧循环）。
 */
function parsePositive(raw: string | undefined, fallback: number, flag: string, min: number): number {
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) {
    throw new Error(t("tool.outOfRange", { flag, value: String(raw), min: String(min), max: "∞" }));
  }
  return n;
}

/**
 * 枚举校验（仅当参数声明了 choices）。在 CLI 侧先拦下，省一次必然 400 的网络往返——
 * 网关对非法枚举不纠错，只会原样透传到下游报错。
 *
 * int 型参数（如 sample_rate）的 choices 是数字，比较前把两侧都归一为字符串，
 * 避免 "32000" 与 32000 类型不同而误判。
 */
function checkChoices(param: ToolParam, raw: string): void {
  if (!param.choices || !param.choices.length) {
    return;
  }
  const allowed = param.choices.map(String);
  if (!allowed.includes(String(raw))) {
    throw new Error(
      t("tool.badChoice", { flag: `--${kebab(param.flag)}`, value: String(raw), choices: allowed.join(" / ") }),
    );
  }
}

/**
 * 数值范围校验（仅当参数声明了 min/max）。在 CLI 侧先拦下，省一次必然 400 的
 * 网络往返——网关对越界值不会纠正，只会原样透传到下游报错。
 */
function checkRange(param: ToolParam, value: number): void {
  const flag = `--${kebab(param.flag)}`;
  if (param.min !== undefined && value < param.min) {
    throw new Error(t("tool.outOfRange", { flag, value: String(value), min: String(param.min), max: String(param.max) }));
  }
  if (param.max !== undefined && value > param.max) {
    throw new Error(t("tool.outOfRange", { flag, value: String(value), min: String(param.min), max: String(param.max) }));
  }
}

/** 拼某个参数对应的 CLI flag 字符串（如 "aspectRatio" → "--aspect-ratio <v>"） */
function flagString(param: ToolParam): string {
  const name = `--${kebab(param.flag)}`;
  if (param.type === "boolean") {
    return name;
  }
  // list 必须是 <v...>：commander 靠 /<v\.\.\.>/ 判定 variadic，写成 <v>... 会被当成单值，
  // 重复传参后者覆盖前者（--track 就踩过这个坑）。
  if (param.type === "list") {
    return `${name} <v...>`;
  }
  const valueHint = param.type === "int" ? "<n>" : param.type === "float" ? "<n>" : "<v>";
  return `${name} ${valueHint}`;
}

/**
 * 解析 apikey 与 host。与 +chat 完全一致：apikey 走 keystore（--api-key 优先），
 * host 走 chatHostOf（受 site/region/env 决定，env 影响是否带 test- 前缀）。
 *
 * 顺带带上 profile/site：数据面调用日志按二者分文件（与 +chat 一致），
 * 故它们要随 endpoint 一起传到每个请求点，避免再解析一遍。
 */
interface ToolEndpoint {
  base: string;
  apiKey: string;
  profile: string;
  site: string;
}

function resolveEndpoint(opts: ToolOptions, globals: GlobalArgs): ToolEndpoint {
  const profile = resolveProfile(globals);
  const site = resolveSite(globals);
  const region = opts.area ?? DEFAULT_REGION;
  const apiKey =
    opts.apiKey ??
    resolveRegionKey(loadDataConfig(profile), site, region, "th", opts.alias ?? DEFAULT_ALIAS);
  if (!apiKey) {
    throw new Error(
      `${t("tool.noKey", { site, area: region, alias: opts.alias ?? DEFAULT_ALIAS })}\n` +
        t("tool.noKeyFix", { area: region }),
    );
  }
  const env = resolveEnv();
  return { base: `https://${chatHostOf(site, region, env)}`, apiKey, profile, site };
}

/** 从 endpoint 取请求日志上下文 */
function ctxOf(endpoint: ToolEndpoint, channel: string): RequestCtx {
  return { profile: endpoint.profile, site: endpoint.site, channel };
}

/**
 * 从响应头/体里提取网关真实返回的 request_id，客户端从不自己生成。
 *
 * 与 +chat 的 extractRequestId 对齐：优先响应头，再依次从 body 的常见位置兜底
 * （网关 OpenAI 格式把 request_id 放在顶层或 error.request_id）。
 */
function extractRequestId(headers: Headers, body?: Record<string, unknown>): string | undefined {
  const fromHeader = headers.get("x-request-id") ?? headers.get("x-trace-id");
  if (fromHeader) return fromHeader;
  if (!body) return undefined;
  if (typeof body["request_id"] === "string") return body["request_id"];
  if (typeof body["RequestId"] === "string") return body["RequestId"];
  const error = body["error"] as Record<string, unknown> | undefined;
  if (error && typeof error["request_id"] === "string") return error["request_id"];
  return undefined;
}

/** 一次请求的上下文，用于写数据面调用日志（不含任何密钥） */
interface RequestCtx {
  profile: string;
  site: string;
  /** 日志里的通道名，如 tool.submit / tool.poll / tool.task */
  channel: string;
}

/**
 * 发一次请求（网络层错误统一抛出，交给顶层处理）。
 *
 * 会写一条数据面调用日志（`~/.thcli/log/{profile}.{site}.tokenhub-plugin-tool.log`）：
 * 只记 channel / request_id / 耗时 / 成败，**从不记请求参数与响应体**——与 +chat 一致。
 */
async function request(
  method: "GET" | "POST",
  url: string,
  apiKey: string,
  ctx: RequestCtx,
  body?: Record<string, unknown>,
): Promise<HttpResult> {
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  const start = Date.now();
  let resp: Response;
  try {
    resp = await fetch(url, init);
  } catch (err) {
    logDataPlaneCall(ctx.profile, ctx.site, {
      channel: ctx.channel,
      durationMs: Date.now() - start,
      status: "error",
      error: (err as Error).message,
      kind: "tool",
    });
    throw new Error(t("tool.networkError", { message: (err as Error).message }));
  }

  const text = await resp.text();
  let parsed: Record<string, unknown> | string = text;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // 非 JSON 体原样保留，错误里一并展示
  }
  const bodyObj = typeof parsed === "string" ? undefined : parsed;
  const requestId = extractRequestId(resp.headers, bodyObj);
  logDataPlaneCall(ctx.profile, ctx.site, {
    channel: ctx.channel,
    requestId,
    durationMs: Date.now() - start,
    status: resp.ok ? "ok" : "error",
    error: resp.ok ? undefined : `HTTP ${resp.status}`,
    kind: "tool",
  });
  return { status: resp.status, body: parsed, requestId };
}

/** 从错误体里取人类可读信息（网关是 OpenAI 格式 {error:{message}}） */
function errorDetail(body: Record<string, unknown> | string): string {
  if (typeof body === "string") {
    return body;
  }
  const error = body["error"] as Record<string, unknown> | undefined;
  if (error && typeof error["message"] === "string") {
    return error["message"];
  }
  return JSON.stringify(body);
}

/** 从错误体里取业务码（用于补 thcli 侧的修复建议） */
function errorCode(body: Record<string, unknown> | string): string | undefined {
  if (typeof body === "string") {
    return undefined;
  }
  const error = body["error"] as Record<string, unknown> | undefined;
  const code = error?.["code"];
  if (typeof code === "string") return code;
  if (typeof code === "number") return String(code);
  return undefined;
}

/**
 * 按 spec 从 options 组装请求体。
 *
 * 关键：**用户没传的字段一律不下发**（视频/音频网关 DisallowUnknownFields，
 * 多字段直接 400；且下游把空串/0 视为非法）。所以这里对每个参数只在「确实
 * 给了有效值」时才写入 body。
 */
function buildBody(spec: ToolSpec, input: string, opts: ToolOptions): Record<string, unknown> {
  const body: Record<string, unknown> = { [spec.inputField]: input };

  for (const param of spec.params) {
    const raw = opts[param.flag];

    if (param.type === "boolean") {
      // 布尔工具（当前仅 remove_audio）只在显式开启时才下发：网关侧 false 是
      // 「保留音频」= 缺省，下发 false 与不下发等价，索性只在 true 时写，
      // 与参考实现一致，也让 body 更干净。
      if (raw === true) {
        body[param.field] = true;
      }
      continue;
    }

    if (raw === undefined || raw === null || raw === "") {
      continue;
    }

    if (param.type === "list") {
      const values = Array.isArray(raw) ? raw : [raw];
      const cleaned = values.map((v) => String(v)).filter(Boolean);
      for (const v of cleaned) {
        checkChoices(param, v);
      }
      if (cleaned.length) {
        body[param.field] = cleaned;
      }
      continue;
    }

    if (param.type === "int") {
      const n = Number(raw);
      if (Number.isNaN(n)) {
        throw new Error(t("tool.badNumber", { flag: `--${kebab(param.flag)}`, value: String(raw) }));
      }
      checkChoices(param, String(raw));
      checkRange(param, n);
      body[param.field] = n;
      continue;
    }

    if (param.type === "float") {
      const n = Number(raw);
      if (Number.isNaN(n)) {
        throw new Error(t("tool.badNumber", { flag: `--${kebab(param.flag)}`, value: String(raw) }));
      }
      checkChoices(param, String(raw));
      checkRange(param, n);
      body[param.field] = n;
      continue;
    }

    checkChoices(param, String(raw));
    body[param.field] = raw;
  }

  return body;
}

/** 提交任务，返回 task_id 与 request_id */
async function submit(
  spec: ToolSpec,
  input: string,
  opts: ToolOptions,
  endpoint: ToolEndpoint,
): Promise<SubmitOutcome> {
  const url = `${endpoint.base}/v1/wand/tool/${spec.id}`;
  const body = buildBody(spec, input, opts);
  const { status, body: respBody, requestId } = await request(
    "POST",
    url,
    endpoint.apiKey,
    ctxOf(endpoint, "tool.submit"),
    body,
  );

  if (status !== 200) {
    printHttpError(status, respBody, requestId);
    process.exit(1);
  }
  const data = respBody as SubmitData;
  if (!data || typeof data.task_id !== "string" || !data.task_id) {
    throw new Error(t("tool.submitNoTaskId", { body: errorDetail(respBody) }));
  }
  // request_id 优先用 header 兜底提取到的，其次才是 body 里的字段
  return { taskId: data.task_id, requestId: requestId ?? data.request_id };
}

/** 「任务暂时查不到」（提交后可见性延迟）判定 */
function isNotFound(status: number, body: Record<string, unknown> | string): boolean {
  if (status !== 400) {
    return false;
  }
  return errorDetail(body).toLowerCase().includes("not found");
}

/**
 * 轮询到终态，返回最终响应。
 *
 * 与参考实现一致的两处要点：
 *   1. 宽限期内「not found」不判失败；
 *   2. 失败时错误字段图片/视频大小写不同（error.code vs error.Code），两种都认。
 */
async function poll(
  spec: ToolSpec,
  taskId: string,
  opts: ToolOptions,
  endpoint: ToolEndpoint,
): Promise<QueryData> {
  const url = `${endpoint.base}/v1/wand/tool/${spec.id}/tasks/${taskId}`;
  const interval = parsePositive(opts.interval, DEFAULT_INTERVAL, "--interval", 1);
  const timeout = parsePositive(opts.timeout, defaultTimeoutOf(spec), "--timeout", 1);
  const started = Date.now();
  const deadline = started + timeout * 1000;
  let lastStatus = "";
  const showProgress = !isJson();

  for (;;) {
    const { status, body, requestId } = await request(
      "GET",
      url,
      endpoint.apiKey,
      ctxOf(endpoint, "tool.poll"),
    );

    if (status !== 200) {
      if (isNotFound(status, body) && Date.now() - started < NOT_FOUND_GRACE * 1000) {
        lastStatus = "queued";
      } else {
        printHttpError(status, body, requestId);
        process.exit(1);
      }
    } else {
      const data = body as QueryData;
      lastStatus = data.status ?? "";
      if (showProgress) {
        renderProgress(lastStatus, data.progress);
      }
      if (lastStatus === STATUS_COMPLETED) {
        return data;
      }
      if (lastStatus === STATUS_FAILED) {
        return data;
      }
    }

    if (Date.now() >= deadline) {
      throw new Error(
        t("tool.pollTimeout", {
          timeout: String(timeout),
          status: lastStatus || t("tool.statusUnknown"),
          taskId,
        }),
      );
    }
    await sleep(interval * 1000);
  }
}

/** 轮询进度展示（单行覆盖，非 JSON 模式） */
function renderProgress(status: string, progress: number | undefined): void {
  const label = status || t("tool.statusUnknown");
  const pct = typeof progress === "number" ? ` ${progress}%` : "";
  process.stderr.write(`\r  ${t("tool.polling")} ${label}${pct}    `);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 打印 HTTP 层错误 + 业务码对应的修复建议 + request_id。
 *
 * request_id 与 +chat 一致地打在最后一行：它是向网关侧定位问题的唯一凭据，
 * 不带出来用户/Agent 就只能干看着报错。网关真实返回，客户端不生成。
 */
function printHttpError(
  status: number,
  body: Record<string, unknown> | string,
  requestId?: string,
): void {
  console.error(t("tool.httpFailed", { status, detail: errorDetail(body) }));
  const code = errorCode(body);
  if (code) {
    const info = lookupError(code);
    if (info) {
      console.error(`  ${t("error.code", { code })}`);
      console.error(`  ${t("error.fix", { fix: info.fix })}`);
    }
  }
  console.error(`  ${t("tool.requestId", { id: requestId ?? "-" })}`);
}

/** 呈现终态结果：JSON 模式吐原始响应，否则打印人话 + 结果地址 */
function presentResult(data: QueryData): void {
  // JSON 模式把网关原始终态响应原样吐出，不裁剪（Agent 侧要拿完整结构）
  if (emitJson(data)) {
    if (data.status === STATUS_FAILED) {
      process.exitCode = 1;
    }
    return;
  }

  if (data.status === STATUS_FAILED) {
    const err = data.error;
    const msg = err?.message ?? err?.Message ?? JSON.stringify(data);
    console.error(t("tool.taskFailed", { message: msg }));
    process.exitCode = 1;
    return;
  }

  const fileUrl = data.output?.file_url;
  if (fileUrl) {
    console.log(fileUrl);
  } else {
    console.log(t("tool.completedNoUrl"));
  }
}

/**
 * 呈现一次任务查询的**当前**状态（不等待）。
 *
 * 与 presentResult 的区别：这里状态可能是非终态（queued / in_progress），
 * 要如实报告，而不是当作"完成/失败"处理。任务若已完成则顺手给出结果地址。
 */
function presentStatus(data: QueryData): void {
  // JSON 模式吐原始响应（Agent 自己判断状态），失败态以退出码 1 收尾
  if (emitJson(data)) {
    if (data.status === STATUS_FAILED) {
      process.exitCode = 1;
    }
    return;
  }

  const status = data.status || t("tool.statusUnknown");
  const pct = typeof data.progress === "number" ? ` ${data.progress}%` : "";
  console.log(t("tool.task.statusLine", { status, progress: pct, taskId: data.task_id ?? "-" }));

  if (status === STATUS_FAILED) {
    const err = data.error;
    const msg = err?.message ?? err?.Message ?? "";
    if (msg) {
      console.error(`  ${t("tool.taskFailed", { message: msg })}`);
    }
    process.exitCode = 1;
    return;
  }
  // 已完成则给出结果地址；非终态则提示这是当前快照
  if (data.output?.file_url) {
    console.log(data.output.file_url);
  } else if (!TERMINAL_STATUS.has(status)) {
    console.log(`  ${t("tool.task.notDoneHint", { taskId: data.task_id ?? "-" })}`);
  }
}

/**
 * 单工具执行（默认异步）。
 *
 * 网关本身全是异步任务：POST 提交 → GET 轮询。媒体任务耗时可能很长（视频/音频
 * 几小时都可能），**默认不帮你等**——提交后立即返回 task_id + request_id，
 * 由调用方自行用 `+tool task <tool_id> <taskId>` 查询。这样不会因 agent 侧
 * 超时把进程杀掉，而留下「任务在跑、额度已扣、task_id 丢失」的孤儿任务。
 *
 * 想一条命令直接拿结果就加 --wait（提交 + 轮询到终态）。
 *
 * 关键：**提交成功后无条件把 task_id 打到 stderr**（含 --json 模式），
 * 这样即便 --wait 期间进程被 kill，task_id 也已可见、任务不会变成孤儿。
 */
async function runTool(
  spec: ToolSpec,
  input: string | undefined,
  opts: ToolOptions,
  globals: GlobalArgs,
): Promise<void> {
  const endpoint = resolveEndpoint(opts, globals);

  if (!input) {
    throw new Error(t("tool.needInput", { field: spec.inputField, toolId: spec.id }));
  }

  // 轮询参数先校验再提交：参数错不该先产生一次计费任务。
  if (opts.wait === true) {
    parsePositive(opts.interval, DEFAULT_INTERVAL, "--interval", 1);
    parsePositive(opts.timeout, defaultTimeoutOf(spec), "--timeout", 1);
  }

  const { taskId, requestId } = await submit(spec, input, opts, endpoint);

  // 无条件先把 task_id 落到 stderr：非 JSON 与 JSON 模式都打。
  // --wait 期间若被外部超时杀掉，这一行是唯一的「找回任务」线索。
  process.stderr.write(`${t("tool.submitted", { taskId })}\n`);

  // 默认异步：立即返回，不轮询（stdout 有结构，stderr 已给 task_id）
  if (opts.wait !== true) {
    if (emitJson({ task_id: taskId, status: "queued", request_id: requestId })) {
      return;
    }
    console.log(t("tool.asyncResult", { taskId, requestId: requestId ?? "-" }));
    return;
  }

  const data = await poll(spec, taskId, opts, endpoint);
  if (!isJson()) {
    process.stderr.write("\r\u001b[K"); // 清掉进度行
  }
  if (data.task_id === undefined) {
    data.task_id = taskId;
  }
  presentResult(data);
}

/**
 * `+tool task <tool_id> <taskId>`：查询任务的**当前状态**，只查一次、不轮询。
 *
 * 不做等待：查询命令就该立即返回快照，由调用方决定何时再查（长任务下
 * 一直卡着轮询既无必要、也容易被外层超时打断）。要"等到完成"就用
 * 创建时的 `--wait`。
 */
async function queryTask(
  toolId: string | undefined,
  taskId: string | undefined,
  opts: ToolOptions,
  globals: GlobalArgs,
): Promise<void> {
  if (!toolId) {
    throw new Error(t("tool.task.needToolId"));
  }
  const spec = toolSpecOf(toolId);
  if (!spec) {
    throw new Error(t("tool.task.unknownTool", { toolId, options: allToolIds().join(", ") }));
  }
  if (!taskId) {
    throw new Error(t("tool.task.needTaskId"));
  }
  const endpoint = resolveEndpoint(opts, globals);
  const url = `${endpoint.base}/v1/wand/tool/${spec.id}/tasks/${taskId}`;
  const { status, body, requestId } = await request(
    "GET",
    url,
    endpoint.apiKey,
    ctxOf(endpoint, "tool.task"),
  );

  if (status !== 200) {
    printHttpError(status, body, requestId);
    process.exit(1);
  }
  const data = body as QueryData;
  if (data.task_id === undefined) {
    data.task_id = taskId;
  }
  presentStatus(data);
}

/**
 * 机读工具 schema 等本地列表逻辑见 commands/tools.ts（controls `tools` 命令组）。
 * 本文件只负责 +tool 的数据面流程。
 */

/** 给一个工具命令挂上主输入位置参数与全部 option */
function buildToolCommand(program: Command, spec: ToolSpec, getGlobals: () => GlobalArgs): void {
  const cmd = program
    .command(spec.id)
    .description(`${t(spec.descKey)}（${spec.inputField}）`)
    .argument("[input]", t("tool.arg.input", { field: spec.inputField }))
    .option("--wait", t("tool.opt.wait"))
    .option("--interval <sec>", t("tool.opt.interval"), String(DEFAULT_INTERVAL))
    .option("--timeout <sec>", t("tool.opt.timeout", { def: defaultTimeoutOf(spec) }), String(defaultTimeoutOf(spec)));

  for (const param of spec.params) {
    const flags = flagString(param);
    const help = param.choices ? `${t(param.helpKey)} [${param.choices.join(" / ")}]` : t(param.helpKey);
    if (param.required) {
      cmd.requiredOption(flags, help);
    } else {
      cmd.option(flags, help);
    }
  }

  cmd
    .option("--api-key <key>", t("tool.opt.apiKey"))
    .option("--alias <alias>", t("tool.opt.alias"), DEFAULT_ALIAS)
    .option("--area <area>", t("tool.opt.area"), DEFAULT_REGION)
    .action(async (input: string | undefined, opts: ToolOptions) => {
      await runTool(spec, input, opts, getGlobals());
    });
}

/** 装配 +tool 命令组 */
export function registerToolCommands(program: Command, getGlobals: () => GlobalArgs): void {
  const tool = program.command("+tool").description(t("group.tool.desc"));

  // +tool task <tool_id> <taskId>：查询任务当前状态（只查一次，不轮询，故无 --interval/--timeout）
  tool
    .command("task")
    .description(t("tool.task.desc"))
    .argument("[tool_id]", t("tool.task.arg.toolId"))
    .argument("[task_id]", t("tool.task.arg.taskId"))
    .option("--api-key <key>", t("tool.opt.apiKey"))
    .option("--alias <alias>", t("tool.opt.alias"), DEFAULT_ALIAS)
    .option("--area <area>", t("tool.opt.area"), DEFAULT_REGION)
    .action(async (toolId: string | undefined, taskId: string | undefined, opts: ToolOptions) => {
      await queryTask(toolId, taskId, opts, getGlobals());
    });

  for (const spec of TOOL_SPECS) {
    buildToolCommand(tool, spec, getGlobals);
  }
}
