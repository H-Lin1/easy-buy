## 1. Prompt implementation

- [x] 1.1 将真人试穿公共 Prompt 的风格层替换为 Quiet Luxury，并将版本号升级为 `outfit-try-on-v5-quiet-luxury`
- [x] 1.2 保持原生多图角色、服装几何保真、负向约束、标题/场景上下文和 summary 隔离不变
- [x] 1.3 根据 `closetItemIds` 写入 Image 2 及所有 Image 3+ 的强制总件数和图片范围
- [x] 1.4 为所有输入服装添加正确身体位置、可识别结构、单次使用和分层可见性规则，并补充通用错误使用负向约束

## 2. Verification

- [x] 2.1 更新 Prompt 单测，覆盖 Quiet Luxury 风格、版本号、服装保真和 summary 不注入
- [x] 2.2 运行相关 Node/TypeScript 测试、ESLint、TypeScript 检查和 OpenSpec strict validation
- [x] 2.3 检查工作区差异，确认没有修改决策模型、输入协议、并发逻辑或历史图片行为
- [x] 2.4 升级 Prompt 版本并补充强制服装件数、正确穿着和禁止错误使用的自动化测试
- [x] 2.5 重新运行相关测试、TypeScript、ESLint、生产构建和 OpenSpec strict validation
