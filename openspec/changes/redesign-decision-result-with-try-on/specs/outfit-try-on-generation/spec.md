## Purpose

为每套可靠的购买搭配生成可持久化的真人全身试穿图，并在统一模特、有限并发、结果顺序和失败隔离之间建立稳定契约。

## ADDED Requirements

### Requirement: Only eligible outfits are generated
系统 SHALL 仅为模型生成且有真实衣橱来源依据的有效搭配创建真人试穿任务。

#### Scenario: Grouped wardrobe candidates are sent to the decision model
- **WHEN** 系统完成各穿搭槽位的 Top K 衣橱召回
- **THEN** 系统保留每个槽位召回的全部候选，不再对合并结果执行全局前 6 截断
- **THEN** 系统按 `inner_top`、`top`、`bottom`、`outerwear`、`onepiece` 分组提供候选及其真实 `closetItemId`
- **THEN** 系统使用 `AI_DECISION2_*` 配置的 `gpt-5.6-terra` 多模态模型执行购买决策
- **THEN** 系统将待买商品原图作为第一张视觉证据，并将所有具有可读取原图的分槽候选逐张提交，图片标签与真实 `closetItemId` 一一对应
- **THEN** 模型在结构化证据之外核对图片中的颜色、明度、材质观感、廓形和长度比例，文字与可见图片冲突时优先采用图片并说明风险

#### Scenario: A retrieved candidate image is unavailable
- **WHEN** 某个已召回候选缺少原图或原图无法读取
- **THEN** 系统仍在对应槽位保留该候选的结构化证据和真实 `closetItemId`
- **THEN** 系统不伪造、替换或复用其他候选图片
- **THEN** 决策模型对该候选执行保守判断，且图片缺失不阻塞其他候选和待买商品图片进入决策

#### Scenario: Decision model selects reliable and distinct outfits
- **WHEN** 决策模型从分组候选中生成搭配方案
- **THEN** 系统不向决策模型提供规则兜底生成的草稿报告，模型仅基于原始用户输入、商品与衣橱证据、用户画像和知识卡独立判断
- **THEN** 模型结合商品和衣橱图片进行二次筛选，以整体搭配的美观、协调和可穿性为首要目标
- **THEN** 模型最多返回 3 套并按可靠程度从高到低排序，不强制凑满 3 套；不够自然或效果不佳的方案必须舍弃
- **THEN** 每套最多引用 4 件衣橱单品
- **THEN** 多套方案之间至少有一个核心衣橱单品不同，避免只替换近似单品形成重复方案

#### Scenario: Outfit references are validated before generation
- **WHEN** 服务端接收模型返回的搭配方案
- **THEN** 服务端只接受本次分组候选池中真实存在的 `closetItemId`
- **THEN** 服务端拒绝或清理越界数量、同套重复单品和不属于候选白名单的引用
- **THEN** 只有全部保留方案完成校验后，系统才创建最多 3 个并行生图任务

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
- **THEN** 生成提示要求保持人物身份和身体比例一致，但不继承模特引用图的姿势、构图、光线或背景
- **THEN** 每套成片采用完整全身、自然站姿和真实生活方式时尚摄影方向

### Requirement: Try-ons use native multi-image references
系统 SHALL 将模特、待买商品和衣橱来源单品作为彼此独立的原生图片输入发送给当前图片编辑供应商，不再将它们缩放拼接为单张参考板。

#### Scenario: Outfit references are submitted
- **WHEN** 系统为一套有效搭配创建图片编辑请求
- **THEN** Image 1 是固定模特，仅作为人物身份和身体比例参考，不作为姿势、构图、光线、背景或原有服装参考
- **THEN** Image 2 是待买商品，并作为其颜色、材质、纹理、图案、轮廓和结构细节的首要视觉事实来源
- **THEN** Image 3 及之后按搭配中的来源顺序提供衣橱单品，并让每件单品只使用一次
- **THEN** 所有图片保持各自原始像素信息，不因拼板而缩小到共享画布
- **THEN** 生成提示明确要求忽略模特图中原有服装，并在文字描述与服装图片冲突时以服装图片像素为准
- **THEN** 生成提示将领型或领口、袖型与袖长、肩线、衣长与下摆、整体廓形，以及裤腰高度、腰头结构、裤型和裤长声明为不可改变的服装几何约束
- **THEN** 为了服装保真，系统允许调整人物姿势和生活方式场景，但不得通过卷袖、改短、改腰线、收窄或放宽裤腿等方式重设计原单品
- **THEN** 系统不将面向用户解释搭配依据的 `summary` 传入图片编辑提示词，生图模型仅在已选单品、场景和上述统一约束内自行决定具体穿法

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
