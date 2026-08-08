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

## Staging vs production

Dave uses the production app (`portal.localhost`) all day, so development must
never disturb it. **Do all development in the staging worktree, not here:**

- **Staging worktree**: `/Users/dave/working_dir/github/dbckz/personal-portal-staging`
  (branch `staging`), served at `portal-staging.localhost` (port 3002) by the
  launchd service `com.davebuckley.portal-staging` running `next dev` via
  `scripts/start-staging.sh`. It points `PORTAL_DATA_DIR` at
  `~/.claude/data/portal-staging`, a **copy** of production data — staging
  writes never touch real data. Refresh the copy with:
  `rsync -a --delete ~/.claude/data/portal/ ~/.claude/data/portal-staging/`
- Implement and test on the `staging` branch in that worktree. Never run
  `npm run build` in the production checkout during development — it replaces
  `.next` under the live server and breaks the running app.
- **Only when Dave explicitly says to deploy/build to production**: merge
  `staging` into `main` (fast-forward preferred), then in the production
  checkout run:

```bash
npm run build && launchctl stop com.davebuckley.portal && launchctl start com.davebuckley.portal
```

Push to the remote as part of deploying, per the usual commit flow.
