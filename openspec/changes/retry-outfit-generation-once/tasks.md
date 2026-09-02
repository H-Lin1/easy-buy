## 1. Implementation

- [x] 1.1 为持久化决策效果图生成增加一次失败重试，并保持每轮并发。
- [x] 1.2 为重试筛选和成功任务不重复执行补充自动化测试。

## 2. Verification

- [x] 2.1 运行相关测试、ESLint、TypeScript 检查和 `git diff --check`。
- [x] 2.2 验证并发批次首次成功、部分失败后重试、重试后失败三种结果。
