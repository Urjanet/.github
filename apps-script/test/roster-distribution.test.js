const fs = require("fs");
const path = require("path");
const vm = require("vm");

const scriptPath = path.join(__dirname, "..", "ktlo-ticket-distribution.gs");
const source = fs.readFileSync(scriptPath, "utf8");
const context = { console: console };
vm.createContext(context);
vm.runInContext(source, context, { filename: scriptPath });

let failures = 0;
function assert(condition, message) {
  if (condition) return;
  failures += 1;
  console.error("FAIL: " + message);
}

const teamNames = ["Nebula", "Neon", "Nova", "Olympus", "Orin", "Team"];

// Physical columns AE:AL. Distribution must read AF:AL, not AE:AK.
const sheetRows = [
  ["", "Team", "Member", "Status", "Availability", "Not Planned", "Alt name", "Squad"],
  ["", "Nebula", "Asha", "IN", "", "", "", "Terran"],
  ["", "Nebula", "Bala", "in", "", "", "", "Terran"],
  ["", "Neon", "Chitra", "PL", "", "", "", "Titan"],
  ["", "Orin", "Dev", "OUT", "", "", "", "Titan"],
  ["", "Nova", "", "", "", "", "Eve", "Terran"],
  ["", "Nova", "Hema", "IN", "", "yes", "", "Terran"],
  ["", "Olympus", "Frank", "IN", "no", "", "", "Titan"],
  ["", "Orin", "Gita", "IN", "", "", "", "Titan"]
];
const oldWindow = sheetRows.map(row => row.slice(0, 7));
const memberWindow = sheetRows.map(row => row.slice(1, 8));

const misaligned = context.rosterMembersFromValues(oldWindow);
const roster = context.rosterMembersFromValues(memberWindow);
const availableNames = roster.availableMembers.map(member => member.name).sort();

assert(availableNames.join(",") === "Asha,Bala,Gita", "IN members should be Asha, Bala, and Gita, got " + availableNames.join(","));
assert(roster.availableMembers.every(member => teamNames.indexOf(member.name) === -1), "available assignees must be people, not team names");
assert(roster.leaveMembers.map(member => member.name).sort().join(",") === "Chitra,Dev,Eve,Frank,Hema", "non-IN and blocked members should be withheld, got " + roster.leaveMembers.map(member => member.name).join(","));
assert(!roster.rosterByName.team && !roster.rosterByName.member, "header row must not become a member");
assert(misaligned.availableMembers.length === 0, "the old AE:AK window does not line up with the IN column, so it cannot select members");
assert(roster.teamMemberMap.Nebula.slice().sort().join(",") === "Asha,Bala", "Nebula's IN members should stay on Nebula");
assert(!roster.teamMemberMap.Neon, "Neon has no IN member, so tickets must not be given to the team name");

const groups = [0, 1, 2, 3].map(index => ({
  key: "ticket-" + index,
  size: 1,
  team: index < 3 ? "Nebula" : "Neon",
  squad: index < 3 ? "Terran" : "Titan",
  rows: [{ index: index, team: index < 3 ? "Nebula" : "Neon", squad: index < 3 ? "Terran" : "Titan" }]
}));
const placement = context.placeHierarchically(groups, roster.availableMembers, 2, {});
const assigned = [0, 1, 2, 3].map(index => placement.placed[index]);
assert(assigned.every(name => ["Asha", "Bala", "Gita"].indexOf(name) !== -1), "shared tickets should land on IN members, got " + assigned.join(","));
assert(assigned.slice(0, 3).every(name => name === "Asha" || name === "Bala"), "Nebula tickets should stay with Nebula members, got " + assigned.slice(0, 3).join(","));
assert(assigned[3] !== "Neon" && assigned[3] !== "Team", "a team with nobody IN should not be used as the assignee");
assert((placement.assignedCount.Asha || 0) <= 2 && (placement.assignedCount.Bala || 0) <= 2, "per-person cap should hold");

assert(context.memberIsIn("IN", "", "") === true, "IN is available");
assert(context.memberIsIn(" In ", "", "") === true, "IN ignores case and surrounding space");
assert(context.memberIsIn("OUT", "", "") === false, "OUT is not available");
assert(context.memberIsIn("", "", "") === false, "blank status is not available");
assert(context.memberIsIn("IN", "no", "") === false, "IN does not override an explicit unavailable flag");
assert(context.memberIsIn("IN", "", "yes") === false, "IN does not override unplanned leave");

assert(source.indexOf('const ROSTER_RANGE = "AF2:AL20"') !== -1, "distribution must read AF2:AL20");
assert(source.indexOf('getRange("AE2:AK20")') === -1, "distribution must not load the old AE2:AK20 window");
assert(source.indexOf("getRange(ROSTER_RANGE)") !== -1, "distributeTickets must load the IN roster range");

if (failures) {
  console.error(failures + " assertion(s) failed");
  process.exit(1);
}
console.log("roster distribution tests passed");
