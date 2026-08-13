## Why

衣橱卡片目前使用横向固定展示区与 `cover`，直屏拍摄的原图会被裁去上下内容。衣物图片是用户判断衣橱内容的核心信息，需要在不牺牲网格整齐度的前提下完整可见。

## What Changes

- 将衣橱确认卡与已保存衣橱卡的图片展示区统一为 1:1。
- 原图和生成展示图一律使用 `object-contain` 完整适配，并使用浅暖白色背景承接留白。
- 保持现有图片切换、上传、AI 识别、展示图生成、Storage 文件和卡片网格列数不变。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `closet-upload-workflow`: 改变确认和衣橱卡片中原图与展示图的可见性、比例及背景呈现要求。

## Impact

- 影响 `src/app/app/page.tsx` 中共享衣橱图片组件、确认卡和衣橱卡的样式。
- 不涉及 API、数据库 schema、Storage 内容、运行时依赖或图片重新生成。
