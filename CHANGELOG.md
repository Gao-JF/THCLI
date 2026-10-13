[English](./CHANGELOG.en.md) | 简体中文

# Changelog

所有值得注意的变更记录于此文件。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增

- **媒体处理工具**：新增 `+tool` 命令组，对图片 / 视频 / 音频做 AI 处理（图片超分/抠图/扩图/擦除，视频转码/大模型增强/插帧/色彩增强/擦除/隐私打码/翻译配音，音频降噪/人声分离）。**默认异步**（提交后立即返回 `task_id` 与 `request_id`，任务耗时可能很长）；加 `--wait` 则同步轮询到终态并打印结果；`+tool task <tool_id> <task_id>` 查询任务。
- **工具列表**：新增 `tools list`，本地列出可用的媒体处理工具（不联网）；`--json` 输出机读 schema（参数名/类型/必填/枚举/默认/说明），供脚本与 AI Agent 直接消费。
- 详见 [docs/media-tools.md](./docs/media-tools.md)。

## [1.0.0]

### 新增

- 首次开源发布。
- **短命令别名**：提供 `thcli` 与 `th` 两个等价命令，`th auth login` = `thcli auth login`。
- **模型**：列表、搜索、横向对比、价格查询。
- **API 密钥**：创建、查看、调整可访问范围与额度。
- **在线推理服务**：列表、详情、后付费开关。
- **对话**：文本与多模态推理，支持流式输出。
- **用量**：按模型 / 服务 / 密钥维度统计，趋势图，导出 CSV。
- **监控**：文本与非文本模型的服务健康度指标。
- **诊断**：`thcli doctor` 检查凭证、服务、模型、套餐，并解释错误码。
- **Agent Skills**：`thcli +connect` 注入 skills，让本地 AI Agent 用自然语言
  驱动 CLI。
- 中英双语界面（`--lang` 或 `thcli lang` 切换）。
