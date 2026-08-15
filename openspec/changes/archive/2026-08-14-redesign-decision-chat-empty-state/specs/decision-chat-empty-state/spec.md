## Purpose

为尚未开始购买咨询的用户提供简洁、聚焦且可操作的决策启动界面，使用户能够通过商品截图或文字描述快速发起一次购买决策，同时避免提前暴露无关的装饰、指南、分析和报告内容。

## ADDED Requirements

### Requirement: Empty decision chat presents a focused starter
系统 SHALL 在用户尚未提交购买决策问题且当前没有报告、错误或通知时，展示聚焦的决策启动界面。

#### Scenario: New conversation opens in starter state
- **WHEN** 用户打开一条没有已提交问题和决策报告的新对话
- **THEN** 系统展示标题“今天想买哪件衣服？”
- **THEN** 系统在单行内展示副文案“上传商品截图，我会结合你的云端衣橱给出搭配组合和建议”
- **THEN** 系统展示截图/文字输入区，输入提示为“上传截图并描述衣服相关信息”
- **THEN** 系统不展示标题上方图标、任务指南、AI 身份行、分析步骤、清空对话操作或等待报告卡片

#### Scenario: Draft input remains in starter state
- **WHEN** 用户在启动界面输入文字或添加商品截图但尚未提交
- **THEN** 系统继续展示启动界面
- **THEN** 系统保留用户已填写的文字或已添加的截图

### Requirement: Starter input keeps a minimal focus treatment
系统 SHALL 在启动界面的文字输入框获得焦点时保持简洁，不显示额外的浏览器或应用轮廓方框。

#### Scenario: User focuses the starter input
- **WHEN** 用户点击或通过键盘聚焦启动界面的文字输入框
- **THEN** 输入框不显示灰色线条方框、聚焦描边或聚焦光环
- **THEN** 外层输入容器和上传、发送操作保持原有布局

### Requirement: Submitted question enters existing conversation flow
系统 SHALL 在用户提交有效文字或商品截图后退出启动界面，并进入既有购买决策分析流程。

#### Scenario: User submits a prepared decision request
- **WHEN** 用户在启动界面提交有效文字、商品截图或两者组合
- **THEN** 系统隐藏启动界面并展示已提交的用户内容和分析进度
- **THEN** 系统继续使用既有会话创建、AI 分析、报告展示和保存逻辑

### Requirement: Decision assistant header is concise
系统 SHALL 在用户提交问题后使用一致且简洁的决策助手标题区域。

#### Scenario: Submitted conversation header renders
- **WHEN** 用户已提交购买决策问题
- **THEN** 系统展示主文案“决策助手”
- **THEN** 系统展示副文案“结合你的现有衣服和偏好，给出可视化的搭配和购买建议”
- **THEN** 系统不展示清空对话操作

### Requirement: Submitted user content uses a compact message layout
系统 SHALL 使用紧凑图片、主题色文字气泡且无用户头像的布局展示用户提交的商品和文字。

#### Scenario: Submitted request includes an image and text
- **WHEN** 用户提交商品截图和文字描述
- **THEN** 系统在内容区域右侧展示宽度约为原展示尺寸三分之一的商品缩略图
- **THEN** 用户可以点击缩略图查看大图
- **THEN** 系统在图片下方使用与产品主题相符的底色气泡展示用户文字
- **THEN** 系统不展示用户头像

#### Scenario: Submitted request contains text only
- **WHEN** 用户仅提交文字描述
- **THEN** 系统以主题色底色气泡右对齐展示该描述

### Requirement: Analysis progress reveals stages sequentially
系统 SHALL 在等待报告时按顺序逐个展示分析阶段，而不是一次显示全部阶段。

#### Scenario: Analysis begins
- **WHEN** 系统开始生成购买决策
- **THEN** 系统展示灰色文字“思考中”和一条横向分隔线
- **THEN** 系统只展示当前已到达的分析阶段
- **THEN** 当前阶段展示动态 Thinking Orb，尚未开始的阶段不显示

#### Scenario: Analysis advances to the next stage
- **WHEN** 当前分析阶段完成并进入下一阶段
- **THEN** 已完成阶段移除动态 Thinking Orb并仅保留文字
- **THEN** 下一阶段容器出现并展示动态 Thinking Orb

### Requirement: Completed analysis progress is timed and collapsible
系统 SHALL 在报告返回后显示本次分析耗时，并允许用户展开或折叠全部阶段。

#### Scenario: Report completes
- **WHEN** 购买决策报告成功返回
- **THEN** “思考中”替换为“耗时 x 分 x 秒 >”
- **THEN** 全部分析阶段标记为完成且默认折叠
- **THEN** 系统展示真实决策报告，不展示准备阶段等待卡片

#### Scenario: User toggles completed progress
- **WHEN** 用户点击耗时文字
- **THEN** 系统在展开和折叠全部已完成阶段之间切换

### Requirement: Starter is responsive and readable
系统 SHALL 在桌面和移动视口中保持启动界面内容可读、可操作且不发生横向溢出或控件重叠。

#### Scenario: Starter renders on desktop
- **WHEN** 启动界面在桌面视口中显示
- **THEN** 标题、输入区和操作按钮保持清晰的视觉层级

#### Scenario: Starter renders on mobile
- **WHEN** 启动界面在宽度 390 像素的移动视口中显示
- **THEN** 输入区、上传按钮、发送按钮和文案不重叠且无横向溢出
