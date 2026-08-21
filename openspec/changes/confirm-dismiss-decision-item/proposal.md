## Why

“暂不考虑”目前会立即把一条决策从清单移除，用户误触后缺少最后一次确认。需要在发生删除性状态变更前明确其后果并允许用户取消。

## What Changes

- 用户点击决策清单中的“暂不考虑”时先展示确认弹窗。
- 弹窗说明确认后该商品将从决策清单中删除，并提供取消与确认操作。
- 只有确认后才更新状态并从当前清单移除；取消或关闭弹窗不改变记录。

## Capabilities

### New Capabilities
- `decision-dismissal-confirmation`: 为从决策清单移除的“暂不考虑”操作提供明确的二次确认。

### Modified Capabilities

- None.

## Impact

- 影响 `src/app/app/page.tsx` 中的决策清单状态操作与确认界面。
- 不改变数据库结构、聊天记录或其他状态切换行为。
