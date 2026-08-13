## 1. Progress UI Foundation

- [x] 1.1 Add the lightweight `thinking-orbs` dependency and create an accessible inline task-status presentation for the pending-upload card.
- [x] 1.2 Derive recognition and display-image states independently, including persisted recognition queue state after a refresh.

## 2. Pending Upload Card Simplification

- [x] 2.1 Replace the image-below quality-flag and mixed-status area with the two fixed status rows and remove redundant quality-tag rendering from that area.
- [x] 2.2 Preserve form editing, confirmation, retry, failure and image-switch behavior while progress states change.

## 3. Verification

- [x] 3.1 Run targeted checks for the status-state mappings and accessibility semantics.
- [x] 3.2 Run ESLint, TypeScript, production build, strict OpenSpec validation, `git diff --check`, and desktop/mobile visual verification.
