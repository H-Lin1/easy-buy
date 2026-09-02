## ADDED Requirements

### Requirement: 并发效果图失败重试

系统 MUST 保持效果图任务的并发执行，并对每个失败任务最多自动重试一次。

#### Scenario: 部分任务失败时只重试失败任务

- **WHEN** 一个并发批次中部分任务成功、部分任务失败
- **THEN** 系统 MUST 保留成功任务结果，只对失败任务再发起一次生成
- **AND** 系统 MUST NOT 重复生成已成功任务

#### Scenario: 重试后仍失败

- **WHEN** 某任务首次生成失败且单次重试仍失败
- **THEN** 系统 MUST 将该任务标记为失败
- **AND** 整批任务 MUST 返回已成功和最终失败的准确数量及失败原因

#### Scenario: 首次全部成功

- **WHEN** 并发批次中的所有任务首次生成成功
- **THEN** 系统 MUST NOT 发起额外重试
