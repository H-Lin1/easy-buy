## Context

见 `proposal.md`。当前聊天页只有一份 `activeChatId + chatState`，同步决策请求返回后由浏览器保存消息，真人搭配请求还绑定组件的 `AbortController`。Supabase 已提供会话、消息、候选、报告和 `outfit_try_on_images` 持久化表，Next.js 16 提供 `after()`，但其回调仍受 Route 的平台最大执行时长约束。

## Goals / Non-Goals

**Goals:**

- 让服务端持久化状态而非 React 组件决定新决策的生命周期。
- 让任何阶段都能安全重试，并在 Worker 中断、页面切换或实时连接丢失后恢复。
- 保持文字先返回、最多三张真人图并行生成的产品时序。
- 在不引入通用任务系统的前提下，为部署环境提供即时启动和定时恢复两个入口。

**Non-Goals:**

- 不迁移历史已完成会话，不改变旧消息读取协议。
- 不修改 AI 模型、Prompt、召回或搭配数量规则。
- 不承诺取消已经发往第三方供应商的单个 HTTP 请求能够立即停止；取消保证的是不再启动后续阶段且迟到结果不能提交。
- 不提供用户可见的任务中心、优先级控制或手动暂停功能。

## Decisions

### 1. `decision_runs` 是新任务的唯一事实源

新增 `decision_runs` 保存输入快照、`session_id`、稳定 `client_request_id`、总体状态、当前阶段、结果引用、阶段时间、错误、尝试次数和执行租约。总体状态使用 `queued | running | completed | completed_with_errors | failed | cancelled`，阶段使用 `queued | analyzing_candidate | retrieving_context | deciding | decision_ready | generating_try_ons | completed`。总体状态表达调度与终态，阶段表达用户可见进度，避免把所有组合塞进一个枚举。

候选商品、报告、聊天消息与真人搭配行增加 `decision_run_id` 唯一关联。重复 Worker 通过此关联复用已保存结果，而不是根据文本或时间推测。历史行保持 `NULL`，因此无需回填。

备选方案是只在 `chat_sessions` 增加状态字段；它无法表达同一会话的运行身份、幂等请求和租约，也会把执行状态与会话展示状态耦合，故不采用。

### 2. 提交接口只负责可靠接收

`POST /api/ai/decision-runs` 验证 Bearer token 与会话所有权，上传截图，并通过服务端数据库操作创建用户消息与 `queued` run，然后返回 `202`。客户端生成 UUID `clientRequestId`；`(user_id, client_request_id)` 唯一约束让网络重试返回同一 run。输入保存 Storage 路径和用户资料快照，不把 Base64 写入数据库。

创建成功后通过 `after()` 尝试立即调度。根据 Next.js 16 文档，`after()` 只在 Route 配置的最大时长内运行，因此它是低延迟快路径而非唯一恢复来源。

### 3. 决策与真人搭配是可恢复的两个阶段

服务端 Runner 每次持有 run 租约后根据已保存阶段执行：

1. 下载截图并识别候选商品；候选以 `decision_run_id` 幂等保存。
2. 复用候选 embedding，读取衣橱并执行当前 RAG 与决策模型；报告和助手消息以 `decision_run_id` 幂等保存。
3. 把阶段提交为 `decision_ready`，此时前端即可读取文字报告。
4. 创建最多三个稳定 `outfit_try_on_images` 子任务并进入 `generating_try_ons`；三个任务继续使用 `Promise.allSettled` 并行。
5. 根据图片结果提交 `completed` 或 `completed_with_errors`。

现有 `/api/ai/assess-purchase` 可保留无图引导能力；包含截图的新前端流程改用运行接口。现有真人图接口改为读取持久化结果或触发恢复，不能再把浏览器断开信号作为任务取消信号。

### 4. 原子租约同时保证所有权和每用户两个并发名额

数据库 RPC 按用户取得事务级 advisory lock，先回收租约过期的 `running` 行，再统计有效租约；不足两个时按 `created_at` 原子认领最早的 `queued` 行。认领写入随机 `lease_token`、`lease_expires_at` 和递增的 `attempt_count`。Worker 的阶段提交必须同时匹配 `id + lease_token + running`，取消或换租后旧 Worker 无法提交。

租约覆盖一个最慢 AI 阶段并留出上传时间。Runner 在进入下一阶段前续租；平台硬中断后，定时恢复扫描或后续状态查询会在租约过期后重新排队。失败结果使用稳定错误码，不向客户端暴露供应商凭据或原始错误。

备选方案是在内存中维护 Promise 与并发计数；多实例、刷新和部署后都会丢失，故不采用。

### 5. `after()` 快速启动，恢复接口保证最终可继续

创建、读取活动运行和 Realtime 重连时都会安排一次受租约保护的调度；另提供带部署密钥保护的恢复 Route，供 Vercel Cron 或等价定时器扫描 `queued` 与租约过期运行。调度调用是可重复的，数据库认领决定唯一执行者。

首版不增加第三方队列依赖。代价是平台中断后的恢复延迟取决于恢复扫描频率；建议生产环境每分钟调用一次。若以后接入耐久队列，只替换调度入口，`decision_runs`、租约和 Runner 不变。

### 6. Realtime 是加速通道，查询是正确性通道

Migration 将 `decision_runs` 加入 Supabase Realtime publication，并仅为 owner 提供 SELECT RLS。页面级 Hook 保存 `runsBySessionId`，在应用各视图之间保持挂载：

- 首次加载、打开会话、窗口恢复可见和订阅恢复时查询最新 run。
- Realtime 事件按 `session_id` 更新 map。
- 存在非终态 run 时每五秒查询；无活动任务后停止。
- 只有事件的 `session_id` 等于当前会话引用时才重新读取当前消息与报告。

这样状态最终以数据库查询为准，Realtime 丢事件只影响更新速度。会话读取使用请求序号或当前会话引用拒绝迟到查询，避免 A 的读取覆盖 B。

### 7. 删除先取消，归档后不接受迟到写入

删除会话 Route 在一个服务端操作中先将非终态 run 条件更新为 `cancelled` 并清除租约，再归档会话。Worker 每个 AI 阶段前检查租约；外部调用已经开始时可能继续消耗供应商时间，但最终提交必须匹配有效租约，因此不能复活取消任务。前端删除不再直接分别更新多张表。

## Risks / Trade-offs

- [Vercel Function 在 AI 阶段中途达到最大执行时长] → 每个阶段先持久化、使用租约和定时恢复；文字与生图阶段可以在不同调用中恢复。
- [Realtime publication 或网络不可用] → 初次查询、可见性恢复和五秒轮询保证最终一致。
- [两个 Worker 在高并发下超过用户并发限制] → 以用户 advisory lock 包围回收、计数和认领，不依赖应用层计数。
- [重试导致重复模型费用] → 结果表的 `decision_run_id` 唯一约束减少已完成阶段的重复；外部请求完成但落库前硬中断仍可能重试，这是无供应商幂等键时无法完全消除的窗口。
- [取消发生在供应商请求进行中] → 不承诺停止已发出的请求，但用租约条件阻止保存结果和启动下一阶段。
- [大型页面继续积累状态复杂度] → 把运行类型、查询归并和状态派生提取到 `src/lib/decision-runs/`，页面仅绑定当前会话。

## Migration Plan

1. 先部署数据库 migration：新增 nullable 关联字段、运行表、索引、RLS、Realtime publication 和原子 RPC；现有读写不受影响。
2. 部署 Runner、创建/查询/取消/恢复接口，并验证服务端配置可以使用 service role；旧同步接口仍保留。
3. 部署前端新提交与恢复逻辑，新创建的决策开始写 `decision_runs`；历史会话继续走旧读取路径。
4. 在生产配置恢复 Route 的定时调用，先用测试用户验证并发、租约接管、取消和 Realtime 断线恢复。
5. 回滚应用时可恢复旧同步前端；新增表和 nullable 字段保留不会影响旧代码。确认不再回滚后再评估是否移除旧截图决策路径，本次不删除。
