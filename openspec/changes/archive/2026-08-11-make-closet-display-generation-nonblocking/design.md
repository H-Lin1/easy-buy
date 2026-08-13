## Context

见 `proposal.md` 的 Why。当前上传在完成原图 Storage 和衣橱建档后并行启动识别与展示图请求，但两条分支共用同一 `busyClosetItemIds`，并在客户端用完整 Route 响应替换整条 `ClothingItem`。展示图 Route、识别 Route 和确认 Route 还会各自读取再写回完整 `image_quality_flags` 数组，因此允许提前确认后会暴露丢失更新竞态。

现有数据库已经提供 `display_image_path`、`display_image_status`、`display_image_model` 和 `display_image_prompt_version`，无需为本次轻量版新增字段。Next.js 16 Route Handler 使用标准 `Request` / `Response` 接口，POST 默认不缓存；页面已是 Client Component，适合管理当前会话内的异步状态和通知。

## Goals / Non-Goals

**Goals:**

- 让确认按钮的可用时间由识别分支决定，不受展示图分支约五十秒的耗时影响。
- 建立明确的操作状态与字段所有权，保证确认和展示图任意完成顺序都不丢数据。
- 保留现有供应商、Storage、认证和性能 trace，同时让展示图任务在当前 SPA 会话内非阻塞地收尾。
- 提供不会因批量上传造成通知轰炸的应用级结果反馈。

**Non-Goals:**

- 不实现刷新或关闭标签页后的持久化任务续跑。
- 不引入队列 worker、Supabase Realtime、通知表或跨设备已读状态。
- 不在本次改动中优化供应商本身的约四十秒响应头等待，也不把 embedding 确认改成后台任务。
- 不改变原图上传与建档仍先于两条 AI 分支的现有顺序；该“修正 1”前置链路并行化留作独立优化。

## Decisions

### 1. 按操作拆分忙碌状态

客户端分别维护 analysis、confirmation、display 和 deletion 的按衣服 ID 计数。确认按钮只受全局上传准备、analysis、confirmation 和 deletion 影响，不受 display 影响；删除和重复展示图操作仍受 display 影响，避免生成期间删除记录或重复调用。

选择计数而不是单个布尔值，是因为重新识别队列当前会在队列调度和实际请求两层持有状态，计数可以正确处理嵌套开始/结束。替代方案是继续共用一个 busy Set，但它无法表达“展示图忙碌不阻塞确认”的产品语义。

所有异步任务和清理动作都绑定发起时的登录会话 epoch。登出、切换用户或重新登录后，旧任务可以在服务端自然结束，但客户端会忽略其迟到结果和 finally 清理，避免旧任务提前释放新会话的上传锁、忙碌计数或队列并发名额。

### 2. `display_image_status` 是展示图唯一工作流状态

新建记录仅在 `display_image_status` 写入 `queued`，不再新增 `display_image_queued` 质量标记。展示图 Route 只更新展示图路径、状态、模型和提示词版本，不读取或写入 `image_quality_flags`，也不写入整行共享的 `updated_at`；其中 claim 只写 `processing`，成功提交四个展示字段，失败只写 `failed`。识别 Route 也不再删除展示图标记。客户端过滤旧记录残留的 `display_image_*` 质量标记，并通过 status 渲染排队、处理中、成功或失败。

这避免同一状态存在两套事实来源，也消除了展示图与慢 embedding 确认之间对 flags 整列读改写的冲突。历史标记无需迁移即可被安全忽略，后续可单独做数据清理。

### 3. Route 响应按字段所有权合并

客户端为三类结果使用纯合并函数：

- analysis 只合并 AI 草稿标签、分析质量标记、置信度和未确认状态；
- confirmation 只合并用户确认标签、embedding 文本、确认标记和质量标记；
- display 只合并展示图路径、状态、模型、版本和新签名 URL。

展示图 Route 改为返回窄化后的展示图记录，客户端只为新 `display_image_path` 获取签名 URL。识别和确认 Route 暂时可以保留完整数据库响应以减少接口改动，但其客户端消费端仍只合并所属字段。替代方案是用 `updated_at` 做最后写入胜出；由于三个分支都会更新该字段，它不能表达领域所有权，会让合法并行结果互相覆盖。

识别 Route 的初次上传 claim 同时要求 `user_corrected = false` 且尚无 `closet_analysis_processing`，避免多标签页或重复请求并行调用视觉供应商。每次取得 claim 时还会写入短期 `closet_analysis_owner:<uuid>` 标记；成功提交与失败清理都必须同时持有通用 processing 标记和本请求的 owner 标记，并在收尾时删除 owner。若确认先完成，确认流程会删除 processing 与 owner，识别只读回权威记录并返回冲突。用户主动重新识别通过显式 intent 区分：已确认记录先以读取时的 `updated_at`、processing 和独立 owner 条件取得处理权；即使确认完成后又有新识别请求取得 processing，旧请求也因 owner 不匹配而不能覆盖新状态。失败路径只在仍持有本请求 owner 时恢复已清除内部 owner 的原质量标记。客户端会过滤 owner 标记，并对主动重识别使用独立的分析草稿合并路径，保留展示图字段。

### 4. 条件状态转换提供轻量单飞

展示图 Route 以条件更新从 `queued`、`not_started`、`failed` 或 `ready` 取得 `processing` 所有权。若没有命中记录，返回 409，且此分支位于生成错误清理之外，避免重复请求把正在运行的任务标记为失败。成功和失败写入均附加 `display_image_status = processing` 条件。

本版不增加 generation ID，因为 processing 任务不能被第二个请求接管，正常路径中不会出现两个拥有者。代价是平台硬中断可能留下 processing；未来支持超时接管、持久化 worker 或跨设备重试时，应新增 generation ID 和开始时间来阻止旧任务迟到覆盖。

### 5. 上传函数提前结束用户阶段，展示图独立收尾

建档后同时启动 analysis promise 与 display promise。上传函数等待 analysis 后更新“可以确认”的衣橱消息并返回；display promise 通过独立的收尾链继续更新展示图、完成现有 trace 并触发通知。所有 promise 都有显式错误处理，避免未处理 rejection。

性能 trace 的最终汇总仍等待两条 AI 分支和展示图资源加载，因此继续代表完整端到端时间；它不会阻塞识别完成后的交互。

上传按钮使用批次级锁，锁的生命周期覆盖原图建档和本批全部识别任务；展示图 promise 的最终收尾不参与解锁判断。

### 6. 根层聚合通知

`Home` 根层持有当前通知，按 closet item ID 合并同一显示周期内的完成事件；同一 ID 的新结果覆盖旧结果。通知单件时显示当前衣服名称，多件时显示成功和失败数量，提供关闭按钮与“查看衣橱”动作，并使用 `role="status"` 与 `aria-live="polite"`。新事件会重置自动关闭计时。

通知不放在 `ClosetView` 内，否则切换到聊天或设置时会随视图卸载。替代方案是新增第三方 toast 库，但本次仅需一个受控通知且仓库已有图标与样式能力，无需增加依赖。

签名 URL 或最终图片加载失败时，通知使用“状态待刷新确认”警告，避免把数据库已 ready 等同于用户已经看到可用预览。

客户端在拿到签名 URL 后独立预加载展示图资源，因此即使用户已经切换到聊天或设置视图，也能验证 URL 是否实际可读并触发通知；衣橱里的原生图片加载事件继续作为额外校验和性能 trace 的实际渲染信号。

### 7. 原图与展示图采用不同适配方式

共享衣橱图片组件接受显式的 `cover` 或 `contain` 适配模式。当前呈现的是生成展示图时，确认面板和衣橱卡片均使用白色背景与 `object-contain`，保证完整衣服轮廓可见；用户切换到原图或记录尚无展示图时，继续使用原有的 `object-cover` 填满区域。

不根据 URL 或图片尺寸猜测图片类型，而由调用位置结合 `showOriginal` 和 `displayImageUrl` 明确选择模式。这样不改变生图文件本身，也不会让普通上传照片产生额外留白。

## Risks / Trade-offs

- [浏览器刷新会中断或遗失展示图任务] → 明确限定为当前会话轻量版；后续以持久化任务和对账机制解决。
- [Route 在 processing 后被平台硬终止会留下卡住状态] → 本版不允许自动接管以换取无 migration 的单写者保证；用户可在状态人工修复后重试，下一阶段加入 generation ID 与超时策略。
- [识别 Route 在取得 processing 与 owner 后被平台硬终止也可能留下卡住标记] → 本版不在无租约时冒险自动接管；后续持久化任务阶段统一增加租约和超时恢复。
- [确认仍需等待 embedding API] → 本次只解除展示图阻塞，并在验收中单独观察确认耗时；必要时建立后续变更。
- [历史展示图 flags 仍在数据库] → UI 统一忽略，展示图 Route 不再产生新值；不影响正确性。
- [批量上传时通知内容在显示期间变化] → 按 ID 聚合并重置关闭计时，保证最终数量稳定可读。
- [主动重识别与另一标签页确认同时发生] → 以处理标记和读取时版本条件提交；冲突时回读权威确认记录，后续可用 generation ID 进一步支持跨会话接管。
- [生成图与卡片比例不同导致内容被裁切] → 仅对生成展示图使用白底 `contain`；原图继续使用 `cover`，保持既有浏览体验。

## Migration Plan

1. 部署兼容现有 schema 的 Route 与客户端修改，不执行数据库 migration。
2. 在 Preview 上传单件和多件衣服，验证识别完成后即可确认，展示图完成顺序不影响确认数据。
3. 观察现有 trace 和 Vercel 日志，确认 display 单飞冲突不调用供应商且无新增敏感日志。
4. 如需回滚，可整体回退客户端与 Route 修改；数据库没有不可逆变化，旧 flags 仍可由旧代码读取。
