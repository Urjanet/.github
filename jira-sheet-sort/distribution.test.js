const fs = require("fs");
const vm = require("vm");

const context = { console, Math, Object, String };
vm.createContext(context);
vm.runInContext(fs.readFileSync(__dirname + "/KTLOTicketDistribution.gs", "utf8"), context);

function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(label + "\n  actual: " + a + "\n  expected: " + e);
  }
}

assertEqual(context.memberIsOnLeave("PL", "Available", "No"), true, "attendance leave code");
assertEqual(context.memberIsOnLeave("Present", "No", "No"), true, "availability no");
assertEqual(context.memberIsOnLeave("Present", "Available", "Yes"), true, "not planned yes");
assertEqual(context.memberIsOnLeave("Present", "Available", "No"), false, "not planned no stays available");
assertEqual(context.memberIsOnLeave("", "", ""), false, "blank attendance stays available");
assertEqual(context.memberIsOnLeave("WFH", "Available", ""), false, "wfh stays available");

const counts = { Ann: 0, Ben: 0, Cara: 0, Dan: 0 };
assertEqual(
  context.chooseAssignee(["Ann", "Ben"], ["Cara"], ["Ann", "Ben", "Cara", "Dan"], 1, 1, 1, counts),
  "Ann",
  "open team member is chosen before squad"
);

counts.Ann = 1;
counts.Ben = 1;
assertEqual(
  context.chooseAssignee(["Ann", "Ben"], ["Cara"], ["Ann", "Ben", "Cara", "Dan"], 1, 1, 2, counts),
  "Cara",
  "full team spills to the squad"
);

counts.Cara = 2;
assertEqual(
  context.chooseAssignee(["Ann", "Ben"], ["Cara"], ["Ann", "Ben", "Cara", "Dan"], 1, 1, 1, counts),
  "Dan",
  "full team and squad spill to overall"
);

counts.Ann = 2;
counts.Dan = 1;
assertEqual(
  context.chooseAssignee(["Ann", "Ben"], ["Cara"], ["Ann", "Ben", "Cara", "Dan"], 1, 1, 1, counts),
  "Ben",
  "when everyone is at cap, the least loaded team member keeps the ticket"
);

assertEqual(
  context.chooseAssignee(["Ann", "Ben"], ["Cara"], ["Ann", "Ben", "Cara"], 4, 3, 3, { Ann: 0, Ben: 5, Cara: 0 }),
  "Ann",
  "a template batch larger than the cap stays with one team member"
);

const teams = [["Neon"], ["neon"], ["Titan"], [""]];
assertEqual(context.majorityLabel([0, 1, 2], teams, { neon: "Neon" }), "Neon", "majority team is case-insensitive");
assertEqual(context.formatShare(12, 4), "3", "whole per-head count");
assertEqual(context.formatShare(12, 5), "2.40", "fractional per-head count");

console.log("distribution rules ok");
