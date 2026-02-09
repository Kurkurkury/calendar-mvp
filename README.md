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
