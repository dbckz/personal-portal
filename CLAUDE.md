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

**Mobile is read-only by default.** Surface and view the data there; creating,
editing, deleting and wizard flows belong on the desktop. Reuse shared modules
rather than duplicating logic.

**Exception: exercise logging is read/write on mobile.** Sessions are logged
standing in a gym, so the phone is the primary surface for it — starting a
session, ticking exercises off, correcting weights and adding notes all write
from `/mobile`. Those writes save per-action and optimistically, because the
connection is unreliable and a lost session is unrecoverable. Anything else
stays read-only unless Dave says otherwise.

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
