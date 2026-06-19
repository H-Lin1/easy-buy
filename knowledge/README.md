# 本地穿搭知识库 v1

这是“衣服购买决策助手”的第一版本地知识资产，用于后续 AI 视觉识别、衣橱 RAG 和购买决策调试。

当前 MVP 范围聚焦衣服、裤装/裙装、连衣裙/套装与功能外套，暂不把鞋、包、配饰作为核心识别和检索品类。鞋包配饰可以在搭配建议文字中作为辅助参考，但不进入第一版衣橱入库 taxonomy。

当前阶段只做本地 review：

- 不上传 Supabase。
- 不生成 embedding。
- 不修改现有 prompt。
- 不接入现有 RAG 代码。

## 文件说明

- `fashion-taxonomy.v1.json`  
  视觉识别和购买决策共用的中细颗粒标签体系。

- `fashion-knowledge.cards.v1.json`  
  第一批 105 张知识卡，覆盖长期主义消费、颜色搭配、版型比例、场景穿搭、品类专项、功能服饰、材质维护、重复购买与衣橱利用率。

- `fashion-knowledge.sources.md`  
  资料来源类型、参考链接和整合原则。

## Review 重点

建议按这几个问题检查：

1. 标签是否足够贴近中文用户表达。
2. 标签颗粒度是否适合 MVP，不会过粗也不会过细。
3. 知识卡是否能直接支持购买判断，而不是泛泛穿搭建议。
4. 是否覆盖了高频商品：背心、T 恤、Polo 衫、衬衫、雪纺衫、针织衫、羊毛衫/羊绒衫、卫衣、西装外套、风衣、大衣、防晒衣、冲锋衣、软壳衣、抓绒衣、小香风外套、羊羔毛外套、棉服、牛仔裤、直筒裤、阔腿裤、休闲裤、小脚裤、牛仔短裤、皮裤、半身裙、连衣裙、吊带连衣裙、西装连衣裙、旗袍、瑜伽裤、运动裤、户外裤。
5. 是否能解释这些验收场景：
   - 白色无袖背心：上衣、背心、无袖、基础款、夏季、可能偏透。
   - 米色西装外套：外套、西装、通勤、轻正式、中性色、高复用。
   - 黑色直筒裤：下装、长裤、直筒、通勤、基础款。
   - 碎花连衣裙：连衣裙、印花、约会、旅行、风格亮点款。
   - 运动鞋：鞋、运动休闲、日常、舒适、正式度边界。
   - 米白背心 + 已有多件白色上衣：触发重复购买风险。
   - 亮色半裙 + 缺少中性色上衣：触发搭配承接不足。
   - 通勤外套：触发正式度、维护成本、衣橱复用相关知识。

## 后续接入路径

确认方向后，再进入第二阶段：

1. 扩充 `fashion_knowledge` 字段，例如 `taxonomy_version`、`metadata`、`source_refs`、`priority`、`status`。
2. 为知识卡生成 `embedding_text` 的 embedding。
3. 写入 Supabase `fashion_knowledge` 表。
4. 修改 `src/lib/ai/knowledge.ts`，优先查数据库，失败时回退内置规则。
5. 修改 `src/lib/ai/closet-analysis.ts`，让视觉模型按 taxonomy 输出标签。
6. 修改 `src/lib/ai/purchase-analysis.ts`，让待买商品截图识别复用同一套标签。
7. 修改 `src/lib/ai/workflow.ts`，把知识库检索结果作为明确证据传给决策模型。

## 卡片字段

每张知识卡包含：

- `card_id`
- `topic`
- `knowledge_type`
- `locale`
- `taxonomy_version`
- `category_tags`
- `color_tags`
- `style_tags`
- `scenario_tags`
- `fit_tags`
- `fabric_tags`
- `risk_tags`
- `value_tags`
- `applicable_items`
- `not_applicable_items`
- `content`
- `decision_points`
- `outfit_suggestions`
- `risk_signals`
- `decision_bias`
- `source_type`
- `source_refs`
- `embedding_text`
