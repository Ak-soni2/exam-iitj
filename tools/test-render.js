/* Run with: node tools/test-render.js   (needs: npm i jsdom)
   Loads index.html in jsdom, types a roll number, and inspects the rendered DOM. */

const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { JSDOM } = require("jsdom");

const root = path.join(__dirname, "..");
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  pass  " + name); }
  catch (e) { failed++; console.log("  FAIL  " + name + "\n        " + e.message); }
}

const sandbox = {};
new Function("window", fs.readFileSync(path.join(root, "data.js"), "utf8"))(sandbox);
const data = sandbox.EXAM_DATA;
const core = require(path.join(root, "app.js"));

const rolls = Object.keys(data.students);
const busiest = rolls.slice().sort(
  (a, b) => data.students[b].exams.length - data.students[a].exams.length)[0];
const onlineRoll = rolls.find(r => data.students[r].exams.some(e => e.online));
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function boot() {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const dom = new JSDOM(html, {
    runScripts: "outside-only", pretendToBeVisual: true,
    url: "https://example.org/exam-iitj/"
  });
  const w = dom.window;
  w.eval(fs.readFileSync(path.join(root, "data.js"), "utf8"));
  w.eval(fs.readFileSync(path.join(root, "app.js"), "utf8"));
  w.document.dispatchEvent(new w.Event("DOMContentLoaded", { bubbles: true }));
  return w;
}

function type(w, value) {
  const input = w.document.getElementById("roll");
  input.value = value;
  w.document.getElementById("lookup")
    .dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
  return w.document.getElementById("results");
}

console.log("\nPage boot");
const w = boot();
test("term line is filled from the dataset", () =>
  assert.ok(w.document.getElementById("term").textContent.includes("Minor Examinations")));
test("a notice explains how rooms are allocated", () => {
  const banner = w.document.getElementById("mock-warning");
  assert.strictEqual(banner.hidden, false);
  assert.ok(/room/i.test(banner.textContent), banner.textContent);
});

console.log("\nRendering a real roll number");
const expected = core.lookup(data, busiest);
const out = type(w, busiest.toLowerCase());
const rows = out.querySelectorAll(".exam");

test("student name is shown", () =>
  assert.strictEqual(out.querySelector(".student__name").textContent, expected.name));
test("normalised roll number is shown", () =>
  assert.strictEqual(out.querySelector(".student__roll").textContent, busiest));
test("one row is rendered per paper", () =>
  assert.strictEqual(rows.length, expected.exams.length));
test("first row is the earliest paper", () => {
  const first = expected.exams[0];
  assert.strictEqual(rows[0].querySelector(".exam__title").textContent, first.title);
  assert.strictEqual(rows[0].querySelector(".exam__daynum").textContent,
    String(first.date.getDate()));
});
test("weekday matches the calendar", () =>
  assert.strictEqual(rows[0].querySelector(".exam__weekday").textContent,
    DAYS[expected.exams[0].date.getDay()]));
test("times render in 12-hour form", () => {
  const text = rows[0].querySelector(".exam__time").textContent;
  assert.ok(text.includes(core.to12Hour(expected.exams[0].start)), text);
  assert.ok(text.includes(core.to12Hour(expected.exams[0].end)), text);
});
test("every row shows a course code", () =>
  assert.ok([...rows].every(r =>
    r.querySelector(".exam__code").textContent.trim().length >= 5)));
test("every row shows a venue or 'To be announced'", () =>
  assert.ok([...rows].every(r =>
    r.querySelector(".exam__place").textContent.trim().length > 3)));
test("rows appear in chronological order on the page", () => {
  const shown = [...rows].map(r => r.querySelector(".exam__title").textContent);
  assert.deepStrictEqual(shown, expected.exams.map(e => e.title));
});
test("deep link hash is set", () =>
  assert.strictEqual(w.location.hash, "#" + busiest));

console.log("\nOnline exams");
test("an online paper says so and points at the emailed link", () => {
  assert.ok(onlineRoll, "dataset has no online paper");
  const out = type(w, onlineRoll);
  assert.ok(/Online exam/.test(out.textContent));
  assert.ok(/emails your meeting link/i.test(out.textContent));
});

test("no anchor tag or meeting link is ever rendered", () => {
  for (const roll of [onlineRoll, busiest]) {
    const out = type(w, roll);
    assert.strictEqual(out.querySelectorAll("a").length, 0,
      "results must not contain links");
    assert.strictEqual(/meet\.google\.com/.test(out.innerHTML), false);
  }
});

console.log("\nVenues");
test("a single-room paper shows its building and room", () => {
  let roll = null, exam = null;
  for (const r of rolls) {
    exam = core.lookup(data, r).exams.find(e => !e.isOnline && e.rooms.length === 1);
    if (exam) { roll = r; break; }
  }
  assert.ok(roll, "expected a single-room paper");
  const rendered = [...type(w, roll).querySelectorAll(".exam")]
    .map(r => r.querySelector(".exam__place").textContent);
  assert.ok(rendered.some(t => t.includes(exam.rooms[0])), rendered.join(" | "));
});

test("a paper split over rooms tells the student to check the door list", () => {
  const roll = rolls.find(r =>
    core.lookup(data, r).exams.some(e => e.rooms.length > 1));
  if (!roll) return;
  assert.ok(/seating list/i.test(type(w, roll).textContent),
    "expected a seating-list hint");
});

console.log("\nClash reporting");
test("a student with two papers in one sitting sees a warning", () => {
  const clashRoll = rolls.find(r => core.lookup(data, r).exams.some(e => e.clash));
  if (!clashRoll) return;            // none in this dataset; nothing to assert
  const flagged = type(w, clashRoll);
  assert.ok(flagged.querySelectorAll(".exam--clash").length >= 2);
  assert.ok(/examination cell/i.test(flagged.querySelector(".exam__flag").textContent));
});

console.log("\nFailure states");
test("unknown roll shows a recoverable message, no exam rows", () => {
  const miss = type(w, "B21XX0000");
  assert.strictEqual(miss.querySelectorAll(".exam").length, 0);
  assert.ok(miss.querySelector(".notice").textContent
    .includes("No schedule found for B21XX0000"));
});
test("clearing the field returns to the prompt", () =>
  assert.ok(type(w, "").querySelector(".notice").textContent
    .includes("Type a roll number")));
test("injected markup is escaped, not executed", () => {
  const evil = type(w, "<img src=x onerror=alert(1)>");
  assert.strictEqual(evil.querySelectorAll("img").length, 0);
});

console.log("\n" + passed + " passed, " + failed + " failed\n");
process.exit(failed ? 1 : 0);
