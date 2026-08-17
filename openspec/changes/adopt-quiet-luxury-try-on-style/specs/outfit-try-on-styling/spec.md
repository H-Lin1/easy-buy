## Purpose

为真人试穿结果提供稳定、克制且具有时尚编辑感的默认摄影表达，让用户在服装还原优先的前提下更直观地感受到搭配的质感、比例和可穿性。

## ADDED Requirements

### Requirement: Quiet Luxury is the default try-on style layer

真人试穿成片 SHALL 使用 Quiet Luxury 作为默认摄影风格层：采用自然采光的极简当代室内、克制中性色、干净的纵向构图、自然但优雅的站姿和高级材质表现；风格层 MUST NOT 覆盖固定模特身份、原生多图角色或服装保真约束。

#### Scenario: A new try-on request uses the production prompt

- **WHEN** 服务端为包含有效待买商品和衣橱来源单品的搭配创建真人试穿请求
- **THEN** 成片提示要求使用 Quiet Luxury 的极简室内、自然光、克制中性色、清晰轮廓层级和精致但可穿的生活方式时尚表达
- **THEN** 提示继续要求完整全身画面和自然站姿，不要求固定塞衣、卷袖、配饰或其他具体穿法

#### Scenario: Garment fidelity takes precedence over style direction

- **WHEN** Quiet Luxury 的场景、姿势或造型表达与输入服装的可见颜色、材质、领型、袖长、衣长、腰线或裤型发生冲突
- **THEN** 系统 SHALL 调整风格表现、姿势或场景，而不是改色、改版型、改长度、重设计或遗漏输入服装

### Requirement: Every supplied garment is mandatory and correctly worn

真人试穿提示 SHALL 将 Image 2 及所有 Image 3+ 视为完整且不可选的服装清单，并 SHALL 要求每件输入服装在最终成片中按其服装类别穿在正确身体位置、保持足够可见以核对来源图、只使用一次且不得与其他服装合并。

#### Scenario: A try-on request contains multiple garments

- **WHEN** 一次真人试穿请求包含待买商品和一件或多件衣橱服装
- **THEN** 提示明确给出必穿服装总数，并声明 Image 2 及所有 Image 3+ 均为不可省略的必穿项
- **THEN** 每件服装只能按其类别穿在常规身体位置，不得拿在手中、搭在肩上、系在腰间、放置在场景中或转换为配饰来充当“已使用”

#### Scenario: Layering would hide another mandatory garment

- **WHEN** 外层、内层、下装或连体单品的自然分层会让另一件必穿服装无法辨认
- **THEN** 提示要求调整敞开方式、层次、姿势、手臂位置、构图或场景，使每件服装的关键结构仍然可见
- **THEN** 系统 MUST NOT 允许通过遗漏、合并、替换或完全遮挡任一输入服装来解决视觉冲突

#### Scenario: A garment is considered visibly used

- **WHEN** 生图模型组织最终穿搭
- **THEN** 上衣和内层的领口或领型、主体以及相应袖型或下摆保持可辨认
- **THEN** 外层的领口或帽型、肩部、袖子、前襟或主体和下摆保持可辨认，并在需要展示内层时采用敞开穿着
- **THEN** 下装的腰头或腰线、裤腿或裙身轮廓和长度保持可辨认
- **THEN** 连体服装的领口、主体、腰部关系和下摆保持可辨认

#### Scenario: User-facing outfit summary is not a rendering instruction

- **WHEN** 真人试穿提示由已选搭配生成
- **THEN** 提示可以保留搭配标题和场景作为上下文，但 MUST NOT 包含面向用户解释搭配依据的 `summary`
- **THEN** 生图模型在服装图片和统一保真约束内自主决定具体穿法
