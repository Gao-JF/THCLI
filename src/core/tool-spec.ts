/**
 * wand 工具声明表：+tool 命令的全部工具元数据。
 *
 * 数据来源（两处已交叉核对，务必保持一致）：
 *   - 网关路由注册表：
 *       vod-gateway/internal/service/imageprocess/imageprocess.go  (tools)
 *       vod-gateway/internal/service/videoprocess/convert.go       (tools)
 *   - 对客参考实现（字段/必填/枚举的权威口径）：
 *       tencent-tokenhub-tool/scripts/*.py 与 references/api_reference.md
 *
 * 为什么用「声明表」而不是给每个工具各写一个 action：
 *   工具之间只有「参数集」不同，「提交 → 轮询 → 输出」的流程完全相同。把差异
 *   沉淀成数据后，processTool 只写一份，加工具＝加一行。
 *
 * 重要约束（照抄网关行为，别自作主张）：
 *   - 视频/音频工具网关用 DisallowUnknownFields 解码，body 里多一个字段就 400。
 *     所以「用户没传的字段一律不下发」，绝不能补空串/0/false 占位。
 */

/** 工具分类，决定输入字段名与输出配置支持情况 */
export type ToolCategory = "image" | "video" | "audio";

/** 参数值类型，决定从 argv 字符串怎么解析 */
export type ParamType = "string" | "int" | "float" | "list" | "boolean";

/** 一个工具参数（对应一个 CLI option） */
export interface ToolParam {
  /** CLI flag 主体（camelCase，如 "aspectRatio" → --aspect-ratio <v>） */
  flag: string;
  /** 下发到请求体的字段名（snake_case，与网关协议字面一致） */
  field: string;
  /** 值类型 */
  type: ParamType;
  /** 枚举白名单；给了就在 CLI 侧先校验（buildBody 的 checkChoices），省一次必然 400 的网络往返 */
  choices?: readonly string[];
  /** 数值下界（含）；仅 int/float，给了就在 CLI 侧先校验 */
  min?: number;
  /** 数值上界（含）；仅 int/float，给了就在 CLI 侧先校验 */
  max?: number;
  /**
   * 是否必填。由 commander 的 requiredOption 强制，缺失时在解析阶段就报错，
   * 不会进到业务逻辑。
   */
  required?: boolean;
  /** 取值说明，用于 --help 与 +tool list */
  helpKey: string;
}

/** 一个工具的完整声明 */
export interface ToolSpec {
  /** 对外 tool_id，即 URL 里的路径片段 */
  id: string;
  category: ToolCategory;
  /** 主输入字段名（image_url / video_url / audio_url）。当前全为单值。 */
  inputField: "image_url" | "video_url" | "audio_url";
  /**
   * 预留：主输入是否为多值。
   *
   * 当前全部工具都是单文件输入（网关侧均为单 string 字段），恒为 false。
   * 将来若出现 video-concat / video-mixcut 这类天然多输入的工具，把它置 true，
   * 该工具的主输入改为可重复 option，其余工具不受影响——两种形态可按工具共存。
   * （多输入能力目前只存在于 videogen / MPS ConcatInput / agent mixcut 等
   *   其它产品面，不在 /v1/wand/tool/* 这组处理工具上。）
   */
  inputIsArray?: boolean;
  /** 工具特有参数 */
  params: readonly ToolParam[];
  /** 一句话能力说明，用于 +tool list */
  descKey: string;
}

/** 图片输入字段（两种写法：http(s):// 公网 URL / data:<mime>;base64,<payload>） */
const IMAGE_URL = "image_url" as const;
const VIDEO_URL = "video_url" as const;
const AUDIO_URL = "audio_url" as const;

/** 图片超分参数（image-super-resolution） */
const SUPER_RESOLUTION_PARAMS: readonly ToolParam[] = [
  {
    flag: "type",
    field: "type",
    type: "string",
    choices: ["standard", "super", "ultra"],
    helpKey: "tool.opt.superType",
  },
  {
    flag: "mode",
    field: "mode",
    type: "string",
    choices: ["aspect", "fixed", "percent"],
    helpKey: "tool.opt.superMode",
  },
  { flag: "percent", field: "percent", type: "float", helpKey: "tool.opt.percent" },
  { flag: "width", field: "width", type: "int", helpKey: "tool.opt.width" },
  { flag: "height", field: "height", type: "int", helpKey: "tool.opt.height" },
  { flag: "longSide", field: "long_side", type: "int", helpKey: "tool.opt.longSide" },
  { flag: "shortSide", field: "short_side", type: "int", helpKey: "tool.opt.shortSide" },
];

/** 视频输出规格（转码/增强/插帧族共用，全部可选） */
const VIDEO_OUTPUT_SPEC: readonly ToolParam[] = [
  { flag: "resolution", field: "resolution", type: "string", helpKey: "tool.opt.resolution" },
  {
    flag: "container",
    field: "container",
    type: "string",
    choices: ["MP4"],
    helpKey: "tool.opt.containerVideo",
  },
  {
    flag: "codec",
    field: "codec",
    type: "string",
    choices: ["H264", "H265", "AV1"],
    helpKey: "tool.opt.codecVideo",
  },
  { flag: "maxVideoBitrate", field: "max_video_bitrate", type: "int", min: 128, max: 35000, helpKey: "tool.opt.maxVideoBitrate" },
  { flag: "fps", field: "fps", type: "int", min: 1, max: 120, helpKey: "tool.opt.fpsOutput" },
];

/** 音频输出规格（降噪/分离共用，全部可选） */
const AUDIO_OUTPUT_SPEC: readonly ToolParam[] = [
  {
    flag: "container",
    field: "container",
    type: "string",
    choices: ["mp3", "flac", "ogg", "m4a"],
    helpKey: "tool.opt.containerAudio",
  },
  {
    flag: "codec",
    field: "codec",
    type: "string",
    choices: ["mp3", "flac", "aac", "ac3"],
    helpKey: "tool.opt.codecAudio",
  },
  {
    flag: "sampleRate",
    field: "sample_rate",
    type: "int",
    choices: ["32000", "44100", "48000"],
    helpKey: "tool.opt.sampleRate",
  },
];

/** 全部工具。顺序即 +tool list 的展示顺序（分类内按对客文档排列） */
export const TOOL_SPECS: readonly ToolSpec[] = [
  // ── 图片 ──
  {
    id: "image-super-resolution",
    category: "image",
    inputField: IMAGE_URL,
    descKey: "tool.desc.superResolution",
    params: SUPER_RESOLUTION_PARAMS,
  },
  {
    id: "image-outpainting",
    category: "image",
    inputField: IMAGE_URL,
    descKey: "tool.desc.outpainting",
    params: [
      {
        flag: "aspectRatio",
        field: "aspect_ratio",
        type: "string",
        choices: ["1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"],
        helpKey: "tool.opt.aspectRatio",
      },
      { flag: "width", field: "width", type: "int", helpKey: "tool.opt.width" },
      { flag: "height", field: "height", type: "int", helpKey: "tool.opt.height" },
    ],
  },
  {
    id: "image-cutout",
    category: "image",
    inputField: IMAGE_URL,
    descKey: "tool.desc.cutout",
    params: [
      {
        flag: "version",
        field: "version",
        type: "string",
        choices: ["cutout-1.0-lite", "cutout-1.0-flash"],
        required: true,
        helpKey: "tool.opt.cutoutVersion",
      },
    ],
  },
  {
    id: "image-erase",
    category: "image",
    inputField: IMAGE_URL,
    descKey: "tool.desc.erase",
    params: [
      { flag: "prompt", field: "prompt", type: "string", required: true, helpKey: "tool.opt.prompt" },
    ],
  },

  // ── 视频 ──
  {
    id: "video-transcode",
    category: "video",
    inputField: VIDEO_URL,
    descKey: "tool.desc.transcode",
    params: [
      ...VIDEO_OUTPUT_SPEC,
      { flag: "removeAudio", field: "remove_audio", type: "boolean", helpKey: "tool.opt.removeAudio" },
      {
        flag: "compressType",
        field: "compress_type",
        type: "string",
        choices: ["standard_compress", "ultra_compress"],
        helpKey: "tool.opt.compressType",
      },
    ],
  },
  {
    id: "video-enhance-premium",
    category: "video",
    inputField: VIDEO_URL,
    descKey: "tool.desc.enhancePremium",
    // 增强等级仅支持 Standard（默认），不作为可选参数暴露。
    params: [...VIDEO_OUTPUT_SPEC],
  },
  {
    id: "video-interpolate-frames",
    category: "video",
    inputField: VIDEO_URL,
    descKey: "tool.desc.interpolateFrames",
    params: [
      // 插帧的 fps 是「目标帧率」且必填，与输出规格里的可选 fps 语义冲突，
      // 故这里剔除 VIDEO_OUTPUT_SPEC 的 fps，单独声明一个必填的。
      ...VIDEO_OUTPUT_SPEC.filter((p) => p.field !== "fps"),
      { flag: "fps", field: "fps", type: "int", required: true, min: 1, max: 100, helpKey: "tool.opt.fpsTarget" },
    ],
  },
  {
    id: "video-enhance-color",
    category: "video",
    inputField: VIDEO_URL,
    descKey: "tool.desc.enhanceColor",
    params: [
      ...VIDEO_OUTPUT_SPEC,
      {
        flag: "level",
        field: "level",
        type: "string",
        choices: ["Weak", "Normal", "Strong"],
        helpKey: "tool.opt.levelColor",
      },
    ],
  },
  {
    id: "video-erase",
    category: "video",
    inputField: VIDEO_URL,
    descKey: "tool.desc.videoErase",
    params: [
      {
        flag: "version",
        field: "version",
        type: "string",
        choices: ["Lite", "Premium"],
        helpKey: "tool.opt.eraseVersion",
      },
    ],
  },
  {
    id: "video-privacy-mask",
    category: "video",
    inputField: VIDEO_URL,
    descKey: "tool.desc.privacyMask",
    params: [
      {
        flag: "target",
        field: "target",
        type: "string",
        choices: ["Face", "FacePlate"],
        helpKey: "tool.opt.target",
      },
      {
        flag: "effect",
        field: "effect",
        type: "string",
        choices: ["Blur", "Mosaic"],
        helpKey: "tool.opt.effect",
      },
    ],
  },
  {
    id: "dubbing",
    category: "video",
    inputField: VIDEO_URL,
    descKey: "tool.desc.dubbing",
    params: [
      {
        flag: "dstLanguage",
        field: "dst_language",
        type: "string",
        choices: ["zh", "en"],
        required: true,
        helpKey: "tool.opt.dstLanguage",
      },
    ],
  },

  // ── 音频 ──
  {
    id: "audio-denoise",
    category: "audio",
    inputField: AUDIO_URL,
    descKey: "tool.desc.denoise",
    params: [...AUDIO_OUTPUT_SPEC],
  },
  {
    id: "audio-separate",
    category: "audio",
    inputField: AUDIO_URL,
    descKey: "tool.desc.separate",
    params: [
      ...AUDIO_OUTPUT_SPEC,
      {
        flag: "track",
        field: "track",
        type: "list",
        choices: ["Vocal", "Background"],
        required: true,
        helpKey: "tool.opt.track",
      },
      {
        flag: "scene",
        field: "scene",
        type: "string",
        choices: ["Normal", "Music"],
        helpKey: "tool.opt.scene",
      },
    ],
  },
];

/** tool_id → spec 的索引，供按 id 查找 */
const BY_ID = new Map(TOOL_SPECS.map((s) => [s.id, s]));

/** 按 tool_id 查 spec，未收录返回 undefined */
export function toolSpecOf(id: string): ToolSpec | undefined {
  return BY_ID.get(id);
}

/** 全部 tool_id，供错误提示列出可选值 */
export function allToolIds(): string[] {
  return TOOL_SPECS.map((s) => s.id);
}
