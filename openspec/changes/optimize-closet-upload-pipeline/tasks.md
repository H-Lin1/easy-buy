## 1. Timing Foundation

- [x] 1.1 Read the applicable Next.js 16 Route Handler guidance and map every existing browser, Route, provider, Storage and database timing boundary without changing the call graph.
- [x] 1.2 Implement a shared monotonic trace utility with parallel span offsets, success/failure states, safe request ID handling and `Server-Timing` formatting.
- [x] 1.3 Add focused unit tests for deterministic span timing, parallel offsets, error completion, request ID sanitization, safe summaries and header formatting.

## 2. Server-Side Route Timing

- [x] 2.1 Instrument the closet visual-analysis Route across request parsing, authentication, database preparation, provider work, response parsing and database finalization.
- [x] 2.2 Instrument the closet display-image Route across request parsing, authentication, database preparation, provider headers/body, image decoding or download, Storage upload and database finalization.
- [x] 2.3 Return `X-Request-Id` and `Server-Timing` on success and failure paths, and emit one secret-free structured performance log per Route request without adding remote operations.

## 3. Browser Upload Timing

- [x] 3.1 Generate one trace per uploaded file and record file reading, original Storage upload, record insertion, initial signed URLs and both parallel AI HTTP branches.
- [x] 3.2 Preserve service timing headers in the client summary and record the first display-image load or error without blocking the existing UI workflow.
- [x] 3.3 Emit one bounded, secret-free browser summary per uploaded item and clean up completed or timed-out trace state.

## 4. Verification

- [x] 4.1 Run targeted timing and existing closet tests, TypeScript checking, lint, production build, OpenSpec strict validation and `git diff --check`.
- [x] 4.2 Verify on desktop and mobile that original and display images retain their current framing, and confirm a real upload exposes correlated browser, Network and server timing data without changing upload behavior.
