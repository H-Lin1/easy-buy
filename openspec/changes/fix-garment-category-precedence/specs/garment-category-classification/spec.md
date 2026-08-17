## Purpose

确保购买决策中的待买商品和衣橱单品使用一致且无歧义的品类分组，使 RAG 槽位、证据角色与用户看到的真实服装类别保持一致。

## ADDED Requirements

### Requirement: Overlapping garment names resolve to the intended category

系统 SHALL 以明确优先级处理同时包含多个品类关键词的名称，并 MUST 保证候选商品归类、衣橱召回槽位和新报告证据角色使用一致的分类结果。

#### Scenario: Suit trousers are classified as bottoms
- **WHEN** 服装品类为“西装裤”或其他明确包含裤装含义的名称
- **THEN** 系统将其归为下装并显示“可搭裤装”角色
- **THEN** 系统不得仅因名称包含“西装”而将其归为外套

#### Scenario: Suit jackets remain outerwear
- **WHEN** 服装品类为“西装外套”或明确的西装夹克
- **THEN** 系统将其归为外套并显示“可搭外套”角色

#### Scenario: One-piece categories take precedence
- **WHEN** 服装品类为“连体裤”“连衣裙”或“西装套装”
- **THEN** 系统将其归为一件式或完整套装，而不是普通下装或外套

### Requirement: Historical reports remain unchanged

系统 SHALL 仅对新生成或缺少持久化角色的新数据应用修正后的分类规则，并 MUST NOT 自动改写已经保存的历史报告角色。

#### Scenario: Existing report contains an incorrect persisted role
- **WHEN** 历史报告已保存与品类不一致的 `role` 或 `badge`
- **THEN** 本次变更不迁移或覆盖该历史字段
