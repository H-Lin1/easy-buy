## Why

真人搭配效果图目前保持并发生成，但单个供应商请求偶发超时或返回 5xx，导致并发批次只成功一部分。失败任务没有自动补偿，用户只能手动重新触发整批生成。

## What Changes

- 保持现有效果图任务的并发执行方式。
- 每个效果图任务失败后自动重试一次。
- 重试时只处理失败任务，已成功任务不重复生成。
- 保留最终的部分成功状态与失败原因展示。

## Capabilities

### New Capabilities

- `outfit-generation-retry`: 并发效果图任务的单次失败重试行为。

### Modified Capabilities

## Impact

- 影响 `src/lib/decision-runs/try-on-runner.ts` 与相关效果图生成测试。
- 不改变并发上限、供应商配置、数据库表结构或前端接口形状。

