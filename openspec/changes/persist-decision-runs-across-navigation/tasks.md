## 1. Persistent Run Model

- [x] 1.1 Add a Supabase migration for `decision_runs`, nullable `decision_run_id` links, idempotency indexes, owner SELECT RLS, Realtime publication, and indexes for active/recoverable runs.
- [x] 1.2 Add atomic database functions for per-user lease claim, lease renewal/release, expired-run recovery, and session cancellation with a maximum of two valid running leases.
- [x] 1.3 Add shared decision-run TypeScript types, status derivation, terminal-state helpers, and focused unit tests for state and polling behavior.

## 2. Server-Side Decision Execution

- [x] 2.1 Extract the existing screenshot upload, candidate analysis, embedding, closet retrieval, decision, and report persistence flow into a server-only runner that can resume from persisted stage data.
- [x] 2.2 Make candidate, report, user message, and assistant message persistence idempotent by `decision_run_id`, and guard every stage transition with the active lease token.
- [x] 2.3 Add an authenticated `POST /api/ai/decision-runs` endpoint that validates session ownership, stores the screenshot and user turn, deduplicates `clientRequestId`, returns `202`, and schedules immediate processing.
- [x] 2.4 Add authenticated run query and session cancellation endpoints, plus a protected recovery endpoint that scans queued and lease-expired runs without exposing service credentials.
- [x] 2.5 Preserve the existing no-image guidance path and legacy completed-conversation reads while routing new image-backed decisions through persistent runs.

## 3. Resumable Try-On Execution

- [x] 3.1 Extend persistent try-on rows with run association, attempt metadata, leases, and stale-processing recovery while preserving existing ready images.
- [x] 3.2 Move try-on generation behind the run worker, remove browser disconnect as a cancellation signal, keep at most three image jobs parallel, and commit only while the run lease is valid.
- [x] 3.3 Mark runs `completed` or `completed_with_errors` from persisted child results and retain the text report plus successful images when only part of the batch fails.

## 4. Session-Scoped Client State

- [x] 4.1 Add a page-level run store keyed by session ID, with initial query, Supabase Realtime updates, visibility/reconnect resync, and five-second fallback polling only while active runs exist.
- [x] 4.2 Change chat submission to create a stable client request ID, render the persisted run stage, and stop applying asynchronous results through the currently active global chat state.
- [x] 4.3 Make new-chat, historical-chat, and application-view navigation preserve background runs; guard chat hydration against stale requests so one session cannot overwrite another.
- [x] 4.4 Restore persisted progress, decision elapsed time, report, and try-on results when opening a new-format conversation, while leaving legacy conversations on their existing metadata path.
- [x] 4.5 Route deletion through explicit server cancellation before local removal and show queued, running, partial-failure, failure, and cancelled states without adding a separate task-management UI.

## 5. Recovery And Verification

- [x] 5.1 Add deployment recovery scheduling documentation/configuration and ensure the immediate `after()` path is not the only way queued or expired work resumes.
- [x] 5.2 Add targeted tests for idempotent submission, two-run concurrency, lease expiry and stale-worker rejection, cancellation races, partial try-on failure, polling fallback, and cross-session isolation.
- [x] 5.3 Apply the migration locally and run focused tests, TypeScript checking, lint, production build, strict OpenSpec validation, and `git diff --check`.
- [x] 5.4 Verify in the authenticated local UI that A can continue while creating B, opening C, switching views, refreshing, losing Realtime temporarily, and deleting an active session without cross-session result leakage.
