## Why

当前识图与购买推理共用一组 AutoDL 平台配置，生图与向量检索共用一组 SiliconFlow 平台配置，导致单项能力无法独立更换平台、密钥或连接地址。将配置按能力拆分后，部署维护者可以单独调整和排查每条 AI 调用链，同时保持现有用户功能与默认供应商不变。

## What Changes

- 为识图、购买推理、向量检索和生图分别定义独立的 provider、API Key、Base URL、模型及相关运行参数。
- 将服务商客户端改为按能力解析配置，避免通过 AutoDL 或 SiliconFlow 的共享 Key 隐式绑定多个能力。
- 生图调用通过能力级配置选择已支持的图片服务适配器：保留 SiliconFlow 的 JSON `/images/generations` 请求，新增 Tripo/Lumina 的 multipart `/images/edits` 请求，并将远程 URL 或 Base64 图片结果统一交给既有 Supabase 存储流程。
- 健康检查按能力报告 provider、model 和是否完成配置，但绝不返回 API Key 或其他密钥内容。
- 更新 `.env.example` 和部署说明，提供本地与 Vercel 的新变量清单及迁移顺序。
- **BREAKING**：删除运行时对 `AUTODL_API_KEY`、`AUTODL_OPENAI_BASE_URL`、`SILICONFLOW_API_KEY` 和 `SILICONFLOW_BASE_URL` 的读取，不保留旧变量兼容层；部署必须在新版本启用前配置新的能力级变量。
- **Non-goals:** 不提供个人设置中的用户 API Key 功能，不新增数据库凭据表，不开放任意供应商协议，不改变业务提示词目标、业务降级语义、应用对客户端的响应结构或 Supabase 数据模型；仅当上游协议不支持独立的 `negative_prompt` 时，以等价文本并入主 prompt。

## Capabilities

### New Capabilities

- `ai-provider-configuration`: 定义四种 AI 能力的独立平台配置、配置校验、调用隔离、健康信息与破坏性环境变量迁移行为。

### Modified Capabilities

无。

## Impact

- 影响 `src/lib/env.ts`、`src/lib/ai/providers.ts`、AI Route Handlers、购买决策工作流和 `/api/health`。
- 影响本地 `.env.local` 与 Vercel Production/Preview 环境变量配置；不涉及数据库迁移。
- 需要为能力配置解析、客户端隔离、缺失配置降级和密钥不外泄增加定向测试。
- 识图与购买推理可继续使用 AutoDL，向量检索可继续使用 SiliconFlow；生图可独立配置为 SiliconFlow 或 Tripo/Lumina，切换生图供应商只会改变该能力的上游协议与生成结果。
