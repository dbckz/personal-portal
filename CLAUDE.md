# Personal Portal (repo: `dbckz/personal-portal`)

Formerly "the calendar app". It is now a personal portal with life-area
sections — Work (the original tabs), Exercise, Music — plus a cross-cutting
Goals section. Served at `portal.localhost`; `calendar.localhost` remains as an
alias.

The launchd labels, the data directory and the GitHub repo were renamed to match
on 5 Aug 2026. `calendar.localhost` stays as a hostname alias for old bookmarks,
and the data-directory lookup still falls back to the old `~/.claude/data/calendar/`
path when only that exists — this repo runs on two machines and the other one
may not be migrated.

## Mobile parity

The `/mobile` view (`src/app/mobile/`) must be kept in step with the desktop:
when a feature is added or changed, add the mobile equivalent as part of the
same piece of work.

**Mobile is read/write** (Dave's instruction, 11 Aug 2026 — supersedes the
earlier read-only-by-default policy). Mobile should offer functionality very
similar to the desktop, adapted to touch idioms: bottom sheets and tap flows
instead of drag-and-drop, hover and double-click. Reuse shared modules (api
client, hooks, lib) rather than duplicating logic.

Mobile writes save per-action and optimistically — the pattern generalised
from exercise logging (`useTodaySession`'s `runWrite`: optimistic apply,
reconcile server actuals, roll back on failure, per-row busy state) — because
phone connections are unreliable. Commit text inputs on blur, not per
keystroke.

## Development and deployment

**Deploys are NOT gated on Dave's approval** (his instruction, 9 Aug 2026):
once a change is implemented and the full test suite passes, commit, push, and
deploy to production immediately without asking. (A staging worktree existed
briefly on 8–9 Aug 2026; Dave had it removed — develop directly in this
checkout.)

- Never run `npm run build` except as part of a deploy — it replaces `.next`
  under the live launchd server and breaks the running app until restarted.
  Test with jest/tsc during development; build only when about to restart.
- To deploy, after pushing:

```bash
npm run build && launchctl stop com.davebuckley.portal && launchctl start com.davebuckley.portal
```

- `PORTAL_DATA_DIR` env var overrides the data directory (normally unset in
  production; useful for pointing a scratch instance at copied data).
