## 1. Workflow Foundation

- [x] 1.1 Read the applicable Next.js 16 Client Component, Route Handler, error handling and Playwright guidance, then map current upload, analysis, confirmation, display and trace ownership boundaries.
- [x] 1.2 Add typed pure helpers for operation-owned item patches, explicit reanalysis drafts, legacy display-flag filtering, claimable display statuses and aggregated completion notices.
- [x] 1.3 Add focused unit tests proving response-order independence, preservation of user-confirmed and display fields, status filtering, notification de-duplication and mixed-result summaries.

## 2. Server Ownership And Single-Flight

- [x] 2.1 Make the display-image Route conditionally claim `processing`, return 409 without provider work when already owned, and conditionally commit only display-owned ready or failed fields.
- [x] 2.2 Narrow the display-image response to display-owned fields and remove every display Route read or write of `image_quality_flags` while preserving timing, authentication, provider and Storage behavior.
- [x] 2.3 Remove display workflow flag handling from new-item creation and visual analysis, shorten the confirmation flag snapshot window, and guard analysis commits with per-request ownership so confirmation remains authoritative (including explicit confirmed-item reanalysis).

## 3. Nonblocking Client Flow

- [x] 3.1 Replace the shared closet busy state with per-operation analysis, confirmation, display and deletion state, keeping confirm enabled during display generation, locking uploads through batch analysis settlement, and guarding analysis, deletion and duplicate generation actions.
- [x] 3.2 Consume analysis, confirmation and display responses through operation-owned patches, apply explicit reanalysis drafts, acquire only the new display signed URL, and ignore legacy display workflow flags in the UI.
- [x] 3.3 Return the upload interaction after analysis completes while the display promise continues with explicit error handling and full trace finalization.
- [x] 3.4 Add a root-level responsive success/failure notification with current-name lookup, item-ID de-duplication, batch aggregation, auto-dismiss, close control, polite live-region semantics and a “查看衣橱” action.
- [x] 3.5 Render generated display images with `object-contain` on a white background in both confirmation and closet-card surfaces, while preserving `object-cover` for uploaded originals.

## 4. Verification

- [x] 4.1 Run focused and full Node tests, lint, production build, strict OpenSpec validation and `git diff --check`.
- [x] 4.2 Verify desktop and mobile UI states for analysis-first confirmation, display-first and confirmation-first response order, single and batch notifications, internal view switching, failures, retry guards and no incoherent overlap.
- [x] 4.3 Perform a real local upload when credentials and provider access are available, confirm the save action becomes available after analysis rather than display, and capture remaining confirmation and display timing limits.
- [x] 4.4 Verify the display-fit adjustment with 17 focused tests, ESLint, TypeScript and `git diff --check`; confirm generated-image and original-image modes select `contain` and `cover` independently.
