const fs = require("fs");
const vm = require("vm");

const context = { console, Math, Object, String, Date, RegExp };
vm.createContext(context);
vm.runInContext(fs.readFileSync(__dirname + "/RunAllAppends.gs", "utf8"), context);

function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(label + "\n  actual: " + a + "\n  expected: " + e);
  }
}

const when = new Date("2026-10-15T12:00:00Z");
const grid = [
  ["Oct-15", "Monday", "ext-2029692", 5, when, "Note FS-7 and EXT-8."],
  ["Oct-15", "Monday", "  :FS-10  ", "", false, "NEXT-4"],
  ["Oct-15", "Monday", "=EXT-1", "EXT-", "FS-", "id:EXT-42 done"]
];

const links = context.linkTicketIds(grid);

assertEqual(grid[0][0], "Oct-15", "date label stays plain text");
assertEqual(grid[0][2], "EXT-2029692", "lowercase ticket displays as EXT-2029692");
assertEqual(grid[0][3], 5, "numbers stay numbers");
assertEqual(grid[0][4], when, "dates stay dates");
assertEqual(grid[0][5], "Note FS-7 and EXT-8.", "embedded tickets keep surrounding text");
assertEqual(grid[1][2], "FS-10", "colon and whitespace normalize to the ticket id");
assertEqual(grid[1][5], "NEXT-4", "other project keys are left alone");
assertEqual(grid[2][2], "=EXT-1", "formula text is left alone");
assertEqual(grid[2][3], "EXT-", "a prefix without a number is left alone");
assertEqual(grid[2][4], "FS-", "FS prefix without a number is left alone");
assertEqual(grid[2][5], "id:EXT-42 done", "ticket id inside text stays EXT-42");

assertEqual(links.map(link => ({
  row: link.row,
  column: link.column,
  text: link.text,
  links: link.links
})), [
  {
    row: 0,
    column: 2,
    text: "EXT-2029692",
    links: [{ start: 0, end: 11, url: "https://arcadiapower.atlassian.net/browse/EXT-2029692" }]
  },
  {
    row: 0,
    column: 5,
    text: "Note FS-7 and EXT-8.",
    links: [
      { start: 5, end: 9, url: "https://arcadiapower.atlassian.net/browse/FS-7" },
      { start: 14, end: 19, url: "https://arcadiapower.atlassian.net/browse/EXT-8" }
    ]
  },
  {
    row: 1,
    column: 2,
    text: "FS-10",
    links: [{ start: 0, end: 5, url: "https://arcadiapower.atlassian.net/browse/FS-10" }]
  },
  {
    row: 2,
    column: 5,
    text: "id:EXT-42 done",
    links: [{ start: 3, end: 9, url: "https://arcadiapower.atlassian.net/browse/EXT-42" }]
  }
], "ticket link targets");

assertEqual(
  context.linkifyTicketText("see ext-15"),
  {
    text: "see EXT-15",
    links: [{ start: 4, end: 10, url: "https://arcadiapower.atlassian.net/browse/EXT-15" }]
  },
  "embedded lowercase ticket is uppercased in place"
);

assertEqual(context.linkifyTicketText("no ticket here"), null, "text without a ticket is unchanged");
assertEqual(context.linkifyTicketText("XEXT-2029692"), null, "ticket prefix must be its own word");

const runs = context.groupLinkRuns([
  { row: 0, column: 2, text: "EXT-1", links: [] },
  { row: 2, column: 2, text: "EXT-3", links: [] },
  { row: 1, column: 2, text: "EXT-2", links: [] },
  { row: 4, column: 2, text: "EXT-5", links: [] },
  { row: 0, column: 3, text: "FS-1", links: [] }
]);

assertEqual(runs.map(run => ({
  column: run.column,
  startRow: run.startRow,
  texts: run.cells.map(cell => cell.text)
})), [
  { column: 2, startRow: 0, texts: ["EXT-1", "EXT-2", "EXT-3"] },
  { column: 2, startRow: 4, texts: ["EXT-5"] },
  { column: 3, startRow: 0, texts: ["FS-1"] }
], "consecutive ticket cells in a column share one write");

const pending = [];
context.rememberTicketLinks(pending, 10, 1, [
  { row: 0, column: 2, text: "EXT-2029692", links: [{ start: 0, end: 11, url: "https://arcadiapower.atlassian.net/browse/EXT-2029692" }] }
]);
assertEqual(pending, [
  {
    row: 9,
    column: 2,
    text: "EXT-2029692",
    links: [{ start: 0, end: 11, url: "https://arcadiapower.atlassian.net/browse/EXT-2029692" }]
  }
], "row links are stored at the sheet row they were written to");

console.log("ticket link rules ok");
