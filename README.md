# Calendar MVP

## Cold-start verification steps

1. Open the app with `?debug=1` (or run on localhost) to enable the cold-start debug overlay.
2. Reload the app and confirm the banner shows “Backend startet …” during warmup.
3. Verify the overlay reports:
   - `backendState` transitions from `warming` to `ready` (or `failed` if the backend stays unavailable).
   - `toastSuppressed: true` during the initial cold start failure state.
4. Click “Erneut versuchen” and confirm a toast appears only after the manual retry.
5. Check the browser console for `[COLDSTART]` logs for boot start/end and warmup attempts.
