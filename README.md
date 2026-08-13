# CND Austria — Volunteer & Task Planner

Shift planning for Cloud Native Days Austria: manage people, tasks and who works what,
assign manually, or let it suggest a balanced allocation for every open slot.

Replaces the `Event Tasks and Timetable` spreadsheet, whose per-person day columns were
formula-generated and broke on export. Here those columns are *derived*, so they cannot
go stale.

## Running it

Node 24 (see `.nvmrc`):

```bash
nvm use && npm install && npm run dev
```

| Script | What it does |
| --- | --- |
| `npm run dev` | Dev server |
| `npm run build` | Production build into `dist/` |
| `npm run typecheck` | `tsc` with no emit |
| `npm run selftest` | Headless checks for the scheduling core (50 assertions) |
| `npm run lint` | oxlint |
| `npm run promo` | Records `promo.mp4`, a ~70s walkthrough of the core features |

### Recording the promo

`npm run promo` needs the dev server already running, plus Chrome and `ffmpeg` on PATH. It
drives headless Chrome over the DevTools Protocol — no Puppeteer or Playwright; Node 24's
global `WebSocket` is enough — captures JPEG frames, and encodes them with ffmpeg at the
real elapsed frame timings, so UI transitions come out as genuine motion.

It runs in a **throwaway Chrome profile**, so recording never touches your own browser or
the plan stored in it. Volunteer names are replaced with invented ones and the import scene
uses a synthetic CSV: the video is shareable without exposing the real roster. Organizers
are kept, since they're already listed publicly on cloudnativedays.at/team.

`promo.mp4` is gitignored — regenerate it rather than committing 3.7 MB of binary.

## Where the data lives

**Entirely in your browser.** State is written to `localStorage` under `cnda-planner:v1`
on every edit and reloaded on start. There is no server, no account and no network call —
the app works offline.

**You do not need to export to keep your work.** The plan survives, with no action from you:

- page reloads
- closing the tab
- stopping and restarting the dev server
- quitting the browser
- rebooting the machine

Exporting is for *sharing and archiving*, not for saving.

### What does lose the plan

- **A different origin.** `localStorage` is scoped per origin, port included. This is why
  `vite.config.ts` pins port **5178** for both `dev` and `preview` — without that, Vite's
  defaults (5173 dev, 4173 preview) would each hold their own separate, empty plan and look
  exactly like data loss. Don't change the port once you have real data in it.
- **A different browser or profile**, including private/incognito windows, which are wiped
  on close.
- **Clearing browsing data** for the site.
- Safari additionally evicts script-writable storage for origins left untouched for seven
  days, so take a JSON backup if you plan there and won't open it for a week.

Take a **Backup** (`.json`) before anything risky — a big reshuffle, a task-sheet re-import,
or **Reset** — and drop the file back into **Import** to restore it. To hand the plan to
someone else, use **Export tasks** / **Export people** (CSV, opens directly in Excel and
Google Sheets) or send them the JSON backup.

### Personal data

The registration form collects address, date of birth and phone number. The importer
**drops those columns at the file boundary** — they are never stored, never rendered and
never leave the spreadsheet. Only name, available days and the multi-shift answer are read,
which is all the scheduler needs. The Import dialog lists exactly which columns it discarded.

## Importing

Drop the Google exports onto the Import dialog: `.xlsx` and `.csv` both work, parsed
in-browser.

Recognised automatically:

| Sheet looks like | Read as |
| --- | --- |
| `Day`, `Time`, `Task`, `Needed` | Tasks & timetable |
| `Timestamp` + `Name`, or "help on the following days" | Form registrations |
| `Volunteer Name` + `Organizer` + availability | People list |

Sheets named like leftovers (`Tasks (old)`, `… copy`, `… backup`) are detected but switched
**off** by default, as is any second sheet of a kind already being imported — so a workbook
with both a live and a stale Tasks sheet won't silently double up. Toggle any sheet on or off
in the dialog.

People are matched on normalised name, so re-importing an updated response sheet adds new
registrations and merges availability into existing entries instead of creating duplicates.

## Assignment rules

Hard constraints, never broken by the suggestion engine:

- Only on days the person is available
- No overlapping shifts (touching times like `12:30–17:00` and `17:00–18:00` are fine)
- Never more people than a task needs
- Pinned assignments are never moved
- Anyone who answered "No" to more than one shift gets exactly one

Soft constraints, weighted and scored:

- Balance the load — shift count first, hours as tie-break (configurable)
- Fill Registration, Room Help and Wildcard with volunteers before organizers
- Avoid giving one person the same Room Help role twice
- Honour per-person task preferences

Configurable in **Rules**:

- At most one *regular* shift per person per day
- All-hands tasks (Setup, Teardown, Logistics) don't count toward that daily limit, so they
  can stack on a regular shift when times don't overlap — matching how the spreadsheet
  actually worked
- Organizers exempt from the daily limit, since they're on site all day anyway

### How suggestions are produced

A randomised greedy pass, run 400 times, keeping the highest-scoring complete solution. One
greedy pass is fast but gets stuck; randomising the tie-breaks and taking the best of many
runs reliably finds fuller and flatter plans. Same seed always reproduces the same result;
**Reshuffle** draws a new one.

Suggestions arrive as a **reviewable diff** — accept all, uncheck individual rows, or
reshuffle. Accepted rows stay *unpinned*, so a later reshuffle can still improve them.
Anything you assign by hand is pinned automatically.

## Warnings, not walls

You can always override the engine. Assigning someone who would break a rule is allowed —
the picker shows the reason and lists them under "would break a rule — assign anyway". The
plan then flags it rather than silently accepting it:

- A red badge in the top bar with the live count of rule breaches and unfilled slots
- ⚠ against the affected person on every task card they appear on
- Understaffed and overstaffed tasks marked on the board
- **Warnings & Balance** lists every breach in words, plus per-person workload bars and the
  full per-person schedule

Over-committing someone by hand — more shifts than they signed up for, past their cap,
double-booked, or on a day they aren't available — is reported as an explicit breach.

## No runtime dependencies

React only. The XLSX reader is ~200 lines using the platform's own
`DecompressionStream('deflate-raw')` and `DOMParser` (`src/lib/xlsx.ts`).

SheetJS was deliberately not used: its npm releases have been frozen at `0.18.5` since 2022
after distribution moved to the vendor's own CDN, and that frozen version carries advisories
whose fixes exist only off-npm. Pulling a CDN tarball into the build to read two local files
wasn't a good trade.

## Layout

```
src/
  types.ts              Domain model, task categories, rule defaults
  lib/
    assign.ts           The allocator: hard constraints, scoring, best-of-N search
    plan.ts             Derived views — loads, coverage, conflict detection
    time.ts             "12:00-15:00" -> minutes, overlap tests
    xlsx.ts             Dependency-free XLSX + CSV reading, CSV writing
    importers.ts        Sheet -> domain mapping, PII filtering, name merging
    exporters.ts        CSV / JSON output
    seed.ts             CND Austria 2026 starting data
    storage.ts          localStorage persistence
    rng.ts              Seeded PRNG for reproducible suggestions
  components/           Board, People, Tasks, Warnings & Balance, dialogs
tests/selftest.ts       Headless checks for the core
```

## Seed data

Ships with CND Austria 2026 pre-loaded: 3 days (28–30 September), the 30-task template from
the spreadsheet, the 8 organizers from
[cloudnativedays.at/team](https://cloudnativedays.at/team), and the volunteers from the
registration responses. **Reset** returns to this. Organizer day-availability is a guess —
check it in **People**.
