"""Read the examination cell's venue workbook.

    5. Exam Venue (Minor, SI, 26-27).xlsx

One sheet per exam day. Each sheet lists, per room, which course sits there:

    Department | Class Room | Course Code | Course Name | No. of Students | ...

Three quirks in the source that this module handles:

  * 'Department' is really the *building*, and it is a merged cell: it appears
    once at the top of a block and applies to every row beneath it.
  * A blank 'Class Room' means the course shares the room of the row above.
  * The header row repeats part-way down a sheet and must be skipped.

The sheet has no roll numbers: a course split across several rooms gives no
way to tell which student sits where. So a (date, course) maps to the *list*
of rooms it uses, and the site shows all of them when there is more than one.
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
    """Return ({(date, course code): [rooms]}, [problems])."""
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    rooms = defaultdict(list)
    problems = []

    for ws in wb.worksheets:
        iso = sheet_date(ws.title)
        if not iso:
            problems.append("venue sheet %r: cannot read a date from its name"
                            % ws.title)
            continue

        rows = list(ws.iter_rows(values_only=True))
        header_at = None
        for i, row in enumerate(rows[:8]):
            cells = [clean(c) for c in row]
            if "Course Code" in cells and "Class Room" in cells:
                header_at = i
                break
        if header_at is None:
            problems.append("venue sheet %r: no header row found" % ws.title)
            continue

        header = [clean(c) for c in rows[header_at]]
        idx = {name: header.index(name)
               for name in ("Department", "Class Room", "Course Code")
               if name in header}
        if len(idx) < 3:
            problems.append("venue sheet %r: missing a needed column" % ws.title)
            continue
        width = len(header)

        building, room = "", ""
        for row in rows[header_at + 1:]:
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
            if where not in rooms[(iso, code)]:
                rooms[(iso, code)].append(where)

    return dict(rooms), problems
