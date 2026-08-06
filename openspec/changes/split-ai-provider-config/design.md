## Context

当前 [src/lib/env.ts](/Users/hlin/Documents/seasy-buy/src/lib/env.ts) 将 AutoDL 的 API Key/Base URL 共享给识图和购买推理，将 SiliconFlow 的 API Key/Base URL 共享给向量和生图；[src/lib/ai/providers.ts](/Users/hlin/Documents/seasy-buy/src/lib/ai/providers.ts) 也按这两组平台创建客户端。生图 Route Handler 还直接拼接 SiliconFlow 图片接口。此次迁移不涉及用户输入的凭据，也不改变 Supabase、提示词或既有降级结果。

## Goals / Non-Goals

**Goals:**

- 建立四个能力级配置：`vision`、`decision`、`embedding`、`imageEdit`。
- 每个能力独立解析 provider、API Key、Base URL、model 和适用的超时/维度参数。
- 让聊天/视觉/向量客户端共享通用配置解析，但由能力选择凭据；让图片调用通过显式 provider adapter 选择请求格式。
- 在配置解析层隔离缺失配置，并在健康接口中以不泄露密钥的方式诊断每项能力。
- 采用直接切换，不读取旧的共享变量；部署文档明确先配新变量、再部署、最后删除旧变量。

**Non-Goals:**

- 不在浏览器、Supabase 或个人设置中保存用户 API Key。
- 不在本次变更中增加新的第三方 SDK、数据库迁移、用户可配置 Base URL 界面或新的模型能力。
- 不改变当前识图、购买推理和向量的默认映射、业务提示词目标、应用对客户端的响应结构和能力级降级策略；仅当图片上游不支持独立 `negative_prompt` 字段时，将现有负向约束并入主 prompt。

## Decisions

### 1. 用能力前缀的扁平环境变量表达配置

新变量按以下能力命名：

```text
AI_VISION_PROVIDER / AI_VISION_API_KEY / AI_VISION_BASE_URL / AI_VISION_MODEL
AI_DECISION_PROVIDER / AI_DECISION_API_KEY / AI_DECISION_BASE_URL / AI_DECISION_MODEL
AI_EMBEDDING_PROVIDER / AI_EMBEDDING_API_KEY / AI_EMBEDDING_BASE_URL / AI_EMBEDDING_MODEL
AI_IMAGE_EDIT_PROVIDER / AI_IMAGE_EDIT_API_KEY / AI_IMAGE_EDIT_BASE_URL / AI_IMAGE_EDIT_MODEL
```

视觉、决策、向量和图片各自的超时参数也使用能力前缀；决策最大输出 token 和向量维度继续保持能力级配置。扁平变量比单个 JSON 环境变量更适合 Vercel 控制台逐项编辑，也能避免把多个密钥放进同一份结构化字符串。

备选方案是继续保留 `AUTODL_*`/`SILICONFLOW_*` 并加一层优先级解析。该方案虽更易回滚，但会保留用户明确想消除的共享语义，因此不采用。

### 2. 把 provider 作为适配器选择，而不是只当标签

配置解析器返回统一的 `AiCapabilityConfig`，其中包含能力、provider、凭据、Base URL、模型和运行参数。聊天与视觉请求使用 OpenAI 兼容客户端；向量请求使用同一客户端的 embeddings 方法；图片请求由 provider adapter 负责 endpoint、请求格式和响应归一化（远程 URL 或 Base64 图片字节）。

初始适配器登记当前已使用的平台：AutoDL 的聊天/视觉协议、SiliconFlow 的聊天/向量/图片编辑协议，以及 Tripo/Lumina 的图片编辑协议。未登记的 provider 在配置解析阶段标记为不支持，图片 Route Handler 不会对未知协议盲目发起请求。以后增加平台只需新增适配器和对应测试。

#### 图片编辑协议分流

SiliconFlow 保持 JSON `POST <base>/images/generations`，请求体为模型、主提示词、独立负向提示词和图片 data URL。Tripo/Lumina 使用 multipart `POST <base>/images/edits`，表单提交 `model`、`prompt` 和 `image[]`。服务端先将输入 data URL 转为带 MIME 类型和文件名的 Blob；multipart 请求不手工设置 `Content-Type`，由 `fetch` 写入 boundary。

Tripo/Lumina 未文档化独立的 `negative_prompt` 字段，因此适配器将既有负向约束以明确禁止项并入主 prompt。适配器接受远程 URL 以及 `data[].b64_json`；后者仅在服务器解码后沿用既有 Supabase 上传流程，绝不返回或记录上游的原始 Base64、请求体或响应体。

### 3. 配置完整性按能力判断

能力配置只有在 provider、API Key、Base URL 和 model 都存在且 provider 有适配器时才视为 `configured`。解析器只返回当前能力的 Key；不会提供跨能力的默认 Key。缺少配置时，调用层按现有行为处理：决策使用规则报告、向量使用确定性向量、识图返回/捕获既有错误、生图返回能力配置错误。

### 4. 保持 Route Handler 的认证边界

所有 AI Route Handler 继续使用 Node.js runtime，并在调用 provider 前执行现有 Supabase Bearer token 校验。能力配置本身来自服务器环境变量，不进入请求体、客户端 bundle、健康响应或日志。外部错误只保留状态码和经过清理的能力/provider 信息，避免 SDK 错误对象或 Authorization 头被直接序列化。

### 5. 健康接口按能力输出非敏感元数据

`/api/health` 增加 `ai` 对象，分别返回四项能力的 `provider`、`model` 和 `configured`。不返回 Key、Base URL 中可能携带的凭据、Authorization 信息或完整外部错误。这样可用部署 URL 验证 Vercel 是否读取了新变量，而不提供密钥探针。

## Risks / Trade-offs

- [破坏性变量迁移导致部署短暂缺 Key] → 在部署前先将四套新变量填入 Vercel 的 Production/Preview，先验证 Preview，再发布 Production；旧变量只在迁移完成前保留在安全记录中，不参与新代码运行。
- [回滚需要旧变量] → 删除旧变量前由维护者保留旧值的安全备份；回滚顺序为恢复旧变量、回退代码、重新部署。
- [不同平台声称 OpenAI 兼容但图片协议不同] → 图片能力强制经过 provider adapter；未知 provider 直接配置错误，不发送猜测格式。
- [不同图片协议及 Base64 输出] → 为两种适配器增加 mock 请求合约测试；失败只返回清理后的能力/provider 错误，不能打印请求体、响应体或凭据。
- [能力配置数量增加] → `.env.example`、健康接口和部署清单使用相同的四能力顺序，并通过解析器单元测试防止漏配或串用。
- [向量模型维度与数据库 vector(1024) 不匹配] → 保留现有维度归一化逻辑，并在配置校验和测试中明确 `AI_EMBEDDING_DIMENSIONS` 与持久化向量契约。

## Migration Plan

1. 在本地和 Vercel Production/Preview 创建四套新变量。识图、购买推理和向量可按现有映射复制平台、Key、Base URL 和模型；生图可保留 SiliconFlow，或在切换时填入 Tripo/Lumina 的 `AI_IMAGE_EDIT_*` 值。此时旧代码仍忽略新变量，不会影响现网。
2. 在能力分支部署 Preview，调用 `/api/health` 检查四项 `configured` 状态，并分别验证识图、购买推理、向量确认和所选生图 provider 的路径；使用 Tripo/Lumina 时确认图片编辑请求与结果存储正常。
3. 合并到生产分支并等待 Vercel 新部署完成；环境变量修改后必须重新部署才会进入新的 Function 运行时。
4. 观察生产日志和关键流程确认无误后，从 Production/Preview 删除旧的 `AUTODL_*` 与 `SILICONFLOW_*` 共享变量。
5. 若需回滚，恢复旧变量、回退到旧代码提交并重新部署；不在新代码中恢复兼容读取。
