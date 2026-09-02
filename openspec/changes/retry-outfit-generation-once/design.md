## Design

在现有效果图任务 worker 外增加一个固定次数为 2 的尝试循环。每轮使用现有 `settleTryOnJobs` 并发执行当前 pending 任务；每个 worker 结束后从数据库读取任务状态，下一轮只筛选仍处于 `pending` 或 `failed` 且没有图片路径的任务。这样保留现有并发模型和租约保护，同时避免成功任务重复调用供应商。

重试次数是单次请求生命周期内的内存常量，不新增数据库字段。最终状态继续由现有 `outfit_try_on_images` 行和 `tryOnSummary` 汇总决定。

