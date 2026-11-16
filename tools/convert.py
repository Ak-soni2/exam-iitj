#!/usr/bin/env python3
"""
Build data.js from the examination cell's student mapping and venue workbooks.

    python tools/convert.py "Student Mapping ....xlsx" "5. Exam Venue ....xlsx"

The mapping workbook has one row per student-paper, on one or more sheets:

    Date | Time | Roll No | Student Name | Email | Course Code | Course Name |
    Course Type | Slot | Instructor 1 | ... | Department | Program | ...

It carries no room column, so rooms come from the venue workbook (see
tools/venues.py), which maps each (date, session, course) to the rooms it uses. Online
and executive sheets instead supply a Google Meet Link, used as the venue for
those papers. Papers with neither show "To be announced".
"""

import json
import re
import sys
from collections import defaultdict
from datetime import datetime

import openpyxl

import venues as venue_sheet

TERM = "Major Examinations, Semester I, 2026-27"

TIME_RE = re.compile(
    r"^(\d{1,2}):(\d{2})\s*(AM|PM)\s*TO\s*(\d{1,2}):(\d{2})\s*(AM|PM)$")

# Exams run between these hours; used to spot AM/PM typos in the sheet.
EARLIEST_START, LATEST_END = 7, 22


def norm_roll(value):
    return re.sub(r"[^A-Z0-9]", "", str(value or "").upper())


def to24(hour, meridiem):
    if meridiem == "AM":
        return 0 if hour == 12 else hour
    return 12 if hour == 12 else hour + 12


def parse_time_range(value):
    """'08:00 AM to 10:00 AM' -> ('08:00', '10:00', [fixes]).

    The sheet contains AM/PM typos ('10:30 PM to 12:30 PM' for a morning
    paper), so obviously impossible times are corrected rather than trusted.
    Returns (None, None, reason) if the text cannot be read at all.
    """
    text = re.sub(r"\s+", " ", str(value or "").strip().upper())
    # Tolerate a missing space before the second time: '08:00 AM to10:00 AM'.
    text = re.sub(r"TO", " TO ", text)
    text = re.sub(r"\s+", " ", text).strip()

    m = TIME_RE.match(text)
    if not m:
        return None, None, "unreadable time %r" % value

    start = to24(int(m.group(1)), m.group(3))
    end = to24(int(m.group(4)), m.group(6))
    smin, emin = m.group(2), m.group(5)
    fixes = []

    # A start after the last exam hour is a PM-for-AM typo.
    if start > LATEST_END - 2:
        start -= 12
        fixes.append("start %s->AM" % m.group(3))
    # An end at or before the start is an AM-for-PM typo.
    if end <= start:
        end += 12
        fixes.append("end %s->PM" % m.group(6))
    if end <= start or start < EARLIEST_START or end > LATEST_END:
        return None, None, "implausible time %r" % value

    return "%02d:%s" % (start, smin), "%02d:%s" % (end, emin), fixes


def parse_date(value):
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d")
    raw = str(value or "").strip()
    if not raw:
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y",
                "%d.%m.%Y", "%d %b %Y", "%d %B %Y", "%b %d, %Y"):
        try:
            return datetime.strptime(raw, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


def clean(value):
    return re.sub(r"\s+", " ", str(value or "").strip())


def tidy_programme(programme, department):
    """'[B.TECH] Civil and Infrastructure...' -> 'B.Tech Civil and ...'."""
    text = clean(programme)
    m = re.match(r"^\[([^\]]+)\]\s*(.*)$", text)
    if m:
        degree, rest = m.group(1).strip(), m.group(2).strip()
        degree = {"B.TECH": "B.Tech", "M.TECH": "M.Tech", "PHD": "PhD",
                  "M.SC": "M.Sc", "MBA": "MBA"}.get(
                      degree.upper().rstrip("."), degree.title())
        text = (degree + " " + rest).strip()
    return text or clean(department)


def is_superseded(title):
    return title.strip().lower().startswith("old")


def is_not_exam(title):
    return re.sub(r"\s+", " ", title.strip().lower()) == "not exam"


def sheet_rows(ws, problems):
    """Yield (row, cell, line) for each non-blank data row of a sheet."""
    rows = list(ws.iter_rows(values_only=True))
    # Sheets carry a title banner above the header; find the real header.
    header_at = None
    for i, row in enumerate(rows[:10]):
        cells = [clean(c).lower() for c in row]
        if "roll no" in cells and "course code" in cells:
            header_at = i
            break
    if header_at is None:
        problems.append("sheet %r: no header row found; skipped" % ws.title)
        return

    header = [clean(c) for c in rows[header_at]]
    idx = {h: i for i, h in enumerate(header) if h}
    missing = [c for c in ("Date", "Time", "Roll No", "Course Code")
               if c not in idx]
    if missing:
        problems.append("sheet %r: missing columns %s; skipped"
                        % (ws.title, ", ".join(missing)))
        return

    def cell(row, name):
        i = idx.get(name)
        return row[i] if i is not None and i < len(row) else None

    for line, row in enumerate(rows[header_at + 1:], header_at + 2):
        # Blank rows appear in the middle of the data, not just at the end.
        if any(c is not None and str(c).strip() for c in row):
            yield row, cell, line


def main():
    if len(sys.argv) not in (2, 3):
        sys.exit(__doc__)
    workbook_path = sys.argv[1]
    venue_path = sys.argv[2] if len(sys.argv) == 3 else None

    rooms = {}
    if venue_path:
        rooms, venue_problems = venue_sheet.load(venue_path)
        print("Venue workbook: %d (date, course) room mappings." % len(rooms))
        for problem in venue_problems:
            print("  " + problem)
    else:
        print("No venue workbook given; offline papers show 'To be announced'.")

    wb = openpyxl.load_workbook(workbook_path, read_only=True, data_only=True)

    courses = {}       # exam key -> {code, title, date, start, end}
    students = {}
    problems = []
    time_fixes = defaultdict(int)
    seen = set()       # (roll, exam key) to drop duplicate registrations
    rows_read = 0

    # The workbook revised on 16 Nov 2026 splits the old online/executive sheet
    # into "New Online Exams ..." (still online) and "Offline Exams" (moved to
    # an offline paper, with Date and Time left blank), and adds "Not Exam"
    # (registrations with no major exam). The superseded "Old-..." sheet is
    # not read as papers; it only supplies the date and time that the
    # "Offline Exams" rows leave blank.
    superseded = [ws for ws in wb.worksheets if is_superseded(ws.title)]
    current = [ws for ws in wb.worksheets
               if not is_superseded(ws.title) and not is_not_exam(ws.title)]
    for ws in wb.worksheets:
        if is_not_exam(ws.title):
            print("Sheet %r skipped: courses with no major exam." % ws.title)

    fallback = {}      # (roll, code) -> (date, time) from superseded sheets
    for ws in superseded:
        for row, cell, line in sheet_rows(ws, problems):
            roll = norm_roll(cell(row, "Roll No"))
            code = clean(cell(row, "Course Code")).upper()
            if roll and code and parse_date(cell(row, "Date")):
                fallback[(roll, code)] = (cell(row, "Date"), cell(row, "Time"))
    covered = set()    # (roll, code) seen in a current sheet
    filled = 0

    for ws in current:
        online_sheet = "online" in ws.title.lower()
        for row, cell, line in sheet_rows(ws, problems):
            rows_read += 1

            roll = norm_roll(cell(row, "Roll No"))
            code = clean(cell(row, "Course Code")).upper()
            if not roll or not code:
                problems.append("%s row %d: missing roll number or course code"
                                % (ws.title, line))
                continue
            covered.add((roll, code))

            date_value, time_value = cell(row, "Date"), cell(row, "Time")
            if not clean(date_value) and not clean(time_value)                     and (roll, code) in fallback:
                date_value, time_value = fallback[(roll, code)]
                filled += 1

            iso = parse_date(date_value)
            if not iso:
                problems.append("%s row %d: unreadable date %r"
                                % (ws.title, line, date_value))
                continue

            start, end, fixes = parse_time_range(time_value)
            if start is None:
                problems.append("%s row %d: %s" % (ws.title, line, fixes))
                continue
            for fix in fixes:
                time_fixes[fix] += 1

            # A course can sit twice for different groups, so the exam identity
            # is the course *and* its sitting, not the course code alone.
            key = "%s@%s@%s" % (code, iso, start)
            courses.setdefault(key, {
                "code": code,
                "title": clean(cell(row, "Course Name")) or code,
                "date": iso,
                "start": start,
                "end": end,
            })

            if (roll, key) in seen:
                continue
            seen.add((roll, key))

            record = students.setdefault(roll, {
                "name": clean(cell(row, "Student Name")) or roll,
                "programme": tidy_programme(cell(row, "Program"),
                                            cell(row, "Department")),
                "exams": [],
            })

            # Online papers carry a Google Meet link, or sit on an online
            # sheet. The link is deliberately NOT published: the whole dataset
            # ships to every visitor, and a public meeting link is a joinable
            # exam room. Students get the link by email from the examination
            # cell instead.
            online = online_sheet or bool(clean(cell(row, "Google Meet Link")))

            # The venue sheet lists rooms per course, not per student, so a
            # course split over several rooms yields every candidate room. An
            # online student shares the sitting with offline students of the
            # same course, but not their room.
            where = [] if online else list(
                rooms.get((iso, start, code)) or rooms.get((iso, "", code), []))

            entry = {"course": key, "venue": where}
            if online:
                entry["online"] = True
            record["exams"].append(entry)

    orphans = sorted(k for k in fallback if k not in covered)
    for roll, code in orphans:
        problems.append("superseded sheet: %s %s is on no current sheet; "
                        "dropped" % (roll, code))

    online_papers = sum(1 for s in students.values()
                        for e in s["exams"] if e.get("online"))
    missing_venue = sum(1 for s in students.values()
                        for e in s["exams"]
                        if not e["venue"] and not e.get("online"))
    split_venue = sum(1 for s in students.values()
                      for e in s["exams"] if len(e["venue"]) > 1)

    payload = {
        "meta": {
            "term": TERM,
            "source": "Generated from %s"
                      % workbook_path.replace("\\", "/").split("/")[-1],
            "generated": datetime.now().strftime("%Y-%m-%d"),
            "isMock": False,
            "hasVenues": bool(venue_path),
        },
        "courses": courses,
        "students": students,
    }

    with open("data.js", "w", encoding="utf-8") as fh:
        fh.write("/* Generated by tools/convert.py - do not edit by hand. */\n")
        fh.write("window.EXAM_DATA = ")
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"),
                  sort_keys=True)
        fh.write(";\n")

    print("\nRead %d rows. Wrote data.js: %d students, %d exam sittings."
          % (rows_read, len(students), len(courses)))
    if filled:
        print("Filled blank date and time for %d rows from the superseded "
              "sheet." % filled)
    if time_fixes:
        print("Corrected AM/PM typos in the sheet:")
        for fix, n in sorted(time_fixes.items()):
            print("  %s  (%d rows)" % (fix, n))
    if online_papers:
        print("%d student-papers are online; they show 'Online exam'."
              % online_papers)
    if missing_venue:
        print("%d student-papers have no venue; they show 'To be announced'."
              % missing_venue)
    if split_venue:
        print("%d student-papers sit in a course split over several rooms; "
              "every candidate room is shown." % split_venue)
    if problems:
        print("\n%d problems found in the source workbook:" % len(problems))
        for p in problems[:40]:
            print("  " + p)
        if len(problems) > 40:
            print("  ...and %d more." % (len(problems) - 40))
    else:
        print("No problems found in the source workbook.")


if __name__ == "__main__":
    main()
