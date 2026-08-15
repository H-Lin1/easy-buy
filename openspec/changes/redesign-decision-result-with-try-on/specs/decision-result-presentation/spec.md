## Purpose

为购买决策完成后的页面提供清晰、低负担的结果体验，让用户先读懂结论，再逐套核对真人穿搭效果和对应的真实来源单品。

## ADDED Requirements

### Requirement: Decision result prioritizes a text conclusion
系统 SHALL 在购买分析完成后先展示自然语言结论，并移除评分型报告表达。

#### Scenario: Text-only input requests a product image
- **WHEN** 用户提交了文字但没有附带待买衣服图片
- **THEN** 系统切换到图片补充引导模式，不进入商品识别、衣橱检索、购买报告或真人试穿流程
- **THEN** 助手仅说明需要上传清晰的商品截图或照片，并提示可补充价格、使用场景或犹豫点
- **THEN** 助手不声称已经看到衣服，不输出是否值得买、搭配组合或衣橱匹配结论
- **THEN** 即使用户文字包含相反指令，服务端仍执行图片补充引导模式
- **THEN** 模型不可用、返回空内容或越界结论时，系统使用稳定的图片补充兜底文案
- **THEN** 图片补充引导作为正常助手消息保存，并能在未来历史对话中恢复

#### Scenario: Image input enters purchase assessment
- **WHEN** 用户提交待买衣服图片，并可选补充文字信息
- **THEN** 系统进入现有商品识别、衣橱检索、购买分析和结果展示流程

#### Scenario: Analysis progress uses a single-line linked flow
- **WHEN** 系统正在执行购买分析，或用户展开已完成分析的耗时区域
- **THEN** 已出现的分析阶段在同一行内按顺序展示
- **THEN** 相邻阶段使用箭头连接，当前阶段保留动态标识，已完成阶段仅保留文字
- **THEN** 窄屏下流程在自身容器内横向滚动且自动跟随当前阶段，不撑宽页面或将阶段文字换行

#### Scenario: Assessment text is ready
- **WHEN** 购买分析成功返回
- **THEN** 系统立即展示自然语言摘要、主要理由和必要提醒
- **THEN** 系统不额外展示“结论”标签、独立的决定文案或已保存到最近对话的提示
- **THEN** 系统不展示分数、星级、评分图表、商品报告卡或重复的待买商品大图
- **THEN** 回答正文与耗时区域使用相同的左右边界，摘要右侧与下方依据区域对齐
- **THEN** 摘要、依据、穿搭和决策操作等主要区块之间使用紧凑的垂直节奏

#### Scenario: Completed analysis shows elapsed time
- **WHEN** 购买分析完成并显示耗时
- **THEN** 耗时小于 60 秒时仅显示“耗时 X 秒”
- **THEN** 耗时达到 60 秒时显示“耗时 X 分 X 秒”
- **THEN** 耗时文字位于一条完整分割线上方，结果正文不再额外绘制第二条顶部横线

#### Scenario: Historical conversation restores elapsed time
- **WHEN** 用户打开已经完成的历史决策对话
- **THEN** 系统恢复该次分析保存的真实耗时并显示相同的耗时分割栏
- **THEN** 对于没有保存真实耗时字段的旧对话，系统不显示或推算耗时
- **THEN** 对于保存了真实耗时字段的未来对话，系统不因重新打开而隐藏耗时分割栏

#### Scenario: Result page header aligns with content dividers
- **WHEN** 非空决策对话显示页头和结果正文
- **THEN** 页头不显示“决策助手”标题，仅保留说明文案“结合你的衣橱和偏好，给出可视化的搭配和购买建议”
- **THEN** 说明文案与购买结论正文使用相同文字颜色，且文案到页头底部分割线的间距缩短约一半
- **THEN** 页头底部分割线与结果正文中的分割线采用一致的左右留白

#### Scenario: Rule fallback produces a conclusion
- **WHEN** AI 决策模型不可用但现有规则能够返回文字结论
- **THEN** 系统仍展示该文字结论
- **THEN** 系统不把规则兜底生成的伪搭配用于真人试穿

### Requirement: Try-on generation does not block the conclusion
系统 SHALL 在文字结论可见后独立加载真人穿搭结果。

#### Scenario: Eligible outfits begin generation
- **WHEN** 文字结论已返回且存在可生成的有效搭配
- **THEN** 系统保留可阅读的文字结论
- **THEN** 穿搭区域显示“真实搭配生成中”及加载状态

#### Scenario: No eligible outfit exists
- **WHEN** 决策结果没有可生成的有效搭配或缺少待买商品图片
- **THEN** 系统不发起真人试穿生成
- **THEN** 穿搭区域说明当前缺少可靠的真实搭配依据

### Requirement: Completed outfit presents try-on and source items together
系统 SHALL 将每套真人试穿图与生成该图片所依据的待买商品和衣橱来源单品绑定展示。

#### Scenario: One outfit is ready
- **WHEN** 一套真人试穿结果完成并可展示
- **THEN** 穿搭区域仅以黑色“穿搭效果”作为标题，不重复展示真人搭配或来源单品副标题
- **THEN** 桌面布局左侧展示全身真人穿搭图
- **THEN** 右侧展示待买商品和该套检索得到的衣橱来源单品
- **THEN** 每个来源单品显示真实图片及可辨识名称或品类
- **THEN** 真人图容器贴合生成图片比例且不露出额外底色留白
- **THEN** 右侧来源单品采用完整卡片结构，并在桌面视口尽量与左侧真人图底部对齐

#### Scenario: Multiple outfits are ready
- **WHEN** 两套或三套真人试穿结果完成
- **THEN** 系统提供清晰的套数切换控件
- **THEN** 切换后左侧试穿图和右侧来源单品始终属于同一个 outfitId
- **THEN** 首次展示顺序与决策返回的搭配顺序一致

#### Scenario: Result renders on mobile
- **WHEN** 结果在宽度 390 像素的移动视口显示
- **THEN** 真人穿搭图位于来源单品上方
- **THEN** 页面无横向溢出、文字遮挡或控件重叠

#### Scenario: Conclusion transitions to outfit presentation
- **WHEN** 主要依据和购买提醒展示结束
- **THEN** 摘要与主要依据之间不显示分割线，但保留当前的垂直间距
- **THEN** 依据区与穿搭区域之间只出现一条分割线

### Requirement: Try-on failures preserve a useful result
系统 SHALL 在真人试穿生成失败时保留文字结论并提供恢复操作。

#### Scenario: At least one try-on job fails
- **WHEN** 本批次任意试穿任务失败
- **THEN** 系统等待本批次全部任务结束后显示聚合失败状态
- **THEN** 系统不展示本批次的部分成功图片
- **THEN** 系统继续展示对应来源单品并提供重试操作

### Requirement: Decision status requires an explicit user choice
系统 SHALL 在结果完成后引导用户主动选择决策状态，并让视觉反馈与真实清单状态保持一致。

#### Scenario: No decision status has been selected
- **WHEN** 新的购买决策结果首次显示且用户尚未点击状态
- **THEN** “决定买”“先收藏”“暂不考虑”均保持未选中
- **THEN** 操作区以轻量主题色提示“为这件衣服选择一个决策状态”
- **THEN** 系统不将任何状态自动写入决策清单

#### Scenario: User chooses buy or save for later
- **WHEN** 用户点击“决定买”或“先收藏”且保存成功
- **THEN** 对应按钮显示真实选中状态
- **THEN** 操作区显示“已保存到决策清单”
- **THEN** 系统显示“查看决策清单”入口
- **THEN** 商品出现在决策清单及其数量统计中

#### Scenario: User chooses not considering
- **WHEN** 用户点击“暂不考虑”且状态保存成功
- **THEN** “暂不考虑”按钮显示真实选中状态
- **THEN** 操作区显示“未进入决策清单”
- **THEN** 系统仍显示“查看决策清单”入口
- **THEN** 该商品不出现在决策清单、筛选项或数量统计中

#### Scenario: Historical conversation restores decision status
- **WHEN** 用户重新打开已选择状态的历史对话
- **THEN** 系统恢复真实保存的状态
- **THEN** 对于没有保存状态的历史对话不再默认显示“先收藏”
