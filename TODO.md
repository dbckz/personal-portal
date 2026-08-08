# TODO

## Open

- Music section: define what it should actually contain beyond goals. It is a
  goals-only shell until those specifics land.
- Mobile: Goals and Exercise are on the phone view as read-only tabs. The Music
  section and the reflection/planning sessions are desktop-only by design —
  worth revisiting only if a read-only music view earns its place.
- Exercise-name equivalences live in an ALIASES map in
  `src/lib/exercise-progression.ts`. There is deliberately no rule that
  strips equipment words — equipment is usually the distinction (dumbbell vs
  cable, bar vs cable pulldown). Add confirmed equivalences one line at a
  time. Currently: Paloff press ± "with cable", Treadmill = Treadmill run,
  Rear delt machine = Reverse pec deck machine.
- Projects tab (Work → Projects) scans `working_dir/github/dbckz` only. The
  `openmined/` and `openclaw/` trees are excluded deliberately — day-job work
  with its own tracking. Revisit if that turns out to be the wrong call.
- Projects is desktop-only. The mobile shell already carries five tabs, and a
  read-only repo list is weak justification for a sixth; the parity rule in
  CLAUDE.md is deliberately not applied here.

## Implemented 2026-08-08

- Week-planning rituals: daily 🚶 Walk (45m, break-type, mid-morning) plus
  weekly 💼 Consulting, 🛠️ Side projects, 🎰 New bookies, 📖 Reading and
  🎓 Learning singles, spread across distinct days. Joins the earlier daily
  Kindle notes, weekly backlog grooming and weekly retrospective rituals.
- Calibrated quota suggestions + retro→planning feedback loop:
  `src/lib/quota-calibration.ts` computes per-category completion rates over
  the last 8 complete weeks and suggests quota adjustments; surfaced as
  informational lines in the plan wizard's tasks step (needs ≥3 weeks of data).
- Estimate-vs-actual per task: `scheduledMinutes` is recorded on each weekly
  task outcome at scheduling-confirm time (grouped blocks split evenly); block
  sizing hints ("done tasks here usually got 60m") appear in the wizard once a
  category has ≥5 terminal samples.
- Goal evidence sources: Asana tags are now pickable in the goal editor
  (aggregated across workspaces, workspace stored on the evidence), and the
  calendar-category field is a datalist of categories actually in use (free
  text still accepted).
- Exercise: timed calendar events ("🏋️ Gym", "🏃 Track") now set real
  durations on the matching imported sessions (all-day events remain the only
  plan source; hand-logged durations are never overwritten).
- Exercise: explicit RIR effort rating (0–4+ chips) on entries, mobile and
  desktop; an explicit rating overrides prose-note parsing in the target
  recommender, making it decisive without a note.
- Reflection reminder: month/quarter-end browser nudge mirroring the weekly
  review nudge (once per period, 17:00+ working days, suppressed once the
  reflection is done).
