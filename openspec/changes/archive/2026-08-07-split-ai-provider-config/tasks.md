## 1. Configuration Contract

- [x] 1.1 Read the applicable Next.js 16 Route Handler and environment-variable guidance before modifying server-side configuration code.
- [x] 1.2 Replace shared AutoDL and SiliconFlow environment-variable parsing with independent vision, decision, embedding and image-edit configuration objects; remove all runtime reads of the legacy shared variables.
- [x] 1.3 Validate provider names and required fields per capability, expose safe configuration metadata, and ensure error/log helpers never serialize credentials.
- [x] 1.4 Update `.env.example` with the four capability-level configuration groups, current default provider values, and required timeout/dimension settings.

## 2. Provider Integration

- [x] 2.1 Refactor OpenAI-compatible chat, vision and embedding clients to use the configuration selected for their own capability only.
- [x] 2.2 Update the purchase workflow and AI route handlers so decision, vision and embedding calls preserve their current fallback behavior while using isolated configuration.
- [x] 2.3 Move SiliconFlow image-edit endpoint selection, authorization and model usage behind the configured image provider adapter; reject unsupported image providers before sending an external request.
- [x] 2.4 Update the health endpoint to report safe provider/model/configured metadata for all four capabilities without exposing secrets.
- [x] 2.5 Register the Tripo image-edit adapter; implement multipart `/images/edits` requests with data-URL-to-Blob conversion, negative-constraint transfer and URL/Base64 output normalization while retaining SiliconFlow JSON compatibility.

## 3. Verification

- [x] 3.1 Add focused automated coverage for capability config parsing, independent key selection, unsupported provider handling, legacy-variable non-use, fallback behavior and secret-free diagnostics.
- [x] 3.2 Run the targeted configuration tests, existing closet filter tests, `npm run lint`, and `npm run build`.
- [x] 3.3 Verify locally with independent test values that each ability receives only its own configuration and that no API Key appears in health or error output.
- [x] 3.4 Deploy a Preview after populating the selected Vercel capability variables; verify `/api/health` and authenticated vision, decision, embedding and selected image-provider flows before production rollout.
- [x] 3.5 Add mocked adapter coverage for SiliconFlow JSON and Tripo multipart request contracts, the absence of manually set multipart `Content-Type`, Base64 output normalization, unsupported-provider no-request and secret-free errors; rerun local checks and restart the local server to verify the Tripo health metadata without making a billable image request.

## 4. Deployment Migration

- [x] 4.1 Add the four new capability-level variable groups to Vercel Production and Preview before deploying the implementation, retaining the existing AutoDL/SiliconFlow values where selected and populating `AI_IMAGE_EDIT_*` with Tripo/Lumina values when switching image edit.
- [x] 4.2 Deploy the implementation to Production after Preview verification, then verify the production health endpoint and representative AI flows.
- [x] 4.3 Remove the legacy `AUTODL_*` and `SILICONFLOW_*` shared variables from Vercel only after production verification; retain a secure rollback record until the release is stable.
