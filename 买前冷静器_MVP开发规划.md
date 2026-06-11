# 衣服购买决策助手 MVP 开发规划

## 1. 产品定位

**衣服购买决策助手** 是一个面向穿搭爱好者的 AI 购买决策产品。

用户先建立个人档案和云端衣橱，再通过聊天上传想买衣服的商品截图。系统以**长期主义**为核心，判断这件衣服是否能和用户已有衣柜形成有效搭配，是否补足衣橱缺口，是否减少重复购买，并结合价格、样式、版型、场景、舒适度和穿搭灵感，给出温和、可解释、可执行的购买建议。

一句话定位：

> 一个以长期主义为核心的 AI 衣服购买决策助手，帮助用户判断“这件衣服是否真的适合我、能否融入我的衣柜、值不值得买”。

核心价值：

- 降低冲动消费
- 提高衣橱利用率
- 减少重复购买
- 帮助用户形成更清晰的个人穿搭风格
- 将“想买”转化为“是否真的适合我”的理性判断
- 提供用户没有想到的搭配灵感和场景启发
- 支持多用户试用、长期衣橱沉淀和后续用户测试

目标用户：

- 对穿搭有兴趣，但容易冲动购物的人
- 衣柜里衣服不少，但常常觉得没衣服穿的人
- 经常收藏、加购，但不确定是否值得买的人
- 希望建立个人风格和更高衣橱利用率的学生、职场新人、穿搭爱好者

---

## 2. MVP 核心流程

### 2.1 注册登录与 Onboarding

用户首次注册登录后进入 Onboarding，快速填写基础档案：

- 身高
- 体重
- 系统自动计算 BMI
- 穿衣偏好
- 常见穿搭场景
- 风格偏好
- 不喜欢的衣服类型
- 预算敏感度

MVP 不做复杂身材分析，BMI 只用于基础版型和舒适度风险提示。

### 2.2 云端衣橱录入

用户在“衣橱”页面上传已有衣服图片，建立云端衣橱。

第一版不要求录入完整衣柜，只需要录入 10-30 件常穿衣服即可。

衣服图片处理采用“原图可信 + 展示增强”的三层方案：

1. **原始照片**：保存用户上传的原图，作为真实衣橱证据。原图保留衣服的真实颜色、旧化、褶皱和拍摄状态，后续用户可回看和重新识别。
2. **高质量展示图**：调用 SiliconFlow `Qwen/Qwen-Image-Edit-2509`，把衣服从复杂背景中整理为白底/浅底商品图，移除衣架、杂物和环境背景，轻度修复拍摄造成的歪斜、堆叠和明显褶皱，用于衣橱卡片、搭配板和决策报告展示。
3. **AI 标签与结构化信息**：由视觉模型同时读取原图和展示图，识别品类、颜色、版型、风格、季节、正式度、场景等信息。原图是主要事实来源，展示图只作为补充参考；后续 RAG 和购买判断主要依赖用户确认后的结构化标签。

MVP 允许使用生成式图片编辑作为**展示增强图**，但不把它作为唯一真实依据。生成图可能轻微改变领口、袖型、纽扣、口袋、长度、面料纹理或真实颜色，因此必须保留原图，并让视觉识别和用户确认以原图为主。

MVP 也不把淘宝/电商“拍照找同款”的商品图作为主存储来源。相似商品图最多作为后续辅助能力，用于补充材质、品类或风格标签，并且必须经过用户确认；不能直接替换用户真实衣服照片。

AI 自动识别：

- 品类
- 主色与辅助色
- 风格标签
- 季节
- 正式度
- 版型
- 适用场景

用户可以手动修正 AI 标签。修正后的标签应覆盖 AI 初始标签，并用于后续检索和判断。

如果上传照片存在遮挡、折叠、背景复杂、衣服未完整入镜或模型置信度较低，系统应提示用户补拍或进入人工确认流程。MVP 优先支持用户手动确认品类、颜色、版型和适用场景，而不是追求图片视觉上的完美。

### 2.3 决策聊天

MVP 首页就是**决策聊天页**，形态类似大模型聊天产品。

用户可以：

- 新建一条购买决策对话
- 上传商品截图
- 输入补充问题或购买意图
- 让 AI 结合个人档案、衣橱和知识库给出决策建议
- 在 AI 输出后直接选择商品状态

示例输入：

- “这件适合我通勤穿吗？”
- “我衣柜里有没有能搭它的？”
- “这件和我已有的衣服重复吗？”
- “价格 399，值得买吗？”
- “我只是觉得模特图很好看，帮我判断一下是不是真适合我。”

### 2.4 AI 决策输出

AI 输出不只是聊天回答，而是结构化决策卡片 + 自然语言解释。

报告内容：

- 结论：建议决定买 / 先收藏 / 暂不考虑
- 长期主义判断摘要
- 衣橱适配度
- 搭配潜力
- 重复购买风险
- 风格一致性
- 价格与使用频率判断
- 体型/版型友好度
- 舒适度与维护成本
- 2-3 套已有衣橱搭配建议
- 额外穿搭灵感
- 如果不买，衣橱里可替代的单品

AI 输出后提供三个状态按钮：

```text
决定买
先收藏
暂不考虑
```

用户点击后，商品进入“决策清单”。

### 2.5 决策清单

“决策清单”替代原来的“冷静清单”。

所有咨询过并设置状态的商品都会进入决策清单，包括：

- 决定买
- 先收藏
- 暂不考虑

决策清单以商品卡片呈现。每张卡展示：

- 商品截图
- 当前状态
- AI 建议总结
- 关键搭配建议
- 主要风险或提醒
- 价格
- 最近一次咨询时间
- 关联聊天入口

用户可以随时修改状态。

对状态为“先收藏”的商品，系统默认设置 24 小时后提醒用户再次 review：

- 现在还想买吗？
- 是否只是当时冲动？
- 你还能说出 2 个真实穿着场景吗？
- 你已有衣橱能否搭出 2 套以上？
- 是否等降价更合理？

---

## 3. 技术栈与总体架构

推荐技术栈：

- 前端：Next.js App Router + TypeScript + Tailwind CSS
- UI：shadcn/ui + lucide-react
- 认证：Supabase Auth
- 数据库：Supabase Postgres
- 图片存储：Supabase Storage
- 向量检索：Supabase pgvector
- AI 编排：LangGraph.js
- 视觉理解与购买决策：AutoDL Art OpenAI-compatible Qwen 模型
- 图片编辑展示：SiliconFlow `Qwen/Qwen-Image-Edit-2509`
- Embedding 与 Rerank：SiliconFlow BGE 模型
- 本地缓存：IndexedDB，可选，仅缓存展示图和最近报告

总体架构：

```text
Next.js 前端
  -> Supabase Auth 登录
  -> Supabase Storage 上传衣服图 / 商品截图
  -> Next.js API 通信层
  -> LangGraph.js AI 工作流
  -> Supabase Postgres / pgvector 读取与写入
  -> 前端展示聊天、决策报告和决策清单
```

云端数据库作为主数据源。IndexedDB 不作为主数据库，只做可选缓存。

---

## 4. 页面规划

### 4.1 登录 / 注册页

目标：让用户进入自己的云端衣橱和决策记录。

页面元素：

- 邮箱登录 / 注册
- 登录状态提示
- 隐私说明：衣橱图片和商品截图仅用于个人穿搭判断

### 4.2 Onboarding 页

目标：快速建立用户基础档案。

页面元素：

- 身高输入框
- 体重输入框
- BMI 自动计算结果
- BMI 温和说明文案
- 穿衣偏好选择
- 风格偏好选择
- 常见场景选择
- 不喜欢的品类选择
- 预算敏感度选择
- 保存按钮

### 4.3 决策聊天页：首页默认页

目标：作为用户每次进入产品后的主入口。

布局：

- 左侧侧边栏：新对话、聊天记录、衣橱、决策清单、设置
- 中间主区域：当前聊天内容
- 底部输入区：文本输入、图片上传、发送按钮
- AI 输出区：自然语言解释 + 决策卡片 + 状态按钮

侧边聊天记录：

- 每次购买咨询保存为一条 chat session
- 可点击重新加载历史对话
- 标题默认由商品品类、颜色、用户意图或 AI 摘要生成

AI 进度提示：

- 正在识别商品截图
- 正在检索你的衣橱
- 正在寻找可搭配单品
- 正在检查重复购买风险
- 正在补充穿搭灵感
- 正在生成长期主义购买建议

### 4.4 衣橱页

目标：快速录入和管理用户已有衣服。

页面元素：

- 上传衣服图片按钮
- 批量上传入口
- 上传提示：建议平铺或挂拍、衣服完整入镜、避免折叠遮挡、背景尽量简洁
- 衣服卡片列表
- 衣服卡片优先展示 Qwen-Image-Edit 生成的高质量展示图，并保留原图入口
- 品类筛选
- 风格筛选
- 状态筛选
- 标签编辑弹窗
- AI 识别结果确认弹窗：确认品类、颜色、版型、场景、风格标签

衣服状态：

- 常穿
- 偶尔穿
- 闲置
- 已淘汰

### 4.5 决策清单页

目标：管理所有咨询过的商品和用户最终决策。

页面元素：

- 商品卡片列表
- 状态筛选：全部 / 决定买 / 先收藏 / 暂不考虑
- 价格筛选，可后置
- 商品截图
- AI 总结
- 核心搭配建议
- 主要风险提醒
- 当前状态切换按钮
- 24 小时提醒标记
- 关联聊天入口

状态说明：

- `decided_to_buy`：用户已决定购买
- `saved_for_later`：用户先收藏，默认 24 小时后提醒 review
- `not_considering`：用户暂不考虑，但保留记录供未来回看

### 4.6 设置页

目标：管理个人档案、偏好和隐私设置。

页面元素：

- 个人档案编辑
- 风格偏好编辑
- 常见场景编辑
- 预算敏感度编辑
- 数据与隐私说明
- 退出登录

---

## 5. 个人信息模块

```ts
type UserProfile = {
  id: string;
  userId: string;
  heightCm: number;
  weightKg: number;
  bmi: number;
  bmiBand: "underweight" | "normal" | "overweight" | "obese";
  genderPreference?: "womenswear" | "menswear" | "unisex" | "no_preference";
  stylePreferences: string[];
  dislikedCategories: string[];
  commonScenarios: string[];
  budgetSensitivity: "low" | "medium" | "high";
  createdAt: string;
  updatedAt: string;
};
```

BMI 计算公式：

```text
BMI = 体重 kg / (身高 m * 身高 m)
```

中国成人 BMI 参考：

- `< 18.5`：偏低
- `18.5 - 23.9`：正常
- `24 - 27.9`：超重
- `>= 28`：肥胖

BMI 只用于判断基础版型与舒适度风险，不用于审美评价。

---

## 6. 数据库表设计

需要先开启 pgvector：

```sql
create extension if not exists vector;
```

### 6.1 profiles

```sql
create table profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  height_cm numeric,
  weight_kg numeric,
  bmi numeric,
  bmi_band text check (bmi_band in ('underweight', 'normal', 'overweight', 'obese')),
  gender_preference text check (gender_preference in ('womenswear', 'menswear', 'unisex', 'no_preference')),
  style_preferences text[] default '{}',
  disliked_categories text[] default '{}',
  common_scenarios text[] default '{}',
  budget_sensitivity text check (budget_sensitivity in ('low', 'medium', 'high')) default 'medium',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
```

### 6.2 closet_items

```sql
create table closet_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  image_path text not null,
  category text not null,
  color text,
  secondary_colors text[] default '{}',
  fit text check (fit in ('slim', 'regular', 'oversized', 'unknown')) default 'unknown',
  style_tags text[] default '{}',
  season text[] default '{}',
  formality int check (formality between 1 and 5),
  scenario_tags text[] default '{}',
  wear_frequency text check (wear_frequency in ('often', 'sometimes', 'rarely', 'unknown')) default 'unknown',
  status text check (status in ('active', 'idle', 'archived')) default 'active',
  summary text,
  embedding_text text,
  embedding vector(1024),
  ai_confidence numeric,
  user_corrected boolean default false,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
```

### 6.3 chat_sessions

```sql
create table chat_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text,
  status text check (status in ('active', 'archived')) default 'active',
  last_candidate_id uuid,
  last_report_id uuid,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
```

### 6.4 chat_messages

```sql
create table chat_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references chat_sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text check (role in ('user', 'assistant', 'system')) not null,
  content text,
  image_path text,
  candidate_id uuid,
  report_id uuid,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);
```

### 6.5 purchase_candidates

```sql
create table purchase_candidates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid references chat_sessions(id) on delete set null,
  screenshot_path text not null,
  user_intent text,
  category text,
  color text,
  secondary_colors text[] default '{}',
  fit text check (fit in ('slim', 'regular', 'oversized', 'unknown')) default 'unknown',
  style_tags text[] default '{}',
  estimated_price numeric,
  detected_text text,
  selling_points text[] default '{}',
  possible_scenarios text[] default '{}',
  summary text,
  embedding_text text,
  embedding vector(1024),
  ai_confidence numeric,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
```

### 6.6 fashion_knowledge

```sql
create table fashion_knowledge (
  id uuid primary key default gen_random_uuid(),
  topic text not null,
  tags text[] default '{}',
  content text not null,
  source_type text check (source_type in ('builtin', 'external_placeholder')) default 'builtin',
  embedding_text text,
  embedding vector(1024),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
```

### 6.7 assessment_reports

```sql
create table assessment_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid references chat_sessions(id) on delete set null,
  candidate_id uuid not null references purchase_candidates(id) on delete cascade,
  decision text check (decision in ('buy', 'save', 'skip')) not null,
  decision_label text not null,
  scores jsonb not null,
  summary text not null,
  styling_inspirations text[] default '{}',
  reasons_to_buy text[] default '{}',
  reasons_to_save text[] default '{}',
  risks text[] default '{}',
  body_fit_notes text[] default '{}',
  outfit_combinations jsonb default '[]'::jsonb,
  alternatives_from_closet uuid[] default '{}',
  retrieved_context jsonb default '{}'::jsonb,
  safety_checked boolean default false,
  created_at timestamptz default now()
);
```

### 6.8 decision_items

```sql
create table decision_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  candidate_id uuid not null references purchase_candidates(id) on delete cascade,
  report_id uuid references assessment_reports(id) on delete set null,
  session_id uuid references chat_sessions(id) on delete set null,
  status text check (status in ('decided_to_buy', 'saved_for_later', 'not_considering')) not null,
  snapshot_summary text,
  snapshot_outfit_tips text[] default '{}',
  snapshot_risks text[] default '{}',
  reminder_at timestamptz,
  last_reviewed_at timestamptz,
  final_reflection text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
```

规则：

- 用户点击“决定买”：创建或更新 `decision_items.status = 'decided_to_buy'`，不设置默认提醒。
- 用户点击“先收藏”：创建或更新 `decision_items.status = 'saved_for_later'`，默认 `reminder_at = now() + interval '24 hours'`。
- 用户点击“暂不考虑”：创建或更新 `decision_items.status = 'not_considering'`，不设置默认提醒。

### 6.9 feedback_events

```sql
create table feedback_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  report_id uuid references assessment_reports(id) on delete cascade,
  event_type text not null,
  rating int check (rating between 1 and 5),
  comment text,
  created_at timestamptz default now()
);
```

### 6.10 索引与权限

需要索引：

- `closet_items.user_id`
- `chat_sessions.user_id`
- `chat_messages.session_id`
- `purchase_candidates.user_id`
- `assessment_reports.user_id`
- `decision_items.user_id`
- `decision_items.status`
- `decision_items.reminder_at`
- `feedback_events.user_id`
- `closet_items.embedding`
- `purchase_candidates.embedding`
- `fashion_knowledge.embedding`

RLS 规则：

- 用户只能读取、修改自己的 profile、衣橱、聊天、商品、报告、决策清单和反馈。
- `fashion_knowledge` 对登录用户只读。
- Storage 文件路径按 userId 隔离。

---

## 7. API 与通信层

前端不直接调用大模型。所有 AI 能力通过 Next.js API Route 进入后端通信层，再由 LangGraph 编排。

### 7.1 衣服识别

```text
POST /api/ai/analyze-closet-item
```

职责：上传衣服原图到 Storage，调用 `Qwen/Qwen-Image-Edit-2509` 生成高质量展示图，调用视觉模型同时读取原图和展示图进行识别，进入用户确认流程，确认后生成 embedding，写入 `closet_items`。批量上传时允许多件衣服并行处理，但需要限制并发数，避免模型接口超时或费用失控。

### 7.2 聊天会话

```text
POST /api/chats
GET /api/chats
GET /api/chats/:id
```

职责：创建、列出、加载历史聊天。

### 7.3 购买决策聊天

```text
POST /api/chats/:id/messages
```

职责：接收用户文本和商品截图，创建聊天消息，启动 LangGraph，写入 `purchase_candidates`、`assessment_reports` 和 assistant message，返回 AI 决策结果。

### 7.4 决策状态更新

```text
POST /api/decision-items
PATCH /api/decision-items/:id
GET /api/decision-items
```

职责：把商品加入决策清单，或更新状态为“决定买 / 先收藏 / 暂不考虑”。

### 7.5 反馈

```text
POST /api/reports/:id/feedback
```

职责：记录用户是否觉得建议有帮助。

---

## 8. AI 工作流与 LangGraph

MVP 使用 LangGraph.js，但不做完全自治 Agent。

```text
START
  -> analyzePurchaseScreenshot
  -> loadUserContext
  -> retrieveClosetMatches
  -> decideNeedFashionKnowledge
  -> retrieveFashionKnowledge
  -> generateOutfitCombinations
  -> assessLongTermPurchase
  -> safetyToneCheck
  -> persistChatAndReport
  -> END
```

轻 Agent 节点负责：

- 判断是否需要检索穿搭知识库
- 判断是否需要追问用户补充信息
- 判断最终建议偏向决定买、先收藏还是暂不考虑
- 生成额外穿搭灵感

---

## 9. 开发里程碑

### Day 1：项目初始化与云端基础设施

- 创建 Next.js 项目
- 配置 TypeScript、Tailwind CSS、shadcn/ui
- 配置 Supabase Auth、Postgres、Storage、pgvector
- 创建数据库表和 RLS 策略
- 配置环境变量

### Day 2：认证、Onboarding 与基础布局

- 实现登录 / 注册
- 完成 Onboarding 页
- 实现 BMI 自动计算
- 搭建聊天式主界面和侧边栏导航

### Day 3：衣橱录入

- 实现衣服图片上传
- 接入 `Qwen/Qwen-Image-Edit-2509` 生成衣橱展示图
- 接入 `/api/ai/analyze-closet-item`
- 写入 `closet_items`
- 衣橱页展示云端数据和标签编辑

### Day 4：聊天会话与商品截图

- 实现 chat sessions 和 chat messages
- 实现商品截图上传
- 建立 `/api/chats/:id/messages`
- 搭建 LangGraph 基础图

### Day 5：RAG 检索与搭配灵感

- 实现 pgvector 衣橱检索
- 实现重复风险检索
- 实现内置穿搭知识库检索
- 生成 2-3 套搭配方案和额外灵感

### Day 6：决策输出与决策清单

- 生成长期主义购买决策报告
- 在聊天中展示决策卡片和三个状态按钮
- 实现 `decision_items`
- 实现决策清单页和状态修改
- 为“先收藏”商品设置 24 小时提醒时间

### Day 7：测试、修正与作品集材料

- 准备 10 个 AI 评测样例
- 修复 AI 输出和 UI 问题
- 验证 RLS 权限
- 录制 1 分钟 demo
- 整理 PRD、Prompt 迭代记录和测试反馈

---

## 10. 测试计划

核心验收场景：

1. 用户登录后默认进入决策聊天页。
2. 新用户完成 Onboarding 后能进入主界面。
3. 用户可以上传衣服并生成云端衣橱标签。
4. 用户可以在聊天里上传商品截图并得到结构化购买建议。
5. AI 能结合衣橱给出至少 2 套已有单品搭配，推荐买前必须满足该条件。
6. AI 能提供额外穿搭灵感，但不得凭空声称用户已有某件不存在的衣服。
7. 用户可以把商品状态设置为“决定买 / 先收藏 / 暂不考虑”。
8. 决策清单能展示商品卡片、状态、AI 总结和搭配建议。
9. “先收藏”的商品默认生成 24 小时后提醒时间。
10. 用户可以在决策清单中随时修改商品状态。
11. BMI 相关表达不包含身体羞辱或绝对审美判断。
12. RLS 阻止用户读取其他人的数据。

用户测试指标：

- 5 名用户完成完整流程
- 每人至少录入 10 件衣服
- 每人至少上传 2 个想买商品截图
- 80% 用户能理解 AI 给出的判断理由
- 60% 用户认为建议对购买决策有帮助
- 平均一次判断流程控制在 3 分钟内
- 记录用户是否因为建议改变购买状态

---

## 11. 后续可扩展方向

- 购物链接解析
- 穿搭日历
- 消费复盘
- 衣柜利用率分析
- 个人风格画像
- 预算与消费控制
- 更细身材维度
- 完整 Agent 系统
- 外部穿搭知识检索
- 决策清单提醒通知
- 云端向量检索优化与跨设备同步

---

## 12. 已确定的工程配置

### 12.1 模型与平台

| 能力 | 平台 | 模型 | 用途 | 是否进入 MVP |
|---|---|---|---|---|
| 视觉理解 | AutoDL Art，OpenAI-compatible API | `qwen3-vl-plus` | 衣服图片识别、商品截图识别 | 是 |
| 购买决策 | AutoDL Art，OpenAI-compatible API | `qwen3.6-plus` | 长期主义购买判断、结构化报告生成 | 是 |
| 图片编辑 | SiliconFlow | `Qwen/Qwen-Image-Edit-2509` | 衣服原图整理为高质量白底展示图 | 是 |
| Embedding | SiliconFlow | `BAAI/bge-m3` | 衣橱、商品、穿搭知识库向量化 | 是 |
| Rerank | SiliconFlow | `BAAI/bge-reranker-v2-m3` | 对候选衣橱和知识片段重排序 | 可接入，非阻塞 |

`BAAI/bge-m3` 输出 1024 维向量，因此 Supabase pgvector 字段统一为 `vector(1024)`。

### 12.2 环境变量

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

### 12.3 Storage bucket

```text
closet-images
purchase-screenshots
```

两个 bucket 均为 private。

路径规则：

```text
closet-images/{userId}/{itemId}.webp
purchase-screenshots/{userId}/{candidateId}.webp
```

### 12.4 运行方式

- 登录方式：邮箱 + 密码
- API runtime：Node.js runtime
- AI 进度：阶段性进度提示，最终报告一次性返回结构化 JSON
- Rerank：第一版默认 `ENABLE_RERANK=false`，后续按质量需求开启

---

## 13. Assumptions

- 第一版产品名和定位统一为“衣服购买决策助手”。
- 第一版默认首页是决策聊天页。
- 第一版侧边栏包含聊天记录、衣橱、决策清单、设置。
- 第一版所有设置状态的商品都会进入决策清单。
- 第一版使用 Next.js、Supabase、LangGraph.js、AutoDL Qwen、SiliconFlow Qwen-Image-Edit 和 SiliconFlow BGE。
- 第一版不做完整自治 Agent，不做电商链接解析，不做虚拟试穿。
- 第一版衣橱图片采用“原图 + Qwen-Image-Edit 高质量展示图 + 双图视觉识别 + 人工确认”。展示图用于衣橱卡片和搭配板，原图仍是真实依据。
- 第一版不使用淘宝/电商找同款商品图作为主图；相似商品检索后续只可作为标签补全参考，并需用户确认。
- BMI 只作为基础版型风险参考，不作为审美评价依据。
