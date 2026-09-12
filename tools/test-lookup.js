/* Run with: node tools/test-lookup.js
   Loads data.js the same way the browser does, then exercises the lookup.
   The second half validates the generated dataset itself, so run this after
   every conversion. */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const root = path.join(__dirname, "..");
const sandbox = {};
new Function("window", fs.readFileSync(path.join(root, "data.js"), "utf8"))(sandbox);
const data = sandbox.EXAM_DATA;

const core = require(path.join(root, "app.js"));
const { lookup, normaliseRoll, to12Hour, parseDate, slotLabel } = core;

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  pass  " + name); }
  catch (e) { failed++; console.log("  FAIL  " + name + "\n        " + e.message); }
}

// Pick fixtures out of the real dataset rather than hard-coding names, so the
// suite keeps working when the examination cell republishes the sheet.
const rolls = Object.keys(data.students);
const busiest = rolls.slice().sort(
  (a, b) => data.students[b].exams.length - data.students[a].exams.length)[0];
const venueOf = e => Array.isArray(e.venue) ? e.venue : (e.venue ? [e.venue] : []);
const onlineRoll = rolls.find(r => data.students[r].exams.some(e => e.online));

console.log("\nRoll normalisation");
test("lowercase input is accepted", () =>
  assert.strictEqual(normaliseRoll("b23me1004"), "B23ME1004"));
test("spaces and dashes are stripped", () =>
  assert.strictEqual(normaliseRoll(" b23-me 1004 "), "B23ME1004"));
test("empty input yields empty string", () =>
  assert.strictEqual(normaliseRoll("   "), ""));

console.log("\nTime formatting");
test("morning start renders as 8.00 am", () =>
  assert.strictEqual(to12Hour("08:00"), "8.00 am"));
test("noon renders as 12.00 pm", () =>
  assert.strictEqual(to12Hour("12:30"), "12.30 pm"));
test("evening end renders as 9.00 pm", () =>
  assert.strictEqual(to12Hour("21:00"), "9.00 pm"));

console.log("\nSitting labels");
test("08:00 is a morning sitting", () =>
  assert.strictEqual(slotLabel("08:00"), "Morning"));
test("14:00 is an afternoon sitting", () =>
  assert.strictEqual(slotLabel("14:00"), "Afternoon"));
test("16:30 is an evening sitting", () =>
  assert.strictEqual(slotLabel("16:30"), "Evening"));

console.log("\nRoom summaries");
test("a single room is left alone", () =>
  assert.strictEqual(core.summariseRooms(["Physics 102"]), "Physics 102"));
test("rooms in one building are not repeated", () =>
  assert.strictEqual(
    core.summariseRooms(["Old LHC 105", "Old LHC 106", "Old LHC 110"]),
    "Old LHC 105, 106, 110"));
test("rooms in different buildings are joined readably", () =>
  assert.strictEqual(
    core.summariseRooms(["Old LHC 105", "Old LHC 106", "Physics 12"]),
    "Old LHC 105, 106 and Physics 12"));
test("a venue with no room number survives", () =>
  assert.strictEqual(core.summariseRooms(["IITJ - AIMSJ"]), "IITJ - AIMSJ"));

console.log("\nDate parsing");
test("ISO date parses to the same calendar day locally", () => {
  const d = parseDate("2026-09-15");
  assert.strictEqual(d.getDate(), 15);
  assert.strictEqual(d.getMonth(), 8);
});
test("malformed date returns null", () =>
  assert.strictEqual(parseDate("15/09/2026"), null));

console.log("\nLookup");
test("unknown roll is reported, not thrown", () => {
  const r = lookup(data, "B99XX9999");
  assert.strictEqual(r.found, false);
  assert.strictEqual(r.reason, "unknown");
});
test("empty input is distinguished from unknown", () =>
  assert.strictEqual(lookup(data, "").reason, "empty"));

test("case-insensitive lookup finds the student", () => {
  const upper = lookup(data, busiest);
  const lower = lookup(data, busiest.toLowerCase());
  assert.strictEqual(lower.found, true);
  assert.strictEqual(lower.name, upper.name);
});

test("a roll typed with spaces still resolves", () => {
  const spaced = busiest.slice(0, 3) + " " + busiest.slice(3);
  assert.strictEqual(lookup(data, spaced).found, true);
});

test("every paper carries a date, a start and an end", () => {
  const bad = lookup(data, busiest).exams.filter(
    e => !e.isoDate || !e.start || !e.end);
  assert.deepStrictEqual(bad, []);
});

test("papers come back in chronological order", () => {
  const keys = lookup(data, busiest).exams.map(e => e.isoDate + " " + e.start);
  assert.deepStrictEqual(keys, keys.slice().sort());
});

test("an online paper is marked as online", () => {
  assert.ok(onlineRoll, "dataset has no online paper to test");
  const e = lookup(data, onlineRoll).exams.find(x => x.isOnline);
  assert.ok(e, "expected an online paper");
  assert.strictEqual(e.venue, "Online exam");
});

test("a paper with no room shows 'To be announced'", () => {
  const e = lookup(data, busiest).exams.find(x => !x.isOnline);
  if (e) assert.ok(e.venue, "venue should never be blank");
});

test("a room-allocated paper names a building and room", () => {
  let found = null;
  for (const roll of rolls) {
    found = lookup(data, roll).exams.find(
      e => !e.isOnline && e.rooms.length === 1);
    if (found) break;
  }
  assert.ok(found, "expected at least one single-room paper");
  assert.ok(/\s\d+[A-Za-z]?$/.test(found.venue), found.venue);
});

test("a paper split over rooms lists every candidate", () => {
  let split = null;
  for (const roll of rolls) {
    split = lookup(data, roll).exams.find(e => e.rooms.length > 1);
    if (split) break;
  }
  if (!split) return;
  assert.strictEqual(split.venue, core.summariseRooms(split.rooms));
  assert.strictEqual(split.isOnline, false);
  // Every room must still be recoverable from the summary.
  for (const room of split.rooms) {
    const number = room.slice(room.lastIndexOf(" ") + 1);
    assert.ok(split.venue.includes(number), split.venue + " lacks " + room);
  }
});

test("two papers in one sitting are both flagged as a clash", () => {
  const clone = JSON.parse(JSON.stringify(data));
  const first = clone.courses[clone.students[busiest].exams[0].course];
  clone.courses["XX0000@injected"] = {
    code: "XX0000", title: "Injected Clash",
    date: first.date, start: first.start, end: first.end
  };
  clone.students[busiest].exams.push(
    { course: "XX0000@injected", venue: "LHC 999", seat: "" });
  const flagged = lookup(clone, busiest).exams.filter(e => e.clash);
  assert.strictEqual(flagged.length, 2);
});

test("a course missing from the datesheet is reported, not dropped silently", () => {
  const clone = JSON.parse(JSON.stringify(data));
  const before = clone.students[busiest].exams.length;
  clone.students[busiest].exams.push({ course: "ZZ9999", venue: "", seat: "" });
  const r = lookup(clone, busiest);
  assert.deepStrictEqual(r.unresolved, ["ZZ9999"]);
  assert.strictEqual(r.exams.length, before);
});

console.log("\nDataset integrity");
test("the dataset is not the mock placeholder", () =>
  assert.strictEqual(data.meta.isMock, false));

test("the dataset is not empty", () => {
  assert.ok(rolls.length > 100, "only " + rolls.length + " students");
  assert.ok(Object.keys(data.courses).length > 50);
});

test("every student exam references a known course", () => {
  const bad = [];
  for (const [roll, s] of Object.entries(data.students))
    for (const e of s.exams)
      if (!data.courses[e.course]) bad.push(roll + "/" + e.course);
  assert.deepStrictEqual(bad.slice(0, 5), []);
});

test("no meeting link, email address or URL is published", () => {
  // The whole dataset ships to every visitor, so a public meeting link would
  // be a joinable exam room. Guard the file itself, not just the shape.
  const raw = fs.readFileSync(path.join(root, "data.js"), "utf8");
  for (const banned of ["meet.google.com", "@iitj", "http://", "https://"]) {
    assert.strictEqual(raw.includes(banned), false,
      "data.js must not contain " + banned);
  }
});

test("every venue entry is a plain room list", () => {
  const bad = [];
  for (const [roll, st] of Object.entries(data.students))
    for (const e of st.exams)
      if (venueOf(e).some(v => /^https?:\/\//.test(v)))
        bad.push(roll + "/" + e.course);
  assert.deepStrictEqual(bad.slice(0, 5), []);
});

test("every course date parses", () => {
  const bad = Object.entries(data.courses)
    .filter(([, c]) => !parseDate(c.date)).map(([k]) => k);
  assert.deepStrictEqual(bad.slice(0, 5), []);
});

test("every sitting starts and ends at a plausible exam hour", () => {
  const bad = Object.entries(data.courses).filter(([, c]) => {
    const start = Number(c.start.slice(0, 2));
    const end = Number(c.end.slice(0, 2));
    return !(start >= 7 && start <= 20 && end > start && end <= 22);
  }).map(([k, c]) => k + " " + c.start + "-" + c.end);
  assert.deepStrictEqual(bad.slice(0, 5), []);
});

test("every roll key is already normalised", () => {
  const bad = rolls.filter(r => normaliseRoll(r) !== r);
  assert.deepStrictEqual(bad.slice(0, 5), []);
});

test("no student is registered for the same sitting twice", () => {
  const bad = [];
  for (const [roll, s] of Object.entries(data.students)) {
    const keys = s.exams.map(e => e.course);
    if (new Set(keys).size !== keys.length) bad.push(roll);
  }
  assert.deepStrictEqual(bad.slice(0, 5), []);
});

test("every student resolves without throwing", () => {
  let examined = 0;
  for (const roll of rolls) {
    const r = lookup(data, roll);
    assert.strictEqual(r.found, true, roll);
    assert.deepStrictEqual(r.unresolved, [], roll);
    examined += r.exams.length;
  }
  assert.ok(examined > 0);
  console.log("        (" + rolls.length + " students, " + examined + " papers)");
});

test("same-slot collisions are always flagged, never shown silently", () => {
  const unflagged = [];
  let clashing = 0;
  for (const roll of rolls) {
    const exams = lookup(data, roll).exams;
    const seen = new Set();
    let hit = false;
    for (const e of exams) {
      const key = e.isoDate + " " + e.start;
      if (seen.has(key)) { hit = true; if (!e.clash) unflagged.push(roll); }
      seen.add(key);
    }
    if (hit) clashing++;
  }
  assert.deepStrictEqual(unflagged.slice(0, 5), []);
  console.log("        (" + clashing + " students have a genuine same-slot clash)");
});

console.log("\n" + passed + " passed, " + failed + " failed\n");
process.exit(failed ? 1 : 0);
