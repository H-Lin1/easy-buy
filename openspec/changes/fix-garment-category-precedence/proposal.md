## Why

当前品类正则会让“西装裤”同时命中外套和下装，并因外套判断在前而进入 `outerwear` 槽位，导致新决策把裤子展示为“可搭外套”。候选解析、RAG 和前端兜底还分别维护分类逻辑，存在继续漂移的风险。

## What Changes

- 建立统一的服装品类分组规则，按“一件式/套装、下装、外套、上衣”的明确优先级消除关键词重叠。
- 让候选商品归类、衣橱 RAG 槽位匹配和前端新数据兜底使用同一分类结果。
- 确保“西装裤”归为下装、“西装外套”归为外套、“连体裤”和“西装套装”归为一件式/套装。
- 补充覆盖关键词重叠品类的自动化测试。
- 非目标：不修改、不迁移或兼容已经保存错误 `role` / `badge` 的历史报告，用户可自行删除历史数据。

## Capabilities

### New Capabilities

- `garment-category-classification`: 定义决策流程中服装品类分组与证据角色必须一致的行为。

### Modified Capabilities

无。

## Impact

- 影响候选商品归类、`src/lib/ai/workflow.ts` 的 RAG 槽位匹配，以及 `src/app/app/page.tsx` 的新数据展示兜底。
- 不改变数据库结构、AI 供应商、Prompt、历史记录或外部 API 形状。
