# 衣服购买决策助手 AI 技术实现方案

## 1. 文档目标

本文档用于规划“衣服购买决策助手”的 AI 技术实现方案。

产品通过聊天方式帮助用户判断想买衣服是否值得购买。AI 以长期主义为核心，结合用户个人档案、云端衣橱、商品截图、穿搭知识库、价格、样式、版型、舒适度和搭配灵感，输出可解释的购买决策建议。

核心结论：

> 本项目需要 RAG，也适合使用 LangGraph；MVP 阶段采用“LangGraph workflow + 轻 Agent 决策节点”，不做完全自治 Agent。

---

## 2. 为什么需要 RAG

一次聊天 API 不足以支撑这个产品，因为：

- 衣橱是长期记忆，需要持久存储和复用。
- 商品决策必须和已有衣服比对，天然需要检索。
- 搭配建议需要引用已有衣服作为证据。
- 购买建议要考虑重复购买、衣橱缺口、长期风格和历史决策。
- 衣橱规模变大后，不能每次把所有衣服塞进模型上下文。

RAG 在本项目中承担 3 类任务：

1. 检索可搭配单品。
2. 检索相似/重复风险单品。
3. 检索内置穿搭知识和灵感。

---

## 3. 为什么采用 LangGraph

本项目是多步骤、有状态、可分支的 AI workflow：

```text
聊天输入与商品截图
-> 商品截图识别
-> 加载用户档案、衣橱和历史决策
-> 衣橱 RAG 检索
-> 穿搭知识库检索
-> 搭配组合与灵感生成
-> 长期主义购买判断
-> 安全表达检查
-> 聊天消息、报告和决策候选持久化
```

使用 LangGraph 的原因：

- 适合表达有状态工作流。
- 支持明确的节点和边。
- 后续容易加入分支、追问、人工确认和多轮对话。
- 比完全手写流程更容易扩展成 Agent。
- 比一开始上完整自治 Agent 更稳定。

MVP 不让 Agent 自由调用大量工具。LangGraph 主要承担 workflow 编排，轻 Agent 节点只做有限决策。

---

## 4. 总体 AI 架构

```text
Next.js 决策聊天前端
  -> Supabase Auth
  -> Supabase Storage
  -> Next.js API 通信层
  -> LangGraph.js AI 工作流
  -> Supabase Postgres / pgvector
  -> AutoDL Qwen 视觉与决策模型
  -> SiliconFlow BGE embedding / rerank
  -> AI 消息、报告、决策清单返回前端
```

核心模块：

- 衣橱理解模块
- 商品截图理解模块
- 聊天会话管理模块
- 衣橱 RAG 检索模块
- 穿搭知识库检索模块
- 搭配组合与灵感生成模块
- 长期主义购买决策模块
- 决策状态管理模块
- 安全表达检查模块
- 报告持久化模块

---

## 5. 前后端通信层

前端不直接调用大模型。所有 AI 能力通过 Next.js API Route 进入后端通信层。

通信层职责：

- 校验用户登录状态
- 创建和加载聊天会话
- 上传衣服图片和商品截图到 Supabase Storage
- 创建或读取数据库记录
- 启动 LangGraph 工作流
- 将 LangGraph 输出写回数据库
- 返回前端展示所需的消息、报告和决策卡片

### 5.1 衣服识别接口

```text
POST /api/ai/analyze-closet-item
```

处理流程：

```text
校验登录
-> 上传衣服原图到 Storage
-> 调用 SiliconFlow `Qwen/Qwen-Image-Edit-2509` 生成高质量白底/浅底展示图
-> 将原图和展示图一起传给 qwen3-vl-plus 识别衣服
-> 识别时以原图为主要事实来源，展示图只作为补充参考
-> 如果图片遮挡、折叠、背景复杂或置信度较低，标记 needs_user_review
-> 用户确认或修正 AI 标签
-> 生成 summary 和 embeddingText
-> 调用 BAAI/bge-m3 生成 1024 维 embedding
-> 写入 closet_items
-> 返回 closet item
```

衣橱图片处理原则：

- `original_image_path` / `image_path` 保存用户上传原图，作为真实衣橱证据。
- `display_image_path` 保存 `Qwen/Qwen-Image-Edit-2509` 生成的高质量展示图，用于衣橱卡片、搭配板、搭配报告和决策清单展示。
- 展示图用于提升视觉理解和搭配板可读性，不作为唯一真实依据。生成图可能改变纽扣、领型、口袋、颜色、下摆或面料细节，因此识别、检索和决策仍以原图可见信息和用户确认标签为准。
- 视觉模型识别时同时输入原图和展示图：原图负责真实细节，展示图负责补充衣服整体轮廓、正面展开状态和搭配展示理解。
- 视觉模型识别结果必须进入人工确认或可编辑状态。用户修正后的标签覆盖 AI 初始标签，并作为 embedding 和 RAG 检索依据。
- 批量上传时可以并行处理多件衣服，但图片编辑和视觉识别都需要限流，建议 MVP 先使用 2-4 个并发任务。
- 如果图片编辑失败、超时或明显改动衣服关键细节，则保留原图入库，`display_image_path` 可为空或回退为原图，并标记 `display_image_status=display_failed` / `display_needs_review`。
- 淘宝/电商“拍照找同款”不进入 MVP 主链路。后续若接入，只能作为标签补全参考，并且必须由用户确认；不能用相似商品图替代用户真实衣服图片。

这样做的原因是：衣橱记录需要反映用户真实拥有的衣服，同时搭配板又需要足够清晰、统一、易读的视觉素材。原图负责可信度，Qwen-Image-Edit 展示图负责展示体验，最终 RAG 和购买判断以用户确认后的结构化信息为准。

### 5.2 聊天会话接口

```text
POST /api/chats
GET /api/chats
GET /api/chats/:id
```

职责：创建新对话、列出历史对话、加载指定对话消息。

### 5.3 决策聊天接口

```text
POST /api/chats/:id/messages
```

输入：

```ts
type ChatDecisionMessageRequest = {
  content?: string;
  imageFile?: File;
};
```

处理流程：

```text
校验登录
-> 写入 user chat_message
-> 如果有商品截图，上传到 Storage
-> 创建 purchase_candidate
-> 启动 LangGraph
-> 生成 assistant message + assessment_report
-> 返回 assistant message、candidate、report 和建议状态
```

输出：

```ts
type ChatDecisionMessageResponse = {
  sessionId: string;
  assistantMessage: ChatMessage;
  candidate?: PurchaseCandidateAIProfile;
  report?: PurchaseDecisionReport;
  suggestedStatus?: "decided_to_buy" | "saved_for_later" | "not_considering";
};
```

### 5.4 决策清单接口

```text
POST /api/decision-items
PATCH /api/decision-items/:id
GET /api/decision-items
```

职责：创建决策清单条目、修改状态、获取列表。

状态：

```text
decided_to_buy
saved_for_later
not_considering
```

`status = saved_for_later` 时默认设置 `reminder_at = now() + 24h`。

### 5.5 反馈接口

```text
POST /api/reports/:id/feedback
```

职责：记录用户是否觉得建议有帮助。

---

## 6. 云端数据库与长期记忆

第一版使用 Supabase 作为云端数据库和文件存储。

组件：

- Supabase Auth：用户登录
- Supabase Postgres：结构化数据
- Supabase Storage：衣服图片和商品截图
- Supabase pgvector：衣橱、商品和知识库向量检索

必须开启：

```sql
create extension if not exists vector;
```

核心表：

- `profiles`：用户基础档案
- `closet_items`：云端衣橱与衣服 embedding
- `chat_sessions`：购买决策聊天会话
- `chat_messages`：聊天消息
- `purchase_candidates`：待决策商品
- `fashion_knowledge`：内置穿搭知识库
- `assessment_reports`：AI 决策报告
- `decision_items`：决策清单
- `feedback_events`：用户反馈

向量字段统一使用：

```sql
embedding vector(1024)
```

衣橱图片字段建议：

- MVP 可继续用 `closet_items.image_path` 保存原图路径。
- 建议新增 `display_image_path text`，保存 Qwen-Image-Edit 生成的高质量展示图路径。
- 建议新增 `display_image_status text default 'original_only'`，可选值包括 `original_only`、`display_generating`、`display_generated`、`display_failed`、`display_needs_review`。
- 可选新增 `display_image_model text` 和 `display_image_prompt_version text`，便于后续回放、A/B 测试和排查生成质量。
- 建议新增 `image_quality_flags text[] default '{}'`，记录 `background_complex`、`folded`、`occluded`、`partial_view`、`low_confidence` 等问题。
- 已有 `ai_confidence` 和 `user_corrected` 可用于判断是否需要人工确认，以及后续是否信任 AI 初始标签。
- 若短期不新增字段，`display_image_path` 和 `display_image_status` 可先放入 `notes` 或后端返回对象中，但正式版本建议迁移成独立字段。

---

## 7. 关键类型

```ts
type PurchaseDecision = "buy" | "save" | "skip";

type DecisionItemStatus = "decided_to_buy" | "saved_for_later" | "not_considering";

type PurchaseDecisionReport = {
  decision: PurchaseDecision;
  decisionLabel: "建议决定买" | "建议先收藏" | "建议暂不考虑";
  scores: {
    longTermValue: number;
    closetFit: number;
    styleFit: number;
    scenarioFit: number;
    bodyFit: number;
    duplicationRisk: number;
    comfort: number;
    fashionAppeal: number;
    priceValue: number;
  };
  summary: string;
  reasonsToBuy: string[];
  reasonsToSave: string[];
  risks: string[];
  bodyFitNotes: string[];
  outfitCombinations: OutfitCombination[];
  stylingInspirations: string[];
  alternativesFromCloset: string[];
  suggestedStatus: DecisionItemStatus;
  safetyChecked: boolean;
};
```

---

## 8. RAG 检索与排序策略

一次购买判断需要得到 4 类结果：

1. 可搭配单品 Top 8
2. 相似/重复风险单品 Top 5
3. 替代单品 Top 3
4. 穿搭知识和灵感 Top 5

可搭配检索关注互补关系，不是单纯相似关系。

```text
搭配分 = 品类互补分 + 颜色协调分 + 风格一致分 + 场景匹配分 + 季节适配分 + 用户常穿权重
```

重复风险检索关注相似关系。

```text
重复风险分 = 品类相同 + 颜色相近 + 风格相近 + 版型相近 + 场景重叠 + 已有数量惩罚
```

替代单品检索关注功能替代。

```text
替代分 = 场景相同 + 正式度相近 + 风格相近 + 季节相同 + 用户常穿权重
```

默认流程：

```text
BAAI/bge-m3 生成 1024 维向量
-> Supabase pgvector 召回 Top 30
-> 规则混合排序
-> 取最终 Top K
```

增强流程：

```text
Supabase pgvector Top 30
-> BAAI/bge-reranker-v2-m3 重排
-> 取最终 Top K
```

MVP 默认 `ENABLE_RERANK=false`，先跑通端到端闭环。

---

## 9. LangGraph 工作流设计

### 9.1 State 定义

```ts
type PurchaseAssessmentState = {
  userId: string;
  sessionId: string;
  userMessageId?: string;
  assistantMessageId?: string;
  candidateId?: string;
  screenshotPath?: string;
  userIntent?: string;
  userProfile?: UserProfile;
  candidate?: PurchaseCandidateAIProfile;
  closetItems?: ClosetItemAIProfile[];
  retrievalResult?: ClosetRetrievalResult;
  needFashionKnowledge?: boolean;
  knowledgeSnippets?: FashionKnowledgeSnippet[];
  outfitCombinations?: OutfitCombination[];
  stylingInspirations?: string[];
  report?: PurchaseDecisionReport;
  suggestedStatus?: DecisionItemStatus;
  errors?: string[];
};
```

### 9.2 节点设计

```text
START
  -> analyzePurchaseScreenshot
  -> loadUserContext
  -> retrieveClosetMatches
  -> decideNeedFashionKnowledge
  -> retrieveFashionKnowledge
  -> generateOutfitCombinations
  -> generateStylingInspirations
  -> assessLongTermPurchase
  -> safetyToneCheck
  -> persistChatAndReport
  -> END
```

节点职责：

- `analyzePurchaseScreenshot`：识别商品截图并创建候选商品结构化信息
- `loadUserContext`：读取用户档案、衣橱、历史决策和偏好
- `retrieveClosetMatches`：执行可搭配、重复风险、替代单品检索
- `decideNeedFashionKnowledge`：判断是否需要检索内置知识库
- `retrieveFashionKnowledge`：检索颜色、版型、场景、长期主义知识
- `generateOutfitCombinations`：生成 2-3 套已有衣橱搭配方案
- `generateStylingInspirations`：生成额外穿搭灵感，可包含用户尚未拥有但可作为未来补充方向的单品类型
- `assessLongTermPurchase`：输出购买判断报告和建议状态
- `safetyToneCheck`：检查身体羞辱、绝对审美判断和语气风险
- `persistChatAndReport`：写入 assistant message、assessment_reports，并更新 chat session

### 9.3 分支逻辑

如果衣橱数量少于 5 件：

- 降低结论确定性
- 可以输出追问
- 不直接给强推荐

如果候选商品无法搭出 2 套：

- 不允许输出“建议决定买”
- 优先输出“建议先收藏”或“建议暂不考虑”

如果用户明确提到折扣、冲动、种草：

- 触发长期主义冷静判断
- 优先检查真实场景和衣橱替代品

如果 AI 给出报告：

- 必须返回 `suggestedStatus`
- 前端必须展示三个状态按钮，让用户自己最终选择

---

## 10. 长期主义购买决策框架

AI 输出建议时，以长期主义为主轴。

核心判断问题：

1. 这件衣服未来 30 天是否有真实穿着场景？
2. 它能否和已有衣橱搭出至少 2-3 套？
3. 它是在补足衣橱缺口，还是重复购买？
4. 它是否符合用户长期风格方向？
5. 它是否舒适、实穿、容易维护？
6. 用户是否只是被折扣、模特图、氛围感临时吸引？
7. 如果不买，用户是否已有可替代单品？
8. 它是否能带来新的搭配灵感，而不是只复制已有风格？

最终结论只允许 3 类：

```text
建议决定买
建议先收藏
建议暂不考虑
```

对应系统值：

```text
buy
save
skip
```

---

## 11. BMI 与安全表达边界

BMI 只用于基础版型与舒适度风险提示，不用于审美评价。

允许表达：

- “这件偏紧身，建议关注尺码、弹性和活动空间。”
- “如果你更重视舒适度，可以优先看买家秀或试穿反馈。”
- “短款或贴身版型对尺码准确性要求更高，建议谨慎下单。”

禁止表达：

- “你不适合穿这个。”
- “你穿这个会显胖。”
- “肥胖用户不建议穿。”
- “你的身材不好看。”
- “这件衣服只适合瘦的人。”

最终报告生成后，必须进行安全语言检查。

---

## 12. Prompt 设计

### 12.1 衣橱识别 Prompt

要求：输出严格 JSON，不评价用户本人，不臆测品牌和价格，不确定时使用 unknown，生成可用于 embedding 的自然语言摘要。

补充要求：

- 判断图片是否适合识别，输出 `imageQualityFlags` 和 `needsUserReview`。
- 不根据复杂背景、人体姿态或拍摄角度臆测衣服真实长度和版型；不确定时使用 `unknown`。
- 不把 Qwen-Image-Edit 展示图当作唯一证据。原图是主要事实来源，展示图只用于补充整体轮廓、展开状态和展示理解。
- 不调用或假设淘宝/电商同款图作为真实衣服来源。

建议输出字段：

```ts
type ClosetImageAnalysis = {
  category: string;
  color: string;
  secondaryColors: string[];
  fit: "slim" | "regular" | "oversized" | "unknown";
  styleTags: string[];
  season: string[];
  formality: number;
  scenarioTags: string[];
  summary: string;
  embeddingText: string;
  aiConfidence: number;
  imageQualityFlags: string[];
  needsUserReview: boolean;
  reviewReasons: string[];
};
```

### 12.2 衣橱展示图生成 Prompt

模型：`Qwen/Qwen-Image-Edit-2509`

目标：将用户真实衣服照片整理为衣橱卡片和搭配板可用的白底/浅底商品展示图。

核心提示原则：

- 把任务定义为“忠实图像编辑/整理”，不是重新设计衣服。
- 移除衣架、夹子、挂钩、房间背景、柜子、床架、墙面、杂物、阴影和环境反光。
- 保留原衣服的主色、材质质感、洗旧/磨白纹理、缝线、领型、肩线、袖长、衣长、下摆形状、门襟、纽扣数量与位置、口袋形状与位置。
- 允许轻度整理拍摄造成的倾斜、遮挡感、随意堆叠感和明显杂乱褶皱，让衣服接近自然展开状态。
- 不添加模特、人体、手、衣架、吊牌、品牌 logo、文字、水印、价格或额外配饰。
- 不把衣服改成更时髦、更修身、更宽松、更厚、更薄或另一个商品。

输出用途说明：展示图主要用于衣橱卡片和搭配板，不直接作为 RAG 和购买判断的唯一事实来源。

### 12.3 商品识别 Prompt

要求：识别商品主体，提取价格和促销信息，识别商品卖点，生成候选商品摘要。

### 12.4 搭配生成 Prompt

要求：每套搭配必须引用已有衣服 ID，说明使用场景和搭配逻辑，不允许凭空生成用户没有的单品。

### 12.5 灵感生成 Prompt

要求：可以提供用户没有想到的搭配思路；若涉及用户衣橱中不存在的单品，必须明确表达为“未来可考虑补充的方向”，不能暗示用户已经拥有。

### 12.6 长期主义判断 Prompt

判断顺序：真实穿着场景、衣橱搭配潜力、重复购买风险、舒适度和版型风险、用户长期风格、价格与使用频率、时尚感和好看程度、维护成本。

输出语气：温和、具体、像懂衣柜的朋友，不强行劝退，不做羞辱或审判。

---

## 13. 测试与评测

验收标准：

- 同一输入重复运行时，核心结论基本稳定。
- JSON parse 成功率 >= 95%。
- 推荐决定买之前，至少给出 2 套已有衣橱搭配。
- 可搭配 Top 8 中至少 5 件有明显搭配关系。
- 重复风险 Top 5 能召回高度相似单品。
- 灵感建议必须区分“已有衣橱搭配”和“未来可补充方向”。
- 衣橱上传流程必须保留用户原图，并生成 Qwen-Image-Edit 展示图。展示图不得被当作唯一事实来源；如果展示图明显改变衣服结构、颜色、纽扣、口袋、领型或关键细节，必须标记需要用户确认或回退原图展示。
- 当衣服照片存在遮挡、折叠、背景复杂或未完整入镜时，必须提示用户确认或补拍，而不是强行给出高置信度标签。
- BMI 相关表达不得包含身体羞辱或绝对审美判断。
- 用户不能读取其他用户衣橱、聊天、报告或决策清单。

典型样例：

- 用户已有 3 件黑色西装外套，又上传黑色西装外套，应提示重复风险。
- 用户上传亮色半裙，衣橱缺少可搭鞋包，应降低搭配潜力分并提供灵感方向。
- 用户 BMI 较高，商品是紧身短上衣，只能提示尺码、弹性和活动空间。
- 用户说“只是因为打折很想买”，应触发长期主义判断，倾向先收藏。
- 用户点击“先收藏”，应进入决策清单并生成 24 小时后 reminder。

---

## 14. 已确定的工程配置

### 14.1 LangGraph 实现语言

MVP 使用 `LangGraph.js`，不使用 Python 版本。

### 14.2 模型平台与模型分工

| 能力 | 平台 | 模型 | 调用方式 | 说明 |
|---|---|---|---|---|
| 视觉理解 | AutoDL Art | `qwen3-vl-plus` | OpenAI-compatible chat completions | 衣服图片和商品截图理解 |
| 购买决策 | AutoDL Art | `qwen3.6-plus` | OpenAI-compatible chat completions | 长期主义购买判断、报告生成 |
| 图片编辑 | SiliconFlow | `Qwen/Qwen-Image-Edit-2509` | `/v1/images/generations` | 衣服原图整理为高质量展示图 |
| Embedding | SiliconFlow | `BAAI/bge-m3` | `/v1/embeddings` | 衣橱、商品、知识库向量化 |
| Rerank | SiliconFlow | `BAAI/bge-reranker-v2-m3` | `/v1/rerank` | 对召回结果重排序，MVP 可后置 |

### 14.3 环境变量

```env
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

AUTODL_API_KEY=
AUTODL_OPENAI_BASE_URL=https://www.autodl.art/api/v1
AI_VISION_MODEL=qwen3-vl-plus
AI_DECISION_MODEL=qwen3.6-plus

SILICONFLOW_API_KEY=
SILICONFLOW_BASE_URL=https://api.siliconflow.cn/v1
AI_IMAGE_EDIT_MODEL=Qwen/Qwen-Image-Edit-2509
SILICONFLOW_IMAGE_TIMEOUT_MS=180000
AI_EMBEDDING_MODEL=BAAI/bge-m3
AI_EMBEDDING_DIMENSIONS=1024
AI_RERANK_MODEL=BAAI/bge-reranker-v2-m3
ENABLE_RERANK=false
```

### 14.4 调用策略

- AutoDL Qwen 模型用于视觉理解、搭配生成、长期主义判断和安全表达检查。
- SiliconFlow `Qwen/Qwen-Image-Edit-2509` 用于衣橱图片展示增强，生成白底/浅底商品图。
- SiliconFlow BGE 模型用于 embedding 和 rerank。
- Rerank 第一版默认关闭，先跑通端到端闭环。
- API Route 使用 Node.js runtime。
- 前端使用阶段性进度提示，最终报告一次性返回结构化 JSON。
- 衣橱批量上传时，图片编辑和视觉识别可以按单品并行执行，但需要后端限流和失败回退。

---

## 15. Assumptions

- 第一版产品名和定位统一为“衣服购买决策助手”。
- 第一版通过聊天方式完成购买咨询。
- 第一版前端必须展示三个状态按钮：决定买、先收藏、暂不考虑。
- 第一版所有设置状态的商品进入决策清单。
- 第一版使用 Next.js、Supabase、LangGraph.js、AutoDL Qwen、SiliconFlow Qwen-Image-Edit 和 SiliconFlow BGE。
- 第一版不做完整自治 Agent，不做电商链接解析，不做虚拟试穿。
- BMI 只作为基础版型风险参考，不作为审美评价依据。
