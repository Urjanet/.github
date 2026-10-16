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

// AF:AL as pasted from KTLO_Daily_Data.
// Team, Member, Oct 15, Availability, Not planned, Member, Squad
const rosterRows = [
  ["Team", "Member", "Oct 15", "Availability", "Not planned", "Member", "Squad"],
  ["Nexus", "Tharun Vijayakumar", "@Tharun", "CL", "", "Skill Member", "Titan"],
  ["Nebula", "Venkat Ganesh R", "@Venkat Ganesh R", "In", "", "Skill Member", "Titan"],
  ["Neon", "Chandana C Savalgimath", "@Chandana CS", "In", "", "Skill Member", "Titan"],
  ["Nexus", "Esvar K N", "@Esvar K N", "In", "", "Skill Member", "Titan"],
  ["Nexus", "Janani Nataraj Kumar", "@Janani", "In", "", "Skill Member", "Titan"],
  ["Nexus", "K Pavankumar", "@Pavankumar", "In", "", "Skill Member", "Titan"],
  ["Nova", "Raghuram selvaraj", "@raghuram.selvaraj", "In", "", "Skill Member", "Titan"],
  ["Nova", "Pooja Sri Balakrishnan", "@Pooja Sri", "In", "", "Skill Member", "Titan"],
  ["Neon", "Meera S", "@Meera", "", "", "Skill Member", "Titan"],
  ["Neon", "Nitish Kumar Jangam", "@Nitish Kumar", "In", "", "Skill Member", "Titan"],
  ["Nova", "Sartaj R", "@Sartaj", "In", "", "Skill Member", "Titan"],
  ["Olympus", "Karthik C", "@Karthik C", "In", "", "Skill Member", "Terran"],
  ["Olympus", "Saipriyadarsini Balaji", "@Saipriyadarsini", "In", "", "Skill Member", "Terran"],
  ["Olympus", "Chandru K S", "@Chandru", "In", "", "Skill Member", "Terran"],
  ["Olympus", "Stanley Deivanayagam", "@Stanley", "SL", "", "Skill Member", "Terran"],
  ["Orin", "Anusha M", "@anusha.maladri", "In", "", "Skill Member", "Terran"],
  ["Orin", "Dinesh Ramasamy", "@Dinesh R", "In", "", "Skill Member", "Terran"],
  ["Orin", "Smitha R Gulalakai", "@SMITHA G", "In", "", "Skill Member", "Terran"],
  ["Orin", "Yogesh Thambidurai", "@Yogesh T", "SL", "", "Skill Member", "Terran"]
];

const roster = context.rosterMembersFromValues(rosterRows);
const availableNames = roster.availableMembers.map(member => member.name).sort();
const expectedIn = [
  "Anusha M",
  "Chandana C Savalgimath",
  "Chandru K S",
  "Dinesh Ramasamy",
  "Esvar K N",
  "Janani Nataraj Kumar",
  "K Pavankumar",
  "Karthik C",
  "Meera S",
  "Nitish Kumar Jangam",
  "Pooja Sri Balakrishnan",
  "Raghuram selvaraj",
  "Saipriyadarsini Balaji",
  "Sartaj R",
  "Smitha R Gulalakai",
  "Venkat Ganesh R"
];

assert(availableNames.join("|") === expectedIn.join("|"), "In and blank Availability should select members, got " + availableNames.join(", "));
assert(roster.leaveMembers.map(member => member.name).sort().join("|") === "Stanley Deivanayagam|Tharun Vijayakumar|Yogesh Thambidurai", "CL and SL stay out, got " + roster.leaveMembers.map(member => member.name).join(", "));
assert(availableNames.indexOf("Skill Member") === -1, "the role column must not be used as a person");
assert(availableNames.every(name => name.charAt(0) !== "@"), "the date column @handles must not be used as people");
assert(["Nexus", "Nebula", "Neon", "Nova", "Olympus", "Orin", "Team"].every(team => availableNames.indexOf(team) === -1), "team names must not be assignees");
assert(!roster.rosterByName.member, "the header row must not become a member");

const venkat = roster.availableMembers.filter(member => member.name === "Venkat Ganesh R")[0];
assert(venkat && venkat.team === "Nebula" && venkat.squad === "Titan", "Venkat should stay on Nebula / Titan");
assert(roster.teamMemberMap.Nebula.join(",") === "Venkat Ganesh R", "Nebula's only In member is Venkat");
assert(!roster.teamMemberMap.Nebula || roster.teamMemberMap.Nebula.indexOf("Tharun Vijayakumar") === -1, "Tharun is CL and must not receive Nebula tickets");

const groups = [0, 1].map(index => ({
  key: "nebula-" + index,
  size: 1,
  team: "Nebula",
  squad: "Titan",
  rows: [{ index: index, team: "Nebula", squad: "Titan" }]
}));
const placement = context.placeHierarchically(groups, roster.availableMembers, 4, {});
assert(placement.placed[0] === "Venkat Ganesh R" && placement.placed[1] === "Venkat Ganesh R", "Nebula tickets should go to Venkat, got " + placement.placed[0] + ", " + placement.placed[1]);

assert(context.memberIsIn("In", "") === true, "In is available");
assert(context.memberIsIn("", "") === true, "a blank status has not been submitted and stays available");
assert(context.memberIsIn("   ", "") === true, "whitespace-only status counts as not submitted");
assert(context.memberIsIn(" IN ", "") === true, "In ignores case and surrounding space");
assert(context.memberIsIn("CL", "") === false, "CL is not available");
assert(context.memberIsIn("SL", "") === false, "SL is not available");
assert(context.memberIsIn("@Venkat Ganesh R", "") === false, "a date-column handle is not a status");
assert(context.memberIsIn("In", "yes") === false, "not planned yes withholds an In member");
assert(roster.availableMembers.some(member => member.name === "Meera S"), "a member who has not submitted Availability receives tickets");

assert(source.indexOf('const ROSTER_RANGE = "AF2:AL20"') !== -1, "distribution must read AF2:AL20");
assert(source.indexOf("const ROSTER_COL_AVAILABILITY = 3") !== -1, "Availability is column AI");
assert(source.indexOf("memberIsIn(source[ROSTER_COL_AVAILABILITY], source[ROSTER_COL_NOT_PLANNED])") !== -1, "In is read from Availability, not the date column");
assert(source.indexOf('getRange("AE2:AK20")') === -1, "distribution must not load the old AE2:AK20 window");
assert(source.indexOf("Column AH is the status") === -1, "the alert must not point at the date column");

if (failures) {
  console.error(failures + " assertion(s) failed");
  process.exit(1);
}
console.log("roster distribution tests passed");
