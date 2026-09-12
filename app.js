/* Exam schedule lookup — core logic + rendering.
   The pure functions at the top are exported for the Node test suite. */

(function (global) {
  "use strict";

  /* ---------- pure logic (tested in tools/test-lookup.js) ---------- */

  // Accepts "b23me1004", "B23 ME 1004", "b23-me-1004" and so on.
  function normaliseRoll(input) {
    return String(input || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  }

  const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const MONTHS = ["January", "February", "March", "April", "May", "June",
                  "July", "August", "September", "October", "November", "December"];

  // Parse "YYYY-MM-DD" as a local date, avoiding the UTC shift of new Date(str).
  function parseDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso).trim());
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d.getTime()) ? null : d;
  }

  function to12Hour(hhmm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim());
    if (!m) return String(hhmm);
    let h = Number(m[1]);
    const suffix = h < 12 ? "am" : "pm";
    if (h === 0) h = 12;
    else if (h > 12) h -= 12;
    return h + "." + m[2] + " " + suffix;
  }

  /* "X 105", "X 106", "Y 12" -> "X 105, 106 and Y 12".
     Rooms in one building repeat its name, which is unreadable once a paper
     spreads over a dozen rooms. */
  function summariseRooms(rooms) {
    const order = [];
    const byBuilding = {};
    rooms.forEach(function (room) {
      const at = room.lastIndexOf(" ");
      const building = at === -1 ? room : room.slice(0, at);
      const number = at === -1 ? "" : room.slice(at + 1);
      if (!byBuilding[building]) { byBuilding[building] = []; order.push(building); }
      if (number) byBuilding[building].push(number);
    });
    const parts = order.map(function (building) {
      const numbers = byBuilding[building];
      return numbers.length ? building + " " + numbers.join(", ") : building;
    });
    if (parts.length <= 1) return parts.join("");
    return parts.slice(0, -1).join("; ") + " and " + parts[parts.length - 1];
  }

  // The sheet gives literal start/end times rather than a slot code, so the
  // sitting is named from the hour it begins.
  function slotLabel(start) {
    const hour = Number(String(start).slice(0, 2));
    if (hour < 12) return "Morning";
    if (hour < 16) return "Afternoon";
    return "Evening";
  }

  function daysBetween(from, to) {
    const a = new Date(from.getFullYear(), from.getMonth(), from.getDate());
    const b = new Date(to.getFullYear(), to.getMonth(), to.getDate());
    return Math.round((b - a) / 86400000);
  }

  /* Resolve a roll number into a fully joined, chronologically sorted schedule.
     Returns { found:false, roll } or { found:true, roll, name, programme, exams:[...] }.
     Any exam whose course code is missing from the datesheet is reported in
     `unresolved` rather than silently dropped. */
  function lookup(data, rawRoll) {
    const roll = normaliseRoll(rawRoll);
    if (!roll) return { found: false, roll: "", reason: "empty" };

    const student = data.students[roll];
    if (!student) return { found: false, roll: roll, reason: "unknown" };

    const unresolved = [];
    const exams = [];

    student.exams.forEach(function (entry) {
      const course = data.courses[entry.course];
      if (!course) { unresolved.push(entry.course); return; }

      const date = parseDate(course.date);
      // The venue sheet allocates rooms per course, not per student, so a
      // paper can list several rooms and the student has to check the notice
      // on the door. One room is the common case.
      const rooms = Array.isArray(entry.venue) ? entry.venue
                  : (entry.venue ? [entry.venue] : []);
      // Meeting links are not published; see tools/convert.py.
      const isOnline = !!entry.online;

      exams.push({
        code: course.code,
        title: course.title,
        isoDate: course.date,
        date: date,
        start: course.start,
        end: course.end,
        slotLabel: slotLabel(course.start),
        rooms: rooms,
        venue: rooms.length ? summariseRooms(rooms)
             : (isOnline ? "Online exam" : "To be announced"),
        isOnline: isOnline
      });
    });

    // Sort by date, then forenoon before afternoon on the same day.
    exams.sort(function (a, b) {
      if (a.isoDate !== b.isoDate) return a.isoDate < b.isoDate ? -1 : 1;
      return (a.start || "") < (b.start || "") ? -1 : 1;
    });

    // Flag same-day clashes — two papers in the same slot on the same day.
    exams.forEach(function (e, i) {
      const prev = exams[i - 1];
      e.clash = !!(prev && prev.isoDate === e.isoDate && prev.start === e.start);
      if (e.clash) prev.clash = true;
    });

    return {
      found: true,
      roll: roll,
      name: student.name,
      programme: student.programme,
      exams: exams,
      unresolved: unresolved
    };
  }

  const core = {
    normaliseRoll: normaliseRoll,
    parseDate: parseDate,
    to12Hour: to12Hour,
    slotLabel: slotLabel,
    summariseRooms: summariseRooms,
    daysBetween: daysBetween,
    lookup: lookup,
    DAYS: DAYS,
    MONTHS: MONTHS
  };

  if (typeof module === "object" && module.exports) { module.exports = core; }
  global.ExamCore = core;

  /* ---------- rendering (browser only) ---------- */

  if (typeof document === "undefined") return;

  document.addEventListener("DOMContentLoaded", function () {
    const data = global.EXAM_DATA;
    const form = document.getElementById("lookup");
    const input = document.getElementById("roll");
    const results = document.getElementById("results");
    const termLabel = document.getElementById("term");

    if (termLabel && data && data.meta) termLabel.textContent = data.meta.term;
    const banner = document.getElementById("mock-warning");
    if (banner && data && data.meta) {
      if (data.meta.isMock) {
        banner.textContent = "Showing sample data. The real datesheet has not been loaded yet.";
        banner.hidden = false;
      } else if (data.meta.hasVenues === false) {
        banner.textContent = "Dates and times are from the official datesheet. " +
          "Room allocations have not been published to this site yet, so offline " +
          "papers show “To be announced”.";
        banner.hidden = false;
      } else {
        banner.textContent = "Rooms are allocated per course, not per student, " +
          "so a paper may list more than one room. Confirm yours on the seating " +
          "list posted at the venue.";
        banner.hidden = false;
      }
    }

    const today = new Date();

    function el(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }

    function renderCountdown(exam) {
      const diff = daysBetween(today, exam.date);
      if (diff < 0) return { text: "Completed", state: "past" };
      if (diff === 0) return { text: "Today", state: "now" };
      if (diff === 1) return { text: "Tomorrow", state: "soon" };
      if (diff <= 7) return { text: "In " + diff + " days", state: "soon" };
      return { text: "In " + diff + " days", state: "later" };
    }

    function renderExam(exam) {
      const countdown = renderCountdown(exam);
      const row = el("article", "exam exam--" + countdown.state + (exam.clash ? " exam--clash" : ""));

      const when = el("div", "exam__when");
      when.appendChild(el("span", "exam__weekday", DAYS[exam.date.getDay()]));
      when.appendChild(el("span", "exam__daynum", String(exam.date.getDate())));
      when.appendChild(el("span", "exam__month", MONTHS[exam.date.getMonth()].slice(0, 3)));
      row.appendChild(when);

      const body = el("div", "exam__body");
      body.appendChild(el("h3", "exam__title", exam.title));

      const meta = el("p", "exam__meta");
      meta.appendChild(el("span", "exam__code", exam.code));
      meta.appendChild(el("span", "exam__time",
        to12Hour(exam.start) + " to " + to12Hour(exam.end) + ", " + exam.slotLabel));
      body.appendChild(meta);

      const place = el("p", "exam__place");
      place.appendChild(el("strong", null, exam.venue));
      if (exam.isOnline) {
        place.appendChild(el("span", "exam__seat",
          "The examination cell emails your meeting link"));
      } else if (exam.rooms.length > 1) {
        place.appendChild(el("span", "exam__seat",
          "Check the seating list on the door for your room"));
      }
      body.appendChild(place);

      if (exam.clash) {
        body.appendChild(el("p", "exam__flag",
          "Two papers fall in this slot. Contact the examination cell."));
      }
      row.appendChild(body);
      row.appendChild(el("div", "exam__countdown", countdown.text));
      return row;
    }

    function render(result) {
      results.innerHTML = "";

      if (!result.found) {
        const empty = el("div", "notice");
        if (result.reason === "empty") {
          empty.appendChild(el("p", null, "Type a roll number to see your schedule."));
        } else {
          empty.appendChild(el("p", null, "No schedule found for " + result.roll + "."));
          empty.appendChild(el("p", "notice__hint",
            "Check the roll number against your ID card. If it is correct and still missing, the examination cell has not listed it yet."));
        }
        results.appendChild(empty);
        return;
      }

      const head = el("header", "student");
      head.appendChild(el("h2", "student__name", result.name));
      const sub = el("p", "student__meta");
      sub.appendChild(el("span", "student__roll", result.roll));
      sub.appendChild(el("span", null, result.programme));
      head.appendChild(sub);
      results.appendChild(head);

      if (!result.exams.length) {
        results.appendChild(el("div", "notice", "No papers are scheduled for this roll number."));
        return;
      }

      const count = result.exams.length;
      const first = result.exams[0];
      const last = result.exams[count - 1];
      function dayMonth(exam) {
        return exam.date.getDate() + " " + MONTHS[exam.date.getMonth()];
      }
      results.appendChild(el("p", "student__count",
        count + (count === 1 ? " paper, " : " papers, ") + dayMonth(first) +
        (first.isoDate === last.isoDate ? "" : " to " + dayMonth(last))));

      const list = el("div", "exams");
      result.exams.forEach(function (exam) { list.appendChild(renderExam(exam)); });
      results.appendChild(list);

      if (result.unresolved.length) {
        results.appendChild(el("p", "notice notice--warn",
          "Not shown, missing from the datesheet: " + result.unresolved.join(", ")));
      }
    }

    function run() {
      const result = lookup(data, input.value);
      render(result);
      if (result.found) {
        // Throws on file:// and in sandboxed frames; the page works regardless.
        try { history.replaceState(null, "", "#" + result.roll); } catch (e) {}
        document.title = result.roll + " — Exam schedule";
      }
    }

    form.addEventListener("submit", function (e) { e.preventDefault(); run(); });

    let timer = null;
    input.addEventListener("input", function () {
      clearTimeout(timer);
      timer = setTimeout(run, 150);
    });

    // Allow linking straight to a roll number: page.html#B23ME1004
    function fromHash() {
      if (location.hash.length <= 1) return false;
      const roll = normaliseRoll(decodeURIComponent(location.hash.slice(1)));
      if (roll === normaliseRoll(input.value) && results.children.length) return true;
      input.value = roll;
      run();
      return true;
    }

    // Changing only the fragment does not reload the page, so a shared or
    // edited #ROLL link has to be picked up here or the previous student's
    // schedule stays on screen.
    window.addEventListener("hashchange", fromHash);

    if (!fromHash()) input.focus();
  });
})(typeof window !== "undefined" ? window : globalThis);
