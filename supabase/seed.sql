insert into public.fashion_knowledge (topic, tags, content, source_type, embedding_text)
values
  ('长期主义消费', array['long-term', 'cost-per-wear'], '购买前优先判断未来 30 天是否存在真实穿着场景，以及是否能和已有衣橱搭出至少 2 套。', 'builtin', '长期主义消费 cost per wear 真实穿着场景 衣橱搭配'),
  ('重复购买', array['duplicate', 'wardrobe'], '同品类、同颜色、同场景的单品已有 2 件以上时，应重点比较版型、材质和使用场景差异。', 'builtin', '重复购买 同品类 同颜色 同场景 版型 材质'),
  ('中性色衣橱', array['neutral', 'black', 'white', 'gray'], '黑白灰、藏蓝、米色等中性色适合构建高复用衣橱，但购买时仍需判断已有相似单品数量。', 'builtin', '中性色 黑白灰 藏蓝 米色 高复用 衣橱'),
  ('亮色单品', array['bright-color', 'accent'], '亮色单品适合作为造型亮点，但需要检查衣橱中是否有足够的中性色基础款承接。', 'builtin', '亮色 单品 造型亮点 中性色 基础款'),
  ('版型平衡', array['fit', 'silhouette'], '贴身上装可搭配更利落或有空间感的下装；宽松上装需要注意下装线条，避免整体比例过于松散。', 'builtin', '版型 平衡 贴身 宽松 比例'),
  ('通勤场景', array['commute', 'work'], '通勤单品优先考虑舒适、耐穿、易打理和正式度适中，而不仅是上镜效果。', 'builtin', '通勤 舒适 耐穿 易打理 正式度'),
  ('面试场景', array['interview', 'formal'], '面试穿搭应强调整洁、可靠和克制的个性表达，优先保证上半身质感和整体清爽度。', 'builtin', '面试 整洁 可靠 克制 上半身 质感'),
  ('约会场景', array['date', 'soft'], '约会穿搭可以适度增加柔和材质、颜色或细节，但仍应考虑活动舒适度和个人风格一致性。', 'builtin', '约会 柔和 材质 颜色 细节 舒适'),
  ('旅行拍照', array['travel', 'photo'], '旅行拍照单品可以更有风格，但需要考虑行李空间、鞋履舒适度和多场景复用。', 'builtin', '旅行 拍照 行李 舒适 多场景'),
  ('维护成本', array['care', 'fabric'], '容易皱、难清洗或需要特殊护理的单品，应在购买决策中降低实穿价值评分。', 'builtin', '维护成本 易皱 难清洗 特殊护理 实穿'),
  ('价格判断', array['price', 'value'], '价格是否合理应结合穿着频率、搭配数量和替代单品判断，而不是只看折扣幅度。', 'builtin', '价格 折扣 穿着频率 搭配数量 替代单品'),
  ('灵感边界', array['inspiration', 'honesty'], '提供搭配灵感时必须区分用户已有衣橱单品和未来可补充方向，不能暗示用户已拥有不存在的单品。', 'builtin', '穿搭灵感 已有衣橱 未来补充 诚实边界')
on conflict do nothing;
