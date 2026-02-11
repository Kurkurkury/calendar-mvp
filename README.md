# Calendar MVP

## Single Source of Truth

`PROJECT_TRUTH_FILE_FINAL.md` is the authoritative source for the project plan, phase definitions, and status. This README is a summarized, human-readable mirror of that file and should never replace it. If anything here conflicts with the truth file, the truth file wins.

## Project Plan (from PROJECT_TRUTH_FILE_FINAL.md)

### Phase 1 [COMPLETED]
- **Goal:** Refer to `PROJECT_TRUTH_FILE_FINAL.md`.
- **Guiding question:** Refer to `PROJECT_TRUTH_FILE_FINAL.md`.
- **Includes (short list):** Refer to `PROJECT_TRUTH_FILE_FINAL.md`.

### Phase 2 [COMPLETED]
- **Goal:** Refer to `PROJECT_TRUTH_FILE_FINAL.md`.
- **Guiding question:** Refer to `PROJECT_TRUTH_FILE_FINAL.md`.
- **Includes (short list):** Refer to `PROJECT_TRUTH_FILE_FINAL.md`.

### Phase 3 [COMPLETED]
- **Goal:** Refer to `PROJECT_TRUTH_FILE_FINAL.md`.
- **Guiding question:** Refer to `PROJECT_TRUTH_FILE_FINAL.md`.
- **Includes (short list):** Refer to `PROJECT_TRUTH_FILE_FINAL.md`.

### Future phases [FUTURE]
- **Goal:** Refer to `PROJECT_TRUTH_FILE_FINAL.md` for exact phase names, ordering, and goals.
- **Guiding question:** Refer to `PROJECT_TRUTH_FILE_FINAL.md`.
- **Includes (short list):** Refer to `PROJECT_TRUTH_FILE_FINAL.md`.

## Current Status (Verified)

- **Phase 1:** completed
- **Phase 2:** completed
- **Phase 3:** completed

Verified outcomes:
- Cold-start UX verified (no blank screen, no early error toasts).
- Render Free backend handled via loading/retry UX.
- Google OAuth & Calendar integration stable.
- Mobile navigation stable.
- Debug overlay disabled by default.

## Cold-start verification steps

1. Open the app with `?debug=1` (or run on localhost) to enable the cold-start debug overlay.
2. Reload the app and confirm the banner shows “Backend startet …” during warmup.
3. Verify the overlay reports:
   - `backendState` transitions from `warming` to `ready` (or `failed` if the backend stays unavailable).
   - `toastSuppressed: true` during the initial cold start failure state.
4. Click “Erneut versuchen” and confirm a toast appears only after the manual retry.
5. Check the browser console for `[COLDSTART]` logs for boot start/end and warmup attempts.

## Phase 4 – Preparation (Not Started)

### Goal
- Define a concrete, release-ready Phase 4 execution plan with measurable acceptance criteria, explicit risk handling, and a pre-flight checklist before any implementation begins.

### In-scope
- Finalize Phase 4 feature scope boundaries and assumptions.
- Define user-facing and technical acceptance criteria.
- Document known risks, edge cases, and mitigation expectations.
- Prepare a test matrix covering key devices and critical application states.
- Prepare a release checklist (quality, operations, and rollback readiness).

### Out-of-scope
- Any code or configuration implementation for Phase 4.
- Marking Phase 4 as active or in progress.
- Changing phase status of completed phases.
- Backfilling historical phase deliverables.

### Acceptance criteria
- A single agreed Phase 4 scope statement exists with clear boundaries.
- Every planned Phase 4 outcome has testable, binary pass/fail acceptance criteria.
- Risks and edge cases are listed with expected behavior and owner/mitigation notes.
- The test matrix covers desktop and mobile form factors and includes happy-path + failure-path states.
- The release checklist includes: pre-release checks, launch readiness checks, post-release verification, and rollback criteria.
- Documentation explicitly states that Phase 4 is **Not Started**.

### Risks & edge cases
- Scope creep risk from undefined “nice-to-have” additions.
- Ambiguous acceptance criteria causing inconsistent QA decisions.
- Regression risk across OAuth/session/calendar sync flows while shipping Phase 4 changes.
- Cold-start and backend unavailability masking real Phase 4 behavior during validation.
- Mobile-only interaction issues (viewport, keyboard overlap, navigation state persistence).
- Third-party dependency instability (Google APIs, Render backend wake behavior).
- Release timing risk if checklist gates are skipped or compressed.

### Test matrix (devices × states)

| Device / Environment | Initial load (warm backend) | Initial load (cold backend) | Auth (sign-in / reconnect) | Calendar data load | Manual retry flow | Mobile navigation/state restore |
| --- | --- | --- | --- | --- | --- | --- |
| Desktop Chrome (latest) | Required | Required | Required | Required | Required | N/A |
| Desktop Firefox (latest) | Required | Required | Required | Required | Required | N/A |
| iOS Safari (latest) | Required | Required | Required | Required | Required | Required |
| Android Chrome (latest) | Required | Required | Required | Required | Required | Required |

State expectations:
- Warm backend: app is interactive without blocking errors.
- Cold backend: loading/retry UX is visible and user guidance is clear.
- Auth reconnect: no duplicate prompts, stable return path.
- Calendar load: consistent success/error states with actionable feedback.

### Phase 4 regression checks (implementation matrix addendum)
- Mobile nav controls: no duplicate/conflicting day/month navigation controls visible at the same time on iOS Safari and Android Chrome.
- Bottom bar + safe area: bottom navigation never overlaps interactive content, including device safe-area inset scenarios.
- Header/day-row alignment: app header and month/day scroller stay aligned through rotate, resize, and view switches.
- Resume behavior: returning from background triggers silent health re-check; toast appears only after manual retry action.
- Warmup behavior: cold backend shows “Backend startet …” banner with retry/backoff and no blocking blank screen.

### Release checklist
- Scope sign-off completed (product + engineering).
- Acceptance criteria reviewed and test-case mapped.
- Risk/edge-case review completed with explicit owners.
- Manual QA run completed for all required test matrix cells.
- Regression checks completed for existing completed phases.
- Observability checks ready (logs/events needed for rollout monitoring).
- Rollback plan validated (trigger conditions + execution owner).
- Release notes drafted and stakeholder communication prepared.
- Go/No-Go decision recorded.
- Post-release verification checklist prepared (first-hour and first-day checks).

## V3 Phase 2 – Document Parsing (Read-only)

Phase 2 adds explicit, user-triggered semantic parsing for extracted/pasted document text.

### Usage
- Open the **Document** card.
- Add text by either:
  - uploading an image/PDF and clicking **Text extrahieren**, or
  - pasting text into the fallback textarea.
- Click **Struktur erkennen**.
- Review the read-only parsed output under **Parsed Items (Read-only JSON)** and in the minimal suggestions list.

### API
- Endpoint: `POST /api/doc/parse`
- Input JSON: `{ text, locale, timezone, referenceDate }`
- Output JSON: `{ items, meta }`
- `items[]` normalized schema:
  - `type`: `"event" | "task"`
  - `title`: `string`
  - `dateISO`: `"YYYY-MM-DD" | null`
  - `startTime`: `"HH:MM" | null`
  - `durationMin`: `number | null`
  - `location`: `string` (empty when unknown)
  - `confidence`: `number` (`0..1`)
  - `sourceSnippet`: `string` (short, privacy-safe)

### Notes
- Parsing runs only on explicit button click (no auto-parse/background parse).
- Deterministic heuristics run first; optional AI fallback is used only when deterministic output is empty or text is highly ambiguous.
- This phase is read-only: no calendar write is performed by parse actions.
