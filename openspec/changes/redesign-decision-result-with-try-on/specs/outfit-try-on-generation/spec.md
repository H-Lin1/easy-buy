## Purpose

为每套可靠的购买搭配生成可持久化的真人全身试穿图，并在统一模特、有限并发、结果顺序和失败隔离之间建立稳定契约。

## ADDED Requirements

### Requirement: Only eligible outfits are generated
系统 SHALL 仅为模型生成且有真实衣橱来源依据的有效搭配创建真人试穿任务。

#### Scenario: Report contains eligible combinations
- **WHEN** 决策报告由模型生成、具有待买商品图片，且搭配包含至少一个有效衣橱单品标识
- **THEN** 系统按报告顺序选取最多 3 套搭配
- **THEN** 每套分配稳定且唯一的 outfitId

#### Scenario: Report contains a fallback combination
- **WHEN** 搭配来自规则兜底、没有有效衣橱单品标识或相关图片不可读取
- **THEN** 系统不为该搭配调用图片生成供应商

### Requirement: Try-ons use one generic model identity
系统 SHALL 在第一版中使用同一个固定的通用成年真人模特引用生成所有穿搭图。

#### Scenario: Multiple outfits are generated
- **WHEN** 同一报告包含多套有效搭配
- **THEN** 每套生成请求均包含同一份固定模特引用
- **THEN** 生成提示要求保持人物身份、全身构图和摄影环境一致

### Requirement: Try-ons use native multi-image references
系统 SHALL 将模特、待买商品和衣橱来源单品作为彼此独立的原生图片输入发送给当前图片编辑供应商，不再将它们缩放拼接为单张参考板。

#### Scenario: Outfit references are submitted
- **WHEN** 系统为一套有效搭配创建图片编辑请求
- **THEN** Image 1 是固定模特，仅作为人物身份、身体比例、姿势、构图、光线和背景参考
- **THEN** Image 2 是待买商品，并作为其颜色、材质、纹理、图案、轮廓和结构细节的首要视觉事实来源
- **THEN** Image 3 及之后按搭配中的来源顺序提供衣橱单品，并让每件单品只使用一次
- **THEN** 所有图片保持各自原始像素信息，不因拼板而缩小到共享画布
- **THEN** 生成提示明确要求忽略模特图中原有服装，并在文字描述与服装图片冲突时以服装图片像素为准

### Requirement: Try-ons generate concurrently with a maximum of three
系统 SHALL 并行生成同一报告中的全部有效试穿图，且单批最多执行 3 个任务。

#### Scenario: Three eligible outfits are submitted
- **WHEN** 报告包含三套有效搭配
- **THEN** 系统并行启动三套图片生成任务
- **THEN** 系统等待全部任务 settled 后返回批次结果
- **THEN** 返回结果仍按报告中的搭配顺序排列，而不是按任务完成顺序排列

### Requirement: Try-on generation is isolated from decision generation
系统 SHALL 让真人试穿失败不改变已经完成的文字决策。

#### Scenario: Image provider is unavailable
- **WHEN** 图片供应商超时、配置缺失或返回无效图片
- **THEN** 文字决策和已保存报告保持成功状态
- **THEN** 试穿批次记录失败状态和可重试信息

### Requirement: Generated try-ons are persistent and idempotent
系统 SHALL 持久化每套试穿图及其来源绑定，并复用已经完成的结果。

#### Scenario: A completed historical report is opened
- **WHEN** 用户重新打开已生成全部试穿图的历史对话
- **THEN** 系统读取持久化结果并返回临时可访问图片地址
- **THEN** 系统不再次调用图片生成供应商

#### Scenario: A failed batch is retried
- **WHEN** 用户对部分失败的批次发起重试
- **THEN** 系统仅重新生成未就绪的搭配
- **THEN** 已就绪的搭配继续复用已持久化图片
- **THEN** 全部搭配就绪后系统统一返回完整批次

### Requirement: Try-on generation enforces ownership and traceability
系统 SHALL 只允许已认证用户为自己拥有的决策报告生成或读取试穿图，并记录生成来源。

#### Scenario: User requests another user's report
- **WHEN** 已认证用户请求不属于自己的 reportId
- **THEN** 系统拒绝读取或生成试穿图

#### Scenario: Generated image is committed
- **WHEN** 一套试穿图成功保存
- **THEN** 系统记录 reportId、outfitId、搭配顺序、来源单品标识、存储路径、模型和提示版本
