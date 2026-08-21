## Why

衣橱顶部的“上传衣服”和“批量上传”实际打开同一个支持多选的文件选择器，两个入口造成重复且占用页面右侧空间。

## What Changes

- 移除“批量上传”按钮。
- 保留支持多选的“上传衣服”入口，并将其置于原批量上传所在的右侧操作位置。
- 更新空衣橱状态的标题与说明，使其明确说明 AI 会将衣橱信息用于购买决策搭配检索。

## Capabilities

### New Capabilities
- `closet-upload-action-simplification`: 为云端衣橱提供单一、清晰的上传衣服操作入口。

### Modified Capabilities

- None.

## Impact

- 影响 `src/app/app/page.tsx` 中云端衣橱页头操作区与空状态文案。
- 不修改文件多选、上传、识别或衣橱数据流程。
