# Changelog

## [Unreleased]

- 修复 Query API 对负数、无限值和小数 `limit` 的边界处理。
- 修复空 `sessions: []` 过滤条件被错误忽略的问题。
- 修复 `raw()` 的非法负数 `offset`。
- 防止 `context()` / `trace()` 遇到循环 `parent_uuid` 时无限循环。

## [0.2.1]

重构记录见 [重构.md](docs/重构.md)。
