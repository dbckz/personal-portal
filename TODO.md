# TODO

## Open

- Exercise midnight rollover (28 Aug 2026): a workout in progress when the
  clock passes midnight vanishes from the Today view, which flips to the new
  date's plan mid-session. The Today tab (desktop and mobile) should keep
  showing an unfinished started session from "yesterday" until it is completed
  or abandoned — e.g. resolve "today" to the most recent date with an
  incomplete started session within the last ~6 hours, or offer a "finish
  yesterday's session" banner.

- Muscle map → plan generation (26 Aug 2026): feed the per-muscle planned/done
  loads (`src/lib/exercise-muscles.ts`, `/api/exercise/muscles`) into
  programme generation so the plan self-adjusts to hit all muscle groups
  consistently — bias next week's exercise selection toward under-hit groups
  (traps currently 0 sets/wk; forearms and calves light), let consistently
  over-hit groups yield accessory slots. Respect existing constraints (legs
  stay off Fri/Sun, runs pinned Tue/Thu/Sat).

- Exercise plan handover (agreed 9 Aug 2026): the calendar is the source of
  truth for sessions until the authored plan ends on 3 Sep 2026. From then the
  PORTAL takes over defining future sessions (from the weekly routine + the
  progression data) and writes them to the calendar, descriptions included.
  Build this before 3 Sep.

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
- Mobile Board placement: exposed as a segmented "Timeline | Board" toggle at
  the top of the Day tab (not a 7th tab bar entry). Reasoning: seven tabs at
  ~360px give ~51px per tab, below the ~60px the existing single-word labels
  ("Reminders", "Wellbeing") already use without wrapping/ellipsis, so a 7th tab
  risks clipping them. The toggle keeps the tab bar intact and sits the weekly
  board next to the day's planning. `dayMode` state lives in MobileShell; the
  coloured header's day-nav is hidden in board mode.

- Hash deep links (`#work/board`, `#work/rituals`, …) hydrate with a React #418
  mismatch because `page.tsx` reads `window.location.hash` in the `useState`
  initialiser; React recovers client-side, but a `useEffect`-applied initial
  route would remove the console error. Pre-existing; noted 22 Aug 2026.
