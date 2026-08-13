## Purpose

为云端衣橱上传提供可关联、可分阶段且不泄露敏感信息的性能记录，使开发者能够准确区分浏览器、应用服务、AI 供应商、Storage、数据库和最终图片加载的耗时，并据此选择后续优化方向。

## ADDED Requirements

### Requirement: 每件上传具有端到端关联标识
系统 SHALL 为每件新上传的衣服生成独立 trace ID，为视觉识别和展示图 HTTP 请求分别生成 request ID，并在浏览器计时、响应头和服务端日志中保留相应标识。

#### Scenario: 单件上传关联两条 AI 分支
- **WHEN** 用户上传一张衣服图片并同时触发视觉识别和展示图生成
- **THEN** 浏览器汇总、视觉识别 Route 和展示图 Route 的诊断记录包含同一 trace ID，且两条 Route 各自具有不同 request ID

#### Scenario: 批量上传隔离记录
- **WHEN** 用户一次上传多张衣服图片
- **THEN** 每件衣服拥有不同 trace ID，且并发任务的计时记录不会相互混合

### Requirement: 上传链路提供分阶段耗时
系统 SHALL 使用单调时钟记录浏览器上传阶段、两条 AI Route 的服务端阶段以及展示图资源加载阶段，并分别保留并行分支的开始偏移和持续时间，而不是把并行耗时直接相加。

#### Scenario: 成功上传产生完整阶段记录
- **WHEN** 一件衣服完成原图保存、视觉识别和展示图生成
- **THEN** 记录能够区分文件读取、原图 Storage、记录插入、初始签名 URL、Route 总耗时、鉴权、数据库前置、AI 供应商、响应处理、展示图 Storage、数据库收尾、最终签名 URL 和展示图加载

#### Scenario: 并行分支保持真实时间关系
- **WHEN** 视觉识别和展示图生成并行执行且完成时间不同
- **THEN** 诊断结果分别报告两条分支的开始偏移和持续时间，并报告端到端总耗时

### Requirement: 服务端计时可从请求和日志观察
视觉识别和展示图 Route SHALL 在响应中返回关联标识和标准 `Server-Timing` 阶段，并为每个 Route 请求输出至多一条结构化汇总日志。

#### Scenario: 浏览器检查成功响应
- **WHEN** AI Route 成功返回
- **THEN** 响应包含 `X-Closet-Trace-Id`、`X-Request-Id` 和可解析的 `Server-Timing`，Vercel 日志包含相同标识、Route 名称、状态与阶段耗时

#### Scenario: 浏览器检查失败响应
- **WHEN** 请求验证、鉴权、供应商或持久化阶段失败
- **THEN** 已完成阶段仍被记录，响应和结构化日志标记失败状态，且原有 HTTP 状态和用户错误行为保持不变

### Requirement: 展示图供应商响应边界可独立诊断
展示图 Route SHALL 将供应商响应头等待、响应体读取和 JSON 解析记录为独立阶段，并 SHALL 仅从现有供应商响应中提取经过净化的白名单诊断字段，不得因此新增远程请求。

#### Scenario: 成功响应区分传输与解析
- **WHEN** 展示图供应商返回成功的 JSON 响应
- **THEN** 服务端汇总分别包含 `provider_fetch_ttfb`、`provider_response_body_read` 和 `provider_response_json_parse`，并包含 HTTP 状态、实际响应字节数以及存在且有效的请求 ID、`Server-Timing` 或 `Content-Length`

#### Scenario: 供应商诊断头缺失或异常
- **WHEN** 白名单响应头缺失、格式无效或超过允许长度
- **THEN** 系统忽略相应可选字段并继续原有业务处理，且不会记录完整响应头或原始异常值

#### Scenario: 响应体或 JSON 解析失败
- **WHEN** 读取供应商响应体或解析 JSON 失败
- **THEN** 对应阶段标记失败，Route 仍沿用既有失败状态和 HTTP 行为，并输出一条不含响应正文的结构化计时汇总

### Requirement: 诊断数据不得包含敏感内容
性能记录 MUST 仅包含白名单诊断字段，并 MUST NOT 包含 API Key、访问令牌、Authorization 头、图片或 Base64 内容、完整提示词、签名 URL、用户邮箱或其他用户输入正文。

#### Scenario: 检查结构化记录
- **WHEN** 成功与失败请求生成性能汇总
- **THEN** 汇总仅包含关联标识、操作名称、Route、结果状态、阶段耗时、HTTP 状态、非敏感大小信息及经过净化的供应商请求 ID 和计时元数据

### Requirement: 监控不增加远程业务操作
性能监控 SHALL NOT 为保存计时结果新增数据库写入、Storage 操作或第三方监控请求，并 SHALL NOT 改变 AI 模型、并发限制、上传状态或页面交互。

#### Scenario: 对比启用计时前后的业务调用
- **WHEN** 相同上传流程启用分段计时
- **THEN** 原有业务网络调用数量保持不变，仅响应头与本地或平台日志增加诊断信息
