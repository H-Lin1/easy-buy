## 1. Compact Card Metadata

- [x] 1.1 Derive an ordered, de-duplicated style-and-scenario tag list for each saved closet card and render only its first four entries in a non-wrapping summary.
- [x] 1.2 Remove the redundant category line and add an accessible `+N` control that previews complete tags on hover/focus and toggles an inline complete-tag list on click or keyboard activation.

## 2. Verification

- [x] 2.1 Run targeted static checks for summary capacity, duplicate removal, `aria-expanded`, hover/focus preview and click/keyboard expansion paths.
- [x] 2.2 Run ESLint, TypeScript, production build, strict OpenSpec validation, `git diff --check`, and desktop/mobile visual verification.
- [x] 2.3 Verify `+N` preview and expanded content contain only the tags excluded from the four-tag summary.
- [x] 2.4 Verify summary, preview and expanded tags share the same visual size, typography, spacing and color treatment.
