# Exam schedule lookup — IIT Jodhpur

A student types a roll number and gets their papers in date order, with
timings and room allocation. Static site: no backend, no build step, no
framework.

Loaded with the **Major Examinations, Semester I 2026-27** datesheet
(19–26 November 2026, no papers on 24 November): 4,125 students, 442 exam
sittings (mapping and venue workbooks as revised on 16 November 2026). The Minor datesheet it replaced is in git history.

## Running locally

    python -m http.server 8000

Then open <http://localhost:8000>. Opening `index.html` straight from disk
also works, since the data loads as a script rather than by `fetch`.

Appending a roll number to the URL opens that schedule directly:
`localhost:8000/#B22CH024`.

## Rebuilding the data

Both source workbooks live in this directory (they are gitignored — the
`.xlsx` files are the examination cell's, not ours to publish):

    python tools/convert.py \
      "Student Mapping for Major Examination ....xlsx" \
      "6. Exam Venue (Major, SI, 26-27).xlsx"

This rewrites `data.js`. The venue workbook is optional; without it every
offline paper shows "To be announced". Read the script's output before
deploying — it reports how many rows it read, and every row it could not.

### What the converter has to cope with

The source sheets are hand-maintained, so the converter corrects and reports
rather than trusting them:

* **Times are free text** (`08:00 AM to 10:00 AM`), not slot codes. It also
  sees `08:00 AM to10:00 AM` with the space missing.
* **1,791 AM/PM typos.** 1,790 rows say `10:30 PM to 12:30 PM` for a morning
  paper and one says `10:30 AM to 12:30 AM`. A start after 20:00 or an end
  before its start is corrected and counted in the run summary.
* **A course can sit twice** on different days for different groups, so an
  exam is keyed by course *and* sitting, never by course code alone.
* **The major venue sheet stacks three sessions per day** (morning,
  afternoon, evening), each under its own banner and header, and one banner
  reads `06:00 AM to 09:00 PM` for an evening session. Rooms are therefore
  keyed by (date, session start, course), and a start before 07:00 is read
  as PM.
* **Blank rows appear mid-sheet**, so reading cannot stop at the first one.
* **The 16 November revision splits the online sheet.** "New Online Exams
  16.11.2026" holds the papers still sat online; "Offline Exams" holds 141
  executive papers moved offline, with Date and Time left blank; "Not Exam"
  lists registrations with no major exam and is skipped. The superseded
  "Old-Online and Executive Students" sheet is not read as papers — it only
  fills the blank date and time on "Offline Exams" rows, and any of its rows
  that no current sheet covers are reported.
* **The venue sheet has no roll numbers.** It maps (date, course) to rooms,
  and the building is a merged cell that applies to the rows beneath it. A
  blank room means "same room as the row above", and the header repeats
  part-way down each sheet.

### Rooms are per course, not per student

This is the one real limitation, and the page says so. 370 of 430 course
sittings use a single room, which is an exact answer. The rest are split across rooms
by student count with no indication of who sits where, so the page lists every
candidate room and tells the student to check the seating list at the venue.
Fixing this properly needs a seating plan with roll numbers in it.

Papers on a sheet whose name contains "online", or with a meeting link, are
marked "Online exam" and never given a room (an online student shares a
sitting with the offline students of the same course, not their room). The
link itself is deliberately **not** published — see below. That is 1,218
papers; another 71 offline papers whose course has no row in the venue sheet
at that sitting show "To be announced".

## Tests

    node tools/test-lookup.js    # 38 tests: logic, joins, sorting, whole dataset
    node tools/test-render.js    # 20 tests: DOM output, failure states (npm i jsdom)

`test-lookup.js` validates the generated dataset itself, so run it after every
conversion. It walks all 4,125 students and fails if any references a missing
course, has an implausible exam hour, or has an unflagged same-slot collision.

It reports that **2 students have two papers in the same sitting**. That is
in the source datesheet, not a bug here; the page flags those rows in red and
tells the student to contact the examination cell.

## Deploying to Vercel

    npx vercel --prod

The project is `files` under the `ak-soni2` account (`vercel link` writes
`.vercel/`, which is gitignored). After a deploy, look up a student you know
and compare their papers with the datesheet.

## Deploying to GitHub Pages

    git add -A
    git commit -m "Exam schedule lookup"
    git push origin main

Then Settings → Pages → Source "Deploy from a branch", branch `main`, folder
`/ (root)`. The site appears at `https://<user>.github.io/exam-iitj/`.

## What is deliberately left out

`data.js` ships the whole dataset to every visitor, so anything in it is
public. Three things are therefore stripped during conversion and guarded by
tests that read `data.js` back and fail if they reappear:

* **Google Meet links.** A public meeting link is a joinable exam room. Online
  papers show "Online exam" and tell the student the examination cell emails
  the link.
* **Email addresses.** The source sheets carry student, instructor and proctor
  addresses. None are published.
* **Instructor and proctor names.** Not needed to answer "when is my exam".

The source `.xlsx` workbooks are excluded from both git (`.gitignore`) and the
Vercel deploy (`.vercelignore`), since they contain all of the above.

## Still public, and worth a decision

Names, roll numbers, programmes and rooms for all 4,125 students remain in
`data.js`, because the site cannot answer its one question without them.
Anyone with the URL can read every row, not just their own.

That is fine if this datesheet is already posted publicly by the institute.
If it is not, this design is the wrong one and you need a backend that returns
a single student per request, behind an institute login.

`vercel.json` sets `X-Robots-Tag: noindex` so the pages stay out of search
results. That is a politeness header, not access control.