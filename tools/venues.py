"""Read the examination cell's venue workbook.

    5. Exam Venue (Minor, SI, 26-27).xlsx
    6. Exam Venue (Major, SI, 26-27).xlsx

One sheet per exam day. Each sheet lists, per room, which course sits there:

    Department | Class Room | Course Code | Course Name | No. of Students | ...

Quirks in the source that this module handles:

  * The major workbook stacks a morning, an afternoon and an evening session
    on one sheet, each under its own banner and header ("Date: 20 November
    2026     Time: 02:00 PM to 05:00 PM"). A course code can sit in more than
    one session on the same day, so rooms are keyed by the session's start
    time as well as the date.

  * 'Department' is really the *building*, and it is a merged cell: it appears
    once at the top of a block and applies to every row beneath it.
  * A blank 'Class Room' means the course shares the room of the row above.
  * The header row repeats part-way down a sheet and must be skipped.

The sheet has no roll numbers: a course split across several rooms gives no
way to tell which student sits where. So a (date, start time, course) maps to
the *list* of rooms it uses, and the site shows all of them when there is
more than one.
"""

import re
from collections import defaultdict
from datetime import datetime

import openpyxl

# 'Department' holds a building name; tidy the ones that read badly as a venue.
BUILDING_FIXES = {
    "Bioscience and Bioengineering Department": "Bioscience and Bioengineering",
    "School of Management and Entrepreneurship\n(SME)":
        "School of Management and Entrepreneurship (SME)",
}


def clean(value):
    return re.sub(r"\s+", " ", str(value or "").strip())


def room_number(value):
    """Rooms arrive as floats: 101.0 -> '101'."""
    text = clean(value)
    return text[:-2] if re.match(r"^\d+\.0$", text) else text


SESSION_RE = re.compile(
    r"Date:\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4}).*?Time:\s*(\d{1,2}):(\d{2})\s*(AM|PM)",
    re.I)


# No exam starts before this hour; an earlier start is an AM-for-PM typo
# (the 19 Nov evening banner reads '06:00 AM to 09:00 PM').
EARLIEST_START = 7


def session_banner(text):
    """'Date: 20 November 2026     Time: 02:00 PM to 05:00 PM'
    -> ('2026-11-20', '14:00'), or None if the text is not a session banner."""
    m = SESSION_RE.search(clean(text))
    if not m:
        return None
    iso = sheet_date(m.group(1))
    hour = int(m.group(2)) % 12 + (12 if m.group(4).upper() == "PM" else 0)
    if hour < EARLIEST_START:
        hour += 12
    return iso, "%02d:%s" % (hour, m.group(3))


def sheet_date(title):
    """'15 Sep 2026 (Tuesday)' -> '2026-09-15'."""
    m = re.match(r"^\s*(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})", title)
    if not m:
        return None
    for fmt in ("%d %b %Y", "%d %B %Y"):
        try:
            return datetime.strptime(" ".join(m.groups()), fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


def load(path):
    """Return ({(date, start, course code): [rooms]}, [problems]).

    `start` is the session's 'HH:MM' start, or '' for a sheet that does not
    state one (one session per sheet, as in the minor workbook).
    """
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    rooms = defaultdict(list)
    problems = []

    for ws in wb.worksheets:
        sheet_iso = sheet_date(ws.title)
        if not sheet_iso:
            problems.append("venue sheet %r: cannot read a date from its name"
                            % ws.title)
            continue

        iso, start = sheet_iso, ""
        idx = None          # column positions; None until a header row is seen
        width = 0
        building, room = "", ""
        sessions = 0

        for row in ws.iter_rows(values_only=True):
            cells = [clean(c) for c in row]
            filled = [c for c in cells if c]

            # A banner starts a new session; everything below it belongs to
            # that session until the next banner, and the building and room
            # carried down from the previous block no longer apply.
            banner = next((session_banner(c) for c in cells if c), None)
            if banner:
                iso, start = banner
                if iso != sheet_iso:
                    problems.append("venue sheet %r: banner says %s"
                                    % (ws.title, iso))
                idx, building, room = None, "", ""
                sessions += 1
                continue
            if len(filled) == 1 and re.search(r"examination", cells[0], re.I):
                # Title line such as 'Major Examination, Semester - I'. A lone
                # building name is not one: it sets the building for the rows
                # beneath it, like any other 'Department' cell.
                idx, building, room = None, "", ""
                continue

            if "Course Code" in cells and "Class Room" in cells:
                idx = {name: cells.index(name)
                       for name in ("Department", "Class Room", "Course Code")
                       if name in cells}
                if len(idx) < 3:
                    problems.append("venue sheet %r: missing a needed column"
                                    % ws.title)
                    idx = None
                width = len(cells)
                continue
            if idx is None:
                continue

            row = list(row) + [""] * (width - len(row))
            dept = clean(row[idx["Department"]])
            here = room_number(row[idx["Class Room"]])
            code = clean(row[idx["Course Code"]]).upper()

            # The header repeats part-way down the sheet.
            if dept == "Department" or code == "COURSE CODE":
                continue
            # Merged building cell: only the first row of a block carries it.
            if dept:
                building = BUILDING_FIXES.get(dept, dept)
            # A blank room means 'same room as the row above'.
            if here:
                room = here
            if not code or not building or not room:
                continue

            where = "%s %s" % (building, room)
            if where not in rooms[(iso, start, code)]:
                rooms[(iso, start, code)].append(where)

        if not sessions and idx is None and not any(k[0] == sheet_iso
                                                      for k in rooms):
            problems.append("venue sheet %r: no header row found" % ws.title)

    return dict(rooms), problems
