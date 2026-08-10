## Why

云端衣橱上传目前只能看到“识别完成”和“展示图完成”等结果状态，无法区分浏览器上传、Vercel Route、AI 供应商、Supabase Storage、数据库收尾和最终图片加载分别消耗了多少时间。先建立低开销、可关联且不暴露敏感信息的全链路计时，才能用生产数据决定后续优化顺序，并避免把供应商耗时和应用开销混为一谈。

## What Changes

- 为每件衣橱上传生成 trace ID，并为视觉识别与展示图 Route 请求分别生成 request ID，串联又隔离两条并行计时记录。
- 在浏览器侧记录文件读取、原图上传、数据库插入、签名 URL、AI Route 总耗时和上传流程总耗时。
- 在两条 AI Route 中记录请求解析、鉴权、数据库前置、供应商调用、响应处理、Storage 上传和数据库收尾等阶段。
- 将展示图供应商响应处理进一步拆分为响应体读取与 JSON 解析，并记录经过净化的请求 ID、`Server-Timing`、`Content-Length`、实际响应字节数和 HTTP 状态，以区分供应商等待、网络传输与本地解析耗时。
- 通过 `Server-Timing`、`X-Closet-Trace-Id` 和 `X-Request-Id` 返回单次请求的服务端阶段，并为 Vercel 输出单条结构化汇总日志。
- 对成功与失败路径使用相同的计时格式，并限制日志字段，禁止记录密钥、令牌、图片内容、完整提示词或签名 URL。
- 本阶段不改变上传交互、页面样式、AI 供应商、模型、并发策略、压缩策略或持久化结构；后续优化依据采集结果再更新本 change。

## Capabilities

### New Capabilities

- `closet-upload-observability`: 定义衣橱上传全链路的关联计时、安全诊断输出和可验证的性能监控契约。

### Modified Capabilities

无。

## Impact

- 影响衣橱上传客户端流程，以及视觉识别和展示图生成两个 Next.js Route Handler。
- 新增可在浏览器与服务端复用的轻量计时工具和针对性自动化测试。
- Vercel 日志量会增加为每条 AI Route 一条小型结构化记录；不新增数据库写入、外部监控依赖或网络请求。
- 展示图 Route 的供应商诊断只读取现有响应的白名单字段，不记录完整响应头、接口 URL、提示词、图片或 Base64 内容。
