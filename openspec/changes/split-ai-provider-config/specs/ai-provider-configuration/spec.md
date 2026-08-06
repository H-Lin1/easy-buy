## Purpose

让部署维护者能够按识图、购买推理、向量检索和生图四种能力独立配置服务平台与凭据，避免共享密钥造成的隐式耦合，并为线上迁移、故障定位和未来替换供应商提供清晰边界。

## ADDED Requirements

### Requirement: AI 能力配置相互独立

系统 SHALL 为识图、购买推理、向量检索和生图分别读取独立的 provider、API Key、Base URL 和模型配置；任一能力 MUST NOT 读取或借用其他能力的 API Key。

#### Scenario: 同一平台使用不同密钥

- **WHEN** 识图与购买推理配置为同一平台但分别提供不同 API Key
- **THEN** 两种能力分别使用自己的 API Key 发起请求，且任一请求不使用另一能力的凭据

#### Scenario: 单项能力缺少密钥

- **WHEN** 一项能力未配置自己的 API Key，而其他能力已正确配置
- **THEN** 系统将该能力视为未配置，并执行该能力既有的缺失配置行为，而不借用其他能力的 Key

#### Scenario: 单独更换能力平台

- **WHEN** 部署维护者只修改其中一项能力的 provider、Base URL、API Key 和模型
- **THEN** 只有该能力后续请求使用新的平台配置，其他能力保持原配置

### Requirement: 支持的平台协议必须明确

系统 SHALL 仅为已实现适配器的平台发起能力请求，并 SHALL 在 provider 值不受支持时返回可定位到具体能力和 provider 的配置错误。

#### Scenario: 使用默认平台映射

- **WHEN** 识图和购买推理分别配置为 AutoDL，向量检索和生图分别配置为 SiliconFlow
- **THEN** 系统使用对应平台的受支持接口格式完成四种能力调用

#### Scenario: 使用 Tripo/Lumina 编辑衣橱展示图

- **WHEN** 生图能力配置为 `tripo`，具备完整独立配置，并提供待编辑的衣物图片
- **THEN** 系统使用 Bearer 鉴权向 `<base>/images/edits` 发起 multipart 请求，携带 `model`、`prompt` 和 `image[]`，且不手工设置 multipart `Content-Type`

#### Scenario: Tripo/Lumina 返回 Base64 图片

- **WHEN** Tripo/Lumina 的图片编辑响应提供 `data[].b64_json`
- **THEN** 系统在服务器端解码图片并写入既有图片存储流程，调用方继续收到既有生成结果形状，且不收到上游原始 Base64 或响应体

#### Scenario: 上游没有独立负向提示词字段

- **WHEN** 图片编辑上游协议不支持 `negative_prompt`
- **THEN** 系统将既有负向约束并入本次请求的主 prompt，且不丢失禁止项

#### Scenario: 生图平台缺少适配器

- **WHEN** 生图能力配置了当前没有图片接口适配器的 provider
- **THEN** 系统拒绝发起格式不确定的外部请求，并返回明确的生图平台不受支持错误

### Requirement: 能力级降级语义保持不变

系统 SHALL 在能力配置缺失或调用失败时继续使用该能力现有的错误或降级语义，配置拆分 MUST NOT 让一项能力的故障扩散为其他已配置能力不可用。

#### Scenario: 推理能力不可用

- **WHEN** 购买推理能力未配置或模型调用失败
- **THEN** 系统继续生成既有的规则兜底报告，并且不影响已正确配置的识图、向量或生图能力

#### Scenario: 向量能力不可用

- **WHEN** 向量检索能力未配置或外部向量请求失败
- **THEN** 系统继续使用既有的本地确定性向量，并且不读取生图能力的 Key

#### Scenario: 向量平台不受支持

- **WHEN** 向量检索能力配置了当前没有适配器的平台
- **THEN** 系统在发起外部请求前返回包含 `embedding` 能力和 provider 的配置错误，而不是把未知协议当作可用服务或借用其他能力的 Key

#### Scenario: 生图能力未配置

- **WHEN** 生图能力没有完整的独立配置
- **THEN** 生图接口返回明确的能力配置错误，而不是尝试使用向量或其他能力的凭据

### Requirement: 配置状态可安全诊断

系统 SHALL 按能力提供 provider、model 和是否配置完成的健康状态，并 MUST NOT 在健康响应、应用日志或错误消息中返回 API Key 的完整值或片段。

#### Scenario: 查看健康状态

- **WHEN** 部署维护者请求应用健康接口
- **THEN** 响应分别展示四种能力的 provider、model 和 configured 状态，且不包含任何 API Key

#### Scenario: 外部服务返回鉴权错误

- **WHEN** 某项能力的平台因无效 API Key 返回鉴权失败
- **THEN** 系统记录和返回经过清理的能力错误信息，且不记录请求 Authorization 头或 API Key

### Requirement: 旧共享环境变量不再生效

系统 MUST 只使用新的能力级 AI 环境变量；旧的 AutoDL 与 SiliconFlow 共享 API Key 和 Base URL 变量即使仍存在也 MUST NOT 参与配置解析。

#### Scenario: 仅保留旧变量部署

- **WHEN** 新版本部署只配置旧的共享平台变量而没有配置新的能力级变量
- **THEN** 四种能力分别按照其新配置的缺失状态处理，且系统不会静默回退到旧变量

#### Scenario: 新旧变量同时存在

- **WHEN** 部署环境同时存在新的能力级变量和旧的共享平台变量
- **THEN** 系统只使用新的能力级变量，旧变量不会改变任何能力的调用平台或凭据
