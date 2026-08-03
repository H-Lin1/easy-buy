## 1. Implementation Preparation

- [x] 1.1 Read the relevant Next.js 16 client-component guidance before editing the interactive wardrobe UI.

## 2. Search Matching

- [x] 2.1 Add a pure wardrobe filter helper covering the specified fields, trimmed queries, case-insensitive matching, and empty-query behavior.
- [x] 2.2 Add deterministic `node:test` coverage for names, attributes, each tag group, normalization, empty queries, and no matches.

## 3. Wardrobe Search UI

- [x] 3.1 Replace the static search placeholder with an accessible controlled search input and icon-based clear action.
- [x] 3.2 Render filtered cards, active result counts, and a dedicated no-results state while preserving the full-data confirmation panel and wear-frequency statistics.

## 4. Verification

- [x] 4.1 Run the targeted Node search tests and strict OpenSpec validation.
- [x] 4.2 Run the project lint and production build checks.
- [x] 4.3 Verify search, clear, no-results, and layout behavior in authenticated desktop and mobile browser views.
