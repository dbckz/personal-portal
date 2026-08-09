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

**Deploys are NOT gated on Dave's approval** (his instruction, 9 Aug 2026 —
superseding the earlier staged-approval workflow): once a change is implemented
and the full test suite passes, commit, push, and deploy to production
immediately without asking.

- Dave uses the production app (`portal.localhost`) all day. A **staging
  worktree** exists as a scratch area for development so the live app isn't
  disturbed mid-work: `/Users/dave/working_dir/github/dbckz/personal-portal-staging`
  (branch `staging`), served at `portal-staging.localhost` (port 3002) by the
  launchd service `com.davebuckley.portal-staging` running `next dev` via
  `scripts/start-staging.sh`, with `PORTAL_DATA_DIR` pointing at
  `~/.claude/data/portal-staging`, a copy of production data. Refresh the copy
  with: `rsync -a --delete ~/.claude/data/portal/ ~/.claude/data/portal-staging/`
- Never run `npm run build` in the production checkout except as part of a
  deploy — it replaces `.next` under the live server and breaks the running
  app until restarted.
- To deploy: merge `staging` into `main` (fast-forward preferred), push both
  branches, then in the production checkout run:

```bash
npm run build && launchctl stop com.davebuckley.portal && launchctl start com.davebuckley.portal
```
