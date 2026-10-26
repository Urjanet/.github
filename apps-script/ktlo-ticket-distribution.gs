const SHEET_NAME_KTLO_DAILYtest = 'KTLO_Daily_Data';
const SHEET_NAME_OVERALL_ANALYSISOverall = 'Overall-Analysis';

const JIRA_DOMAIN = "arcadiapower.atlassian.net";
const JIRA_EMAIL = "sowmiya.kirubakaran@arcadia.com";
const JIRA_SEARCH_PAGE_SIZE = 100;
const JIRA_SEARCH_MAX_PAGES = 500;
const RESOLVER_FIELD = "customfield_11178";
const RESOLVER_GROUP = "ops_dev_extraction";
const ITD_WHITEBOARD_FIELD = "customfield_11239";
const OVERALL_ANALYSIS_AP_COLUMN = 42;
const EXTERNAL_LOOKUP_URL = "https://docs.google.com/spreadsheets/d/17znON2jpaGDm_7KH0FEf9z4OvV4HmZ-E9go43MkkxwE";

// KTLO_Daily_Data!AF2:AL20
// AF Team | AG Member | AH date (@handles) | AI Availability (In, blank, *first HD, CL, SL) | AJ Not planned | AK role | AL Squad
// Availability In, blank, or *first HD receives tickets. A submitted leave mark such as CL or SL does not.
const ROSTER_RANGE = "AF2:AL20";
const ROSTER_COL_TEAM = 0;
const ROSTER_COL_NAME = 1;
const ROSTER_COL_DATE = 2;
const ROSTER_COL_AVAILABILITY = 3;
const ROSTER_COL_NOT_PLANNED = 4;
const ROSTER_COL_ROLE = 5;
const ROSTER_COL_SQUAD = 6;

function onOpen() {
  try {
    const ui = SpreadsheetApp.getUi();
    ui.createMenu('KTLO Skill - Ticket Distribution')
      .addItem('Overall Fetch Jira Tickets & Distribute', 'fetchJiraDataFromB27Query')
      //.addItem('Run Hierarchical Distribution & Sort Only', 'distributeTickets')
      //.addItem('Fetch Resolver in ops_dev_extraction (Column AX)', 'fetchResolverToColumnAX')
      .addItem('Update Overall Analysis (AR-AW)', 'populateOverallAnalysisARtoAW')
      .addSeparator()
      .addItem('Update ITD Whiteboard from Overall-Analysis (Column AP)', 'updateItdWhiteboardFromColumnAP')
      .addToUi();
  } catch (e) {
    Logger.log("Skipped UI creation: Executed outside active sheet UI context.");
  }
}

function extractFieldValue(val) {
  if (val === undefined || val === null) return "";
  if (Array.isArray(val)) return val.map(item => extractFieldValue(item)).filter(String).join(", ");
  if (typeof val === 'object') {
    if (val.type === 'doc' && Array.isArray(val.content)) {
      var textParts = [];
      function extractAdfText(node) {
        if (!node) return;
        if (node.type === 'text' && node.text) textParts.push(node.text);
        if (Array.isArray(node.content)) node.content.forEach(extractAdfText);
      }
      val.content.forEach(extractAdfText);
      return textParts.join(" ").trim();
    }
    return val.displayName || val.value || val.name || JSON.stringify(val);
  }
  if (typeof val === 'string' && val.trim().startsWith('{"type":"doc"')) {
    try { return extractFieldValue(JSON.parse(val)); } catch (e) { return val; }
  }
  return val;
}

function fetchJiraDataFromB27Query() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ktloSheet = ss.getSheetByName(SHEET_NAME_KTLO_DAILYtest);
  const targetSheet = ss.getSheetByName(SHEET_NAME_OVERALL_ANALYSISOverall);
  if (!ktloSheet) { SpreadsheetApp.getUi().alert("Error: Sheet '" + SHEET_NAME_KTLO_DAILYtest + "' not found."); return; }
  if (!targetSheet) { SpreadsheetApp.getUi().alert("Error: Sheet '" + SHEET_NAME_OVERALL_ANALYSISOverall + "' not found."); return; }

  const jqlCell = ktloSheet.getRange("B27");
  let jqlQuery = jqlCell.getDisplayValue().toString().trim();
  if (!jqlQuery) jqlQuery = jqlCell.getValue().toString().trim();
  if (!jqlQuery) { SpreadsheetApp.getUi().alert("Error: Formula in cell B27 of '" + SHEET_NAME_KTLO_DAILYtest + "' returned empty text."); return; }

  const headers = getJiraAuthHeaders();
  if (!headers) { SpreadsheetApp.getUi().alert("Error: 'Jira_API_TOKEN_SK' not found in Script Properties."); return; }

  const requestedFields = [
    "key", "reporter", "status", "created", "duedate",
    "customfield_11168", "customfield_15610", "customfield_11271", "customfield_11183",
    "customfield_11772", "customfield_11178", "customfield_11171", "assignee",
    "customfield_12282", "customfield_12284", "labels",
    "customfield_19783", "customfield_19818", "customfield_19782", "customfield_19817"
  ];

  let searchResult;
  try { searchResult = fetchIssuesByJql(jqlQuery, requestedFields, headers); }
  catch (e) { SpreadsheetApp.getUi().alert("Jira search using B27 failed:\n" + e.message); return; }

  const issues = searchResult.issues;
  targetSheet.getRange("2:1000").clearContent();
  if (issues.length === 0) {
    SpreadsheetApp.getUi().alert("B27 JQL returned no issues. Rows 2:1000 were cleared.\n\n" + jqlQuery.substring(0, 500));
    return;
  }

  targetSheet.getRange(2, 1, issues.length, 20).setValues(issues.map(issueToRow));
  SpreadsheetApp.flush();
  if (searchResult.truncated) {
    SpreadsheetApp.getUi().alert("Loaded the first " + issues.length + " issues from B27. The JQL has more pages than this run keeps (" + (JIRA_SEARCH_MAX_PAGES * JIRA_SEARCH_PAGE_SIZE) + ").");
  } else {
    ss.toast("Loaded " + issues.length + " issues from the B27 JQL.", "Jira", 5);
  }

  applyMissingFormulas();
  waitForEligibilityFormulas(targetSheet);
  distributeTickets();
}

function waitForEligibilityFormulas(sheet) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    SpreadsheetApp.flush();
    if (sheet.getRange("AM2").getDisplayValue().toString().trim()) return;
    Utilities.sleep(1000);
  }
  Logger.log("Timed out waiting for column AM formulas to calculate.");
}

function fetchIssuesByJql(jqlQuery, requestedFields, headers) {
  const searchUrl = "https://" + JIRA_DOMAIN + "/rest/api/3/search/jql";
  const issues = [];
  const seenKeys = {};
  let nextPageToken = "";
  for (let page = 0; page < JIRA_SEARCH_MAX_PAGES; page++) {
    const payload = { jql: jqlQuery, maxResults: JIRA_SEARCH_PAGE_SIZE, fields: requestedFields };
    if (nextPageToken) payload.nextPageToken = nextPageToken;
    const response = UrlFetchApp.fetch(searchUrl, {
      method: "post", headers: headers, contentType: "application/json",
      payload: JSON.stringify(payload), muteHttpExceptions: true
    });
    const code = response.getResponseCode();
    const body = response.getContentText();
    if (code !== 200) throw new Error("Jira search failed (" + code + "): " + body.substring(0, 500));
    let data;
    try { data = JSON.parse(body); } catch (e) { throw new Error("Jira search returned invalid JSON: " + body.substring(0, 500)); }
    (data.issues || []).forEach(issue => {
      const key = issue && issue.key;
      if (!key || seenKeys[key]) return;
      seenKeys[key] = true;
      issues.push(issue);
    });
    if (data.isLast || !data.nextPageToken) return { issues: issues, truncated: false };
    if (data.nextPageToken === nextPageToken) throw new Error("Jira search repeated the same page token. Stopped to avoid a loop.");
    nextPageToken = data.nextPageToken;
  }
  return { issues: issues, truncated: true };
}

function issueToRow(issue) {
  const key = issue.key;
  const f = issue.fields || {};
  return [
    '=HYPERLINK("https://' + JIRA_DOMAIN + '/browse/' + key + '", "' + key + '")',
    extractFieldValue(f.reporter), extractFieldValue(f.status),
    f.created ? f.created.substring(0, 10) : "", f.duedate || "",
    extractFieldValue(f.customfield_11168), extractFieldValue(f.customfield_15610),
    extractFieldValue(f.customfield_11271), extractFieldValue(f.customfield_11183),
    extractFieldValue(f.customfield_11772), extractFieldValue(f.customfield_11178),
    extractFieldValue(f.customfield_11171), extractFieldValue(f.assignee),
    extractFieldValue(f.customfield_12282), extractFieldValue(f.customfield_12284),
    extractFieldValue(f.labels), extractFieldValue(f.customfield_19783),
    extractFieldValue(f.customfield_19818), extractFieldValue(f.customfield_19782),
    extractFieldValue(f.customfield_19817)
  ];
}

function rosterCellText(value) { return value === undefined || value === null ? "" : value.toString().trim(); }
function rosterNorm(value) { return rosterCellText(value).toLowerCase(); }
var ROSTER_HARD_LEAVE = ["pl", "cl", "sl", "fl", "al", "leave", "on leave", "absent", "unavailable", "not available", "not planned", "unplanned"];
function rosterMarksLeave(status) { return ROSTER_HARD_LEAVE.indexOf(status) !== -1; }
function memberIsOnLeave(attendance, availability, notPlanned) {
  const day = rosterNorm(attendance), avail = rosterNorm(availability), planned = rosterNorm(notPlanned);
  if (rosterMarksLeave(day) || day === "no" || day === "n" || day === "0") return true;
  if (rosterMarksLeave(avail) || avail === "no" || avail === "n" || avail === "0") return true;
  if (rosterMarksLeave(planned) || planned === "yes" || planned === "y" || planned === "1" || planned === "true") return true;
  return false;
}
function availabilityOffersTickets(availability) {
  const status = rosterNorm(availability).replace(/^\*+\s*/, "").replace(/\s+/g, " ");
  return status === "in" || status === "" || status === "first hd";
}
function memberIsIn(availability, notPlanned) {
  if (!availabilityOffersTickets(availability)) return false;
  const planned = rosterNorm(notPlanned);
  if (rosterMarksLeave(planned) || planned === "yes" || planned === "y" || planned === "1" || planned === "true") return false;
  return true;
}
function currentSkillableDate() {
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone() || "Asia/Kolkata";
  return Utilities.formatDate(new Date(), tz, "dd-MMM").replace(/\./g, "");
}
function isSkillableValue(value, prefix) {
  const text = rosterNorm(value);
  return text === "skill eligible" || text.indexOf(prefix.toLowerCase() + "-") === 0;
}
function rememberLabel(canonByNorm, raw) {
  const display = rosterCellText(raw);
  if (!display) return "";
  const key = display.toLowerCase();
  if (!canonByNorm[key]) canonByNorm[key] = display;
  return canonByNorm[key];
}
function addMemberToGroup(groupMap, groupName, memberName) {
  if (!groupName) return;
  if (!groupMap[groupName]) groupMap[groupName] = [];
  groupMap[groupName].push(memberName);
}
function leastLoadedName(names, assignedCount) {
  if (!names || names.length === 0) return "";
  return names.slice().sort((a, b) => ((assignedCount[a] || 0) - (assignedCount[b] || 0)) || a.localeCompare(b))[0];
}
function pickUnderCap(names, batchSize, cap, assignedCount) {
  if (!names || names.length === 0 || batchSize > cap) return "";
  const under = names.slice().sort((a, b) => ((assignedCount[a] || 0) - (assignedCount[b] || 0)) || a.localeCompare(b))
    .filter(name => (assignedCount[name] || 0) + batchSize <= cap);
  return under.length ? under[0] : "";
}
function formatShare(numerator, denominator) {
  if (!denominator) return "0";
  const value = numerator / denominator;
  return value === Math.round(value) ? String(value) : value.toFixed(2);
}
function isRosterHeader(team, name, squad) {
  const nameKey = rosterNorm(name);
  const teamKey = rosterNorm(team);
  const squadKey = rosterNorm(squad);
  const headerNames = ["member", "name", "team member", "employee", "worked by", "assignee"];
  if (headerNames.indexOf(nameKey) !== -1 && (teamKey === "team" || teamKey === "")) return true;
  if (teamKey === "team" && squadKey === "squad") return true;
  return nameKey === "member" && teamKey === "team" && squadKey === "squad";
}
function loadAssigneeDirectory(ss) {
  const directory = {};
  const sheet = ss.getSheetByName("TeamList-2026");
  if (!sheet || sheet.getLastRow() < 2) return directory;
  sheet.getRange(2, 2, sheet.getLastRow() - 1, 3).getValues().forEach(row => {
    const name = rosterCellText(row[0]);
    if (!name || directory[name.toLowerCase()]) return;
    directory[name.toLowerCase()] = { team: rosterCellText(row[1]), squad: rosterCellText(row[2]) };
  });
  return directory;
}
function topLabel(counts) {
  let best = "", bestCount = 0;
  Object.keys(counts).forEach(label => { if (counts[label] > bestCount) { best = label; bestCount = counts[label]; } });
  return best;
}
function evenShares(total, names) {
  const shares = {};
  const list = (names || []).slice().sort((a, b) => a.localeCompare(b));
  list.forEach(name => { shares[name] = 0; });
  if (!list.length || total <= 0) return shares;
  const base = Math.floor(total / list.length);
  let extra = total % list.length;
  list.forEach(name => { shares[name] = base + (extra > 0 ? 1 : 0); if (extra > 0) extra--; });
  return shares;
}
function resolveTicketHome(assigneeRaw, akRaw, rosterByName, directory, teamCanon, teamSquad) {
  const assigneeKey = rosterNorm(assigneeRaw);
  const fromList = directory[assigneeKey];
  if (fromList) {
    const team = teamCanon[rosterNorm(fromList.team)] || "";
    if (team) return { team: team, squad: teamSquad[team] || "" };
  }
  const fromRoster = rosterByName[assigneeKey];
  if (fromRoster && fromRoster.team) return { team: fromRoster.team, squad: teamSquad[fromRoster.team] || fromRoster.squad || "" };
  const akTeam = teamCanon[rosterNorm(akRaw)] || "";
  if (akTeam) return { team: akTeam, squad: teamSquad[akTeam] || "" };
  return { team: "", squad: "" };
}

function placeHierarchically(groups, availableMembers, personCap, initialCounts) {
  const assignedCount = {}, memberByName = {}, teamMemberMap = {}, squadMemberMap = {}, starting = initialCounts || {}, placed = {};
  availableMembers.forEach(m => {
    assignedCount[m.name] = starting[m.name] || 0;
    memberByName[m.name] = m;
    addMemberToGroup(teamMemberMap, m.team, m.name);
    addMemberToGroup(squadMemberMap, m.squad, m.name);
  });
  function give(group, name) {
    group.rows.forEach(row => { placed[row.index] = name; });
    assignedCount[name] += group.size;
  }
  const overflow = [];
  groups.forEach(group => {
    const chosen = pickUnderCap(teamMemberMap[group.team] || [], group.size, personCap, assignedCount);
    if (chosen) give(group, chosen); else overflow.push(group);
  });
  const still = [];
  overflow.forEach(group => {
    const chosen = pickUnderCap(squadMemberMap[group.squad] || [], group.size, personCap, assignedCount);
    if (chosen) give(group, chosen); else still.push(group);
  });
  const leftover = [], allNames = availableMembers.map(m => m.name);
  function placeOutside(group) {
    const targets = group.squad ? availableMembers.filter(m => m.squad !== group.squad).map(m => m.name) : allNames;
    const chosen = pickUnderCap(targets, group.size, personCap, assignedCount);
    if (chosen) give(group, chosen); else leftover.push(group);
  }
  still.filter(group => group.squad).forEach(placeOutside);
  still.filter(group => !group.squad).forEach(placeOutside);
  leftover.forEach(group => {
    const teamNames = teamMemberMap[group.team] || [];
    const squadNames = squadMemberMap[group.squad] || [];
    const other = group.squad ? availableMembers.filter(m => m.squad !== group.squad).map(m => m.name) : allNames;
    function underCap(names) { return (names || []).filter(name => (assignedCount[name] || 0) + group.size <= personCap); }
    const chosen = leastLoadedName(underCap(teamNames), assignedCount)
      || leastLoadedName(underCap(squadNames), assignedCount)
      || leastLoadedName(underCap(other), assignedCount)
      || leastLoadedName(underCap(allNames), assignedCount)
      || leastLoadedName(teamNames, assignedCount)
      || leastLoadedName(squadNames, assignedCount)
      || leastLoadedName(other, assignedCount)
      || leastLoadedName(allNames, assignedCount);
    if (chosen) give(group, chosen);
  });
  return { placed: placed, assignedCount: assignedCount, memberByName: memberByName };
}

function rosterMembersFromValues(availabilityData) {
  const availableMembers = [];
  const leaveMembers = [];
  const squadMemberMap = {};
  const teamMemberMap = {};
  const teamCanon = {};
  const squadCanon = {};
  const rosterByName = {};
  const squadVotes = {};
  const seenNames = {};

  (availabilityData || []).forEach(row => {
    const source = row || [];
    const teamRaw = source[ROSTER_COL_TEAM];
    const name = rosterCellText(source[ROSTER_COL_NAME]);
    const squadRaw = source[ROSTER_COL_SQUAD];
    if (isRosterHeader(teamRaw, name, squadRaw) || !name || seenNames[rosterNorm(name)]) return;
    seenNames[rosterNorm(name)] = true;
    const team = rememberLabel(teamCanon, teamRaw);
    const squad = rememberLabel(squadCanon, squadRaw);
    const person = { name: name, squad: squad, team: team };
    rosterByName[rosterNorm(name)] = person;
    if (team && squad) {
      if (!squadVotes[team]) squadVotes[team] = {};
      squadVotes[team][squad] = (squadVotes[team][squad] || 0) + 1;
    }
    if (memberIsIn(source[ROSTER_COL_AVAILABILITY], source[ROSTER_COL_NOT_PLANNED])) {
      availableMembers.push(person);
      addMemberToGroup(teamMemberMap, team, name);
      addMemberToGroup(squadMemberMap, squad, name);
    } else {
      leaveMembers.push(person);
    }
  });

  const teamSquad = {};
  Object.keys(squadVotes).forEach(team => { teamSquad[team] = topLabel(squadVotes[team]); });
  return {
    availableMembers: availableMembers,
    leaveMembers: leaveMembers,
    squadMemberMap: squadMemberMap,
    teamMemberMap: teamMemberMap,
    teamCanon: teamCanon,
    rosterByName: rosterByName,
    teamSquad: teamSquad
  };
}

function distributeTickets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const dataSheet = ss.getSheetByName(SHEET_NAME_OVERALL_ANALYSISOverall);
  const rosterSheet = ss.getSheetByName(SHEET_NAME_KTLO_DAILYtest);
  if (!dataSheet) { SpreadsheetApp.getUi().alert("Sheet '" + SHEET_NAME_OVERALL_ANALYSISOverall + "' not found."); return; }
  const lastRow = lastTicketRow(dataSheet);
  if (lastRow < 2) { SpreadsheetApp.getUi().alert("No ticket data available to distribute."); return; }

  const totalRows = lastRow - 1;
  const availabilityData = rosterSheet ? rosterSheet.getRange(ROSTER_RANGE).getValues() : [];
  const directory = loadAssigneeDirectory(ss);
  const roster = rosterMembersFromValues(availabilityData);
  const availableMembers = roster.availableMembers;
  const leaveMembers = roster.leaveMembers;
  const squadMemberMap = roster.squadMemberMap;
  const teamMemberMap = roster.teamMemberMap;
  const teamCanon = roster.teamCanon;
  const rosterByName = roster.rosterByName;
  const teamSquad = roster.teamSquad;
  if (availableMembers.length === 0) {
    const labelReport = labelSkillableTickets(dataSheet);
    SpreadsheetApp.getUi().alert("No members with Availability In, blank, or *first HD were found in " + ROSTER_RANGE + " of 'KTLO_Daily_Data'. CL, SL, and other submitted leave marks are skipped.\n\n" + labelReport.message);
    return;
  }

  const ticketKeys = dataSheet.getRange(2, 1, totalRows, 1).getValues();
  const assignees = dataSheet.getRange(2, 13, totalRows, 1).getValues();
  const templates = dataSheet.getRange(2, 14, totalRows, 1).getValues();
  const ticketTeams = dataSheet.getRange(2, 37, totalRows, 1).getValues();
  const colAMData = dataSheet.getRange(2, 39, totalRows, 1).getValues();
  const colAOData = dataSheet.getRange(2, 41, totalRows, 1).getValues();
  const teamBefore = {}, squadBefore = {}, templateGroups = {}, lockedAssigneeByRow = {}, keptByName = {}, leaveNameSet = {}, lockedRowsByName = {}, poolRows = [], releasedByLeave = {};
  leaveMembers.forEach(member => { leaveNameSet[member.name] = true; });
  let totalKeyed = 0, releasedFromLeave = 0;

  for (let k = 0; k < totalRows; k++) {
    if (!rosterCellText(ticketKeys[k][0])) continue;
    const isSkillEligible = isSkillableValue(colAMData[k][0], "ETSkillable") || isSkillableValue(colAOData[k][0], "CASkillable");
    if (!isSkillEligible) continue;
    totalKeyed++;
    const skillMember = rosterByName[rosterNorm(assignees[k][0])];
    if (skillMember && leaveNameSet[skillMember.name]) {
      releasedFromLeave++;
      releasedByLeave[skillMember.name] = (releasedByLeave[skillMember.name] || 0) + 1;
      poolRows.push(k);
      continue;
    }
    if (skillMember) {
      if (!lockedRowsByName[skillMember.name]) lockedRowsByName[skillMember.name] = [];
      lockedRowsByName[skillMember.name].push(k);
      continue;
    }
    poolRows.push(k);
  }

  const shareBase = totalKeyed;
  const personCap = Math.max(Math.ceil(shareBase / availableMembers.length) || 0, shareBase ? 1 : 0);
  Object.keys(lockedRowsByName).forEach(name => {
    const rows = lockedRowsByName[name];
    const keepCount = Math.min(rows.length, personCap);
    for (let i = 0; i < rows.length; i++) {
      if (i < keepCount) {
        lockedAssigneeByRow[rows[i]] = name;
        keptByName[name] = (keptByName[name] || 0) + 1;
      } else poolRows.push(rows[i]);
    }
  });

  let keptTickets = 0;
  availableMembers.forEach(member => { keptTickets += keptByName[member.name] || 0; });
  const restTickets = poolRows.length;
  poolRows.forEach(k => {
    const home = resolveTicketHome(assignees[k][0], ticketTeams[k][0], rosterByName, directory, teamCanon, teamSquad);
    const teamLabel = home.team || "Unassigned Team";
    teamBefore[teamLabel] = (teamBefore[teamLabel] || 0) + 1;
    const squadLabel = home.team ? (teamSquad[home.team] || "Unassigned Squad") : "Unassigned Squad";
    squadBefore[squadLabel] = (squadBefore[squadLabel] || 0) + 1;
    const groupKey = rosterCellText(templates[k][0]) || ("NO_TEMPLATE_" + k);
    if (!templateGroups[groupKey]) templateGroups[groupKey] = [];
    templateGroups[groupKey].push({ index: k, team: home.team, squad: home.team ? (teamSquad[home.team] || "") : "" });
  });
  Object.keys(teamMemberMap).forEach(team => { if (teamBefore[team] === undefined) teamBefore[team] = 0; });
  Object.keys(squadMemberMap).forEach(squad => { if (squadBefore[squad] === undefined) squadBefore[squad] = 0; });

  const initialCounts = {};
  availableMembers.forEach(m => { initialCounts[m.name] = keptByName[m.name] || 0; });
  const groups = Object.keys(templateGroups).map(key => {
    const rows = templateGroups[key];
    const team = topLabel(rows.reduce((counts, row) => { if (row.team) counts[row.team] = (counts[row.team] || 0) + 1; return counts; }, {}));
    return { key: key, rows: rows, size: rows.length, team: team, squad: team ? (teamSquad[team] || "") : "" };
  }).sort((a, b) => b.size - a.size || a.key.localeCompare(b.key));

  const placement = placeHierarchically(groups, availableMembers, Math.max(personCap, 1), initialCounts);
  const assignmentsAL = [];
  for (let k = 0; k < totalRows; k++) assignmentsAL.push([lockedAssigneeByRow[k] || placement.placed[k] || ""]);
  dataSheet.getRange(2, 38, totalRows, 1).setValues(assignmentsAL);
  applyExternalDateLookup(dataSheet);
  repairTeamSquadFormulas(dataSheet);
  repairTimeAndEligibilityFormulas(dataSheet);
  SpreadsheetApp.flush();
  waitForEligibilityFormulas(dataSheet);
  dataSheet.getRange(2, 1, totalRows, Math.max(dataSheet.getLastColumn(), 51)).sort([
    { column: 38, ascending: true }, { column: 39, ascending: false }, { column: 41, ascending: false }
  ]);
  SpreadsheetApp.flush();

  const teamAfter = {}, flow = {};
  Object.keys(teamMemberMap).forEach(team => { teamAfter[team] = 0; });
  groups.forEach(group => {
    group.rows.forEach(row => {
      const assignee = placement.placed[row.index];
      const member = assignee ? placement.memberByName[assignee] : null;
      const fromTeam = row.team || "Unassigned Team";
      const toTeam = member ? member.team : "Unassigned Team";
      if (teamAfter[toTeam] === undefined) teamAfter[toTeam] = 0;
      teamAfter[toTeam] += 1;
      if (fromTeam === toTeam) return;
      if (!flow[fromTeam]) flow[fromTeam] = {};
      flow[fromTeam][toTeam] = (flow[fromTeam][toTeam] || 0) + 1;
    });
  });
  const squadRank = { terran: 0, titan: 1 };
  function squadRankOf(squad) { const rank = squadRank[rosterNorm(squad)]; return rank === undefined ? 2 : rank; }
  const teamNames = Object.keys(teamBefore).concat(Object.keys(teamAfter)).filter((team, index, all) => all.indexOf(team) === index);
  teamNames.sort((a, b) => {
    const rankDiff = squadRankOf(a === "Unassigned Team" ? "" : (teamSquad[a] || "")) - squadRankOf(b === "Unassigned Team" ? "" : (teamSquad[b] || ""));
    return rankDiff !== 0 ? rankDiff : a.localeCompare(b);
  });
  const sharesByTeam = {};
  Object.keys(teamMemberMap).forEach(team => { sharesByTeam[team] = evenShares(teamBefore[team] || 0, teamMemberMap[team]); });
  const labelReport = labelSkillableTickets(dataSheet);
  writeDistributionSummary(rosterSheet, {
    keptTickets: keptTickets, restTickets: restTickets, shareBase: shareBase, personCap: personCap,
    availableMembers: availableMembers, leaveMembers: leaveMembers, teamNames: teamNames,
    teamBefore: teamBefore, teamAfter: teamAfter, teamSquad: teamSquad, teamMemberMap: teamMemberMap,
    squadMemberMap: squadMemberMap, squadRankOf: squadRankOf, flow: flow, sharesByTeam: sharesByTeam,
    keptByName: keptByName, assignedCount: placement.assignedCount,
    releasedByLeave: releasedByLeave, releasedFromLeave: releasedFromLeave,
    labelReport: labelReport
  });
}

function repairTeamSquadFormulas(dataSheet) {
  const lastRow = lastTicketRow(dataSheet);
  if (lastRow < 2) return;
  const totalRows = lastRow - 1, squadFormulas = [], teamFormulas = [];
  for (let r = 2; r <= lastRow; r++) {
    squadFormulas.push(['=IF(A' + r + '="","",IFERROR(VLOOKUP(M' + r + ',\'TeamList-2026\'!B:E,3,FALSE),""))']);
    teamFormulas.push(['=IF(A' + r + '="","",IFERROR(VLOOKUP(M' + r + ',\'TeamList-2026\'!B:D,2,FALSE),""))']);
  }
  dataSheet.getRange(2, 23, totalRows, 1).setFormulas(squadFormulas);
  dataSheet.getRange(2, 37, totalRows, 1).setFormulas(teamFormulas);
}

function repairTimeAndEligibilityFormulas(dataSheet) {
  const lastRow = lastTicketRow(dataSheet);
  if (lastRow < 2) return;
  const totalRows = lastRow - 1, timeFormulas = [], eligibilityFormulas = [], codeAdaptFormulas = [];
  dataSheet.getRange("V1").setValue("Time Taken");
  for (let r = 2; r <= lastRow; r++) {
    timeFormulas.push(['=IF(A' + r + '="","",IF(D' + r + '="","",NETWORKDAYS(D' + r + ',TODAY())))']);
    eligibilityFormulas.push(['=IF(A' + r + '="","",IF(AND(REGEXMATCH(L' + r + ',"^(Initial_)?Bill_Change(_History)?$"),AI' + r + '="Non PAD",AD' + r + '<>"Already Processed",AJ' + r + '="NON HYP_Band",AE' + r + '="Eligible",OR(AND(F' + r + '<>"HTML",F' + r + '<>"XLS"),F' + r + '=""),Y' + r + '="No issues",AA' + r + '<>"INTL_BILL"),"SKILL Eligible","Not Eligible"))']);
    codeAdaptFormulas.push(['=IF(A' + r + '="","",IF(OR(AG' + r + '="",AB' + r + '="Already processed",AA' + r + '="INTL_BILL"),"Not Eligible",IF(AND(REGEXMATCH(AG' + r + ',"Code Adapt.*"),Y' + r + '="No issues"),"SKILL Eligible","Not eligible")))']);
  }
  dataSheet.getRange(2, 22, totalRows, 1).setFormulas(timeFormulas);
  dataSheet.getRange(2, 39, totalRows, 1).setFormulas(eligibilityFormulas);
  dataSheet.getRange(2, 41, totalRows, 1).setFormulas(codeAdaptFormulas);
}

function applyMissingFormulas() {
  const dataSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME_OVERALL_ANALYSISOverall);
  if (!dataSheet) { SpreadsheetApp.getUi().alert("Error: Sheet '" + SHEET_NAME_OVERALL_ANALYSISOverall + "' not found."); return; }
  const lastRow = dataSheet.getLastRow();
  if (lastRow < 2) return;
  const totalRows = lastRow - 1;
  const ticketKeys = dataSheet.getRange(2, 1, totalRows, 1).getValues();
  const formulaMap = {
    21: '=IF(RC1="","",WEEKNUM(RC4))',
    24: '=IF(RC1="","",TODAY())',
    25: '=IF(RC1="","",IFNA(REGEXEXTRACT(RC16, "EX_FIX"), "No issues"))',
    26: '=IF(RC1="","",IFNA(REGEXEXTRACT(RC16, "YMIR404"), "No issues"))',
    27: '=IF(RC1="","",IFNA(REGEXEXTRACT(RC16, "INTL_BILL"), "REGULAR"))',
    28: '=IF(RC19<>"","Already Processed","")',
    29: '=IF(RC1="","",CONCAT(RC15,RC10))',
    30: '=IF(RC17<>"","Already Processed","")',
    31: '=IF(RC1="","",IF(AND(REGEXMATCH(RC12,"^(Initial_Bill_Change|Bill_Change|Initial_Bill_Change_History|Bill_Change_History)$"),RC2="SVC Automon Jira User",OR(RC6="PDF",RC6="")),"Eligible","Source Not Eligible"))',
    32: '=IF(RC1="","",IFNA(REGEXEXTRACT(RC16, "TOP_300"), "NON TOP300"))',
    33: '=IF(RC1="","",IFS(RC16="", "", REGEXMATCH(RC44, "Critical Error|N/A: Ymir Log Not Available\\(404\\)|N/A: Reached Threshold Bill Pages \\(>10\\)|N/A: International Bill|N/A: High Yield Providers|N/A: Automon Link Not Available|N/A: Console Log Not Available|N/A:"), "Not Eligible", RC31 <> "Eligible", "Source not eligible", AND(REGEXMATCH(RC35, "MissingChargeDetected|Charge_Extracted_Twice|OB_Missing"), RC32 = "NON TOP300", RC36 = "NON HYP_Band"), "Code Adapt Primary", AND(REGEXMATCH(RC35, "MissingChargeDetected|Charge_Extracted_Twice|OB_Missing"), RC32 = "TOP_300", RC36 = "NON HYP_Band"), "Code Adapt Secondary", RC36 = "HYP_Band", "TOP_300-Hyp", TRUE, "Code Adapt Last"))',
    34: '=IF(RC1="","",IF(RC12 = "", "", IF(REGEXMATCH(RC12, "^(Initial_)?Bill_Change(_History)?$"), "Inscope", "OutScope")))',
    35: '=IF(RC1="","",IFNA(REGEXEXTRACT(RC16, "MissingChargeDetected|STATEMENTS_IN_PRODUCTION|Charge_Extracted_Twice|OB_Missing"), "Non PAD"))',
    36: '=IF(RC1="", "", IF(OR(OR(RC14="PacificGasAndElectricTemplateProvider",RC14="SouthernCompanyTemplateProvider"), REGEXMATCH(RC16, "HYP_Band")), "HYP_Band", "NON HYP_Band"))'
  };
  for (let colIndex in formulaMap) {
    const col = parseInt(colIndex, 10);
    const existingFormulas = dataSheet.getRange(2, col, totalRows, 1).getFormulas();
    for (let r = 0; r < totalRows; r++) {
      const ticketKey = ticketKeys[r][0];
      if (ticketKey && ticketKey.toString().trim() !== "" && (!existingFormulas[r][0] || existingFormulas[r][0].trim() === "")) {
        dataSheet.getRange(r + 2, col).setFormulaR1C1(formulaMap[col]);
      }
    }
  }
  repairTeamSquadFormulas(dataSheet);
  repairTimeAndEligibilityFormulas(dataSheet);
  applyExternalDateLookup(dataSheet);
  SpreadsheetApp.flush();
}

function lastTicketRow(sheet) {
  const keys = sheet.getRange(2, 1, Math.max(sheet.getLastRow(), 2) - 1, 1).getDisplayValues();
  let last = 1;
  for (let i = 0; i < keys.length; i++) if (rosterCellText(keys[i][0])) last = i + 2;
  return last;
}

function getJiraAuthHeaders() {
  const apiToken = PropertiesService.getScriptProperties().getProperty("Jira_API_TOKEN_SK");
  if (!apiToken) return null;
  return {
    "Authorization": "Basic " + Utilities.base64Encode(JIRA_EMAIL + ":" + apiToken),
    "Accept": "application/json",
    "Content-Type": "application/json"
  };
}

function sheetHasLabel(text, label) {
  const wanted = rosterNorm(label);
  return rosterCellText(text).split(",").some(part => rosterNorm(part) === wanted);
}

function labelSkillableTickets(dataSheet) {
  const blank = { labelled: 0, already: 0, failed: 0, message: "No skill-eligible tickets to label in Jira." };
  if (!dataSheet) return blank;
  const headers = getJiraAuthHeaders();
  if (!headers) {
    blank.message = "Jira labels were not added. 'Jira_API_TOKEN_SK' was not found in Script Properties.";
    blank.failed = 1;
    return blank;
  }
  const lastRow = lastTicketRow(dataSheet);
  if (lastRow < 2) return blank;
  SpreadsheetApp.flush();
  const totalRows = lastRow - 1;
  const keys = dataSheet.getRange(2, 1, totalRows, 1).getDisplayValues();
  const existingLabels = dataSheet.getRange(2, 16, totalRows, 1).getDisplayValues();
  const amValues = dataSheet.getRange(2, 39, totalRows, 1).getDisplayValues();
  const aoValues = dataSheet.getRange(2, 41, totalRows, 1).getDisplayValues();
  const etLabel = "ETSkillable-" + currentSkillableDate();
  const caLabel = "CASkillable-" + currentSkillableDate();
  const updates = [];
  const seen = {};
  let already = 0;
  for (let i = 0; i < totalRows; i++) {
    const key = jiraIssueKey(keys[i][0]);
    if (!key || seen[key]) continue;
    const labels = [];
    if (isSkillableValue(amValues[i][0], "ETSkillable") && !sheetHasLabel(existingLabels[i][0], etLabel)) labels.push(etLabel);
    if (isSkillableValue(aoValues[i][0], "CASkillable") && !sheetHasLabel(existingLabels[i][0], caLabel)) labels.push(caLabel);
    const eligible = isSkillableValue(amValues[i][0], "ETSkillable") || isSkillableValue(aoValues[i][0], "CASkillable");
    if (!eligible) continue;
    seen[key] = true;
    if (!labels.length) { already++; continue; }
    updates.push({ key: key, labels: labels, row: i });
  }
  if (!updates.length) {
    blank.already = already;
    blank.message = already
      ? already + " tickets already had today's skill label in Jira."
      : blank.message;
    return blank;
  }
  let labelled = 0, failed = 0;
  const errors = [];
  const updatedRows = {};
  for (let i = 0; i < updates.length; i += 10) {
    const batch = updates.slice(i, i + 10);
    const requests = batch.map(item => ({
      url: "https://" + JIRA_DOMAIN + "/rest/api/3/issue/" + encodeURIComponent(item.key),
      method: "put",
      headers: headers,
      contentType: "application/json",
      payload: JSON.stringify({ update: { labels: item.labels.map(label => ({ add: label })) } }),
      muteHttpExceptions: true
    }));
    const responses = UrlFetchApp.fetchAll(requests);
    responses.forEach((response, index) => {
      const code = response.getResponseCode();
      const item = batch[index];
      if (code === 204 || code === 200) {
        labelled++;
        updatedRows[item.row] = item.labels;
        return;
      }
      failed++;
      if (errors.length < 5) errors.push(item.key + " (" + code + "): " + response.getContentText().substring(0, 180));
    });
  }
  const labelColumn = existingLabels.map((row, index) => {
    let text = rosterCellText(row[0]);
    (updatedRows[index] || []).forEach(label => {
      text = text ? text + ", " + label : label;
    });
    return [text];
  });
  dataSheet.getRange(2, 16, totalRows, 1).setValues(labelColumn);
  SpreadsheetApp.flush();
  const message = "Added today's skill label on " + labelled + " Jira tickets from column A."
    + (already ? " " + already + " already had it." : "")
    + (failed ? " " + failed + " failed.\n\n" + errors.join("\n") : "");
  if (failed) safeAlert("Jira labels", message);
  return { labelled: labelled, already: already, failed: failed, message: message };
}

function applyExternalDateLookup(dataSheet) {
  dataSheet.getRange("AY1").setFormula('=TEXT(KTLO_Daily_Data!A23,"dd-MMM")');
  const last = Math.max(1000, lastTicketRow(dataSheet));
  const formulas = [];
  for (let r = 2; r <= last; r++) {
    formulas.push(['=IF(AND(AU' + r + '<>"",AO' + r + '="Skill Eligible",AP' + r + '="Feasible"),IFNA(VLOOKUP(A' + r + ',IMPORTRANGE("' + EXTERNAL_LOOKUP_URL + '","\'"&AY$1&"\'!A:Z"),1,FALSE),""),"")']);
  }
  dataSheet.getRange(2, 51, last - 1, 1).setFormulas(formulas);
}

function indexGroupMembers(users) {
  const accountIds = {};
  const names = {};
  (users || []).forEach(user => {
    if (!user || typeof user !== "object") return;
    const displayName = rosterCellText(user.displayName || user.name);
    if (user.accountId) accountIds[user.accountId] = displayName || true;
    if (displayName) names[displayName.toLowerCase()] = displayName;
  });
  return { accountIds: accountIds, names: names };
}

function resolverCandidates(val) {
  if (val === undefined || val === null || val === "") return [];
  if (Array.isArray(val)) {
    const out = [];
    val.forEach(item => resolverCandidates(item).forEach(user => out.push(user)));
    return out;
  }
  if (typeof val === "object") {
    if (val.type === "doc") return [];
    return [{
      accountId: val.accountId || "",
      displayName: rosterCellText(val.displayName || val.name || val.value)
    }];
  }
  const displayName = rosterCellText(val);
  return displayName ? [{ accountId: "", displayName: displayName }] : [];
}

function resolverInGroup(user, groupMembers) {
  const members = groupMembers || { accountIds: {}, names: {} };
  const accountId = user && user.accountId ? user.accountId : "";
  const displayName = rosterCellText(user && user.displayName);
  if (accountId) {
    const known = members.accountIds[accountId];
    if (!known) return "";
    return displayName || (typeof known === "string" ? known : "");
  }
  if (!displayName || !members.names[displayName.toLowerCase()]) return "";
  return displayName;
}

function pickResolversInGroup(val, groupMembers) {
  const picked = [];
  const seen = {};
  resolverCandidates(val).forEach(user => {
    const name = resolverInGroup(user, groupMembers);
    if (!name) return;
    const key = user.accountId || name.toLowerCase();
    if (seen[key]) return;
    seen[key] = true;
    picked.push(name);
  });
  return picked.join(", ");
}

function changelogTime(value) {
  if (typeof value === "number") return value < 100000000000 ? value * 1000 : value;
  const text = rosterCellText(value);
  if (/^\d+$/.test(text)) return changelogTime(Number(text));
  const parsed = Date.parse(text);
  return isNaN(parsed) ? 0 : parsed;
}

function isResolverChange(item) {
  if (!item) return false;
  if (item.fieldId) return item.fieldId === RESOLVER_FIELD;
  return rosterNorm(item.field) === "resolver";
}

function changelogResolverUser(item) {
  const to = rosterCellText(item && item.to);
  const toString = rosterCellText(item && item.toString);
  const toIsAccount = to && to.toLowerCase() !== toString.toLowerCase() && to.indexOf(" ") === -1;
  return {
    accountId: toIsAccount ? to : "",
    displayName: toString || (toIsAccount ? "" : to)
  };
}

function changelogResolverEvents(histories) {
  const events = [];
  (histories || []).forEach(history => {
    const created = changelogTime(history && history.created);
    ((history && history.items) || []).forEach(item => {
      if (!isResolverChange(item)) return;
      const user = changelogResolverUser(item);
      if (!user.accountId && !user.displayName) return;
      events.push({ created: created, order: events.length, accountId: user.accountId, displayName: user.displayName });
    });
  });
  events.sort((a, b) => a.created - b.created || a.order - b.order);
  return events;
}

function sameResolver(left, right) {
  if (left.accountId && right.accountId) return left.accountId === right.accountId;
  if (!left.accountId && !right.accountId) return rosterNorm(left.displayName) === rosterNorm(right.displayName);
  return false;
}

function firstResolverInGroup(currentField, histories, groupMembers) {
  const events = changelogResolverEvents(histories);
  const ordered = events.slice();
  const currentUsers = resolverCandidates(currentField);
  if (!events.length) {
    currentUsers.forEach(user => ordered.push(user));
  } else {
    const last = events[events.length - 1];
    currentUsers.forEach(user => {
      if (!sameResolver(user, last)) ordered.push(user);
    });
  }
  for (let i = 0; i < ordered.length; i++) {
    const name = resolverInGroup(ordered[i], groupMembers);
    if (name) return name;
  }
  return "";
}

function resolverWasSet(currentField, histories) {
  if (changelogResolverEvents(histories).length) return true;
  return resolverCandidates(currentField).some(user => user.accountId || user.displayName);
}

function collectChangelogHistories(pages, idToKey) {
  const historiesByKey = {};
  (pages || []).forEach(page => {
    (page.issueChangeLogs || []).forEach(entry => {
      const key = idToKey[String(entry.issueId || "")];
      if (!key) return;
      if (!historiesByKey[key]) historiesByKey[key] = [];
      (entry.changeHistories || []).forEach(history => historiesByKey[key].push(history));
    });
  });
  return historiesByKey;
}

function fetchJiraGroupMembers(groupName, headers) {
  const users = [];
  let startAt = 0;
  const pageSize = 50;
  for (let page = 0; page < 40; page++) {
    const url = "https://" + JIRA_DOMAIN + "/rest/api/3/group/member?groupname="
      + encodeURIComponent(groupName)
      + "&includeInactiveUsers=true&startAt=" + startAt
      + "&maxResults=" + pageSize;
    const response = UrlFetchApp.fetch(url, {
      method: "get",
      headers: headers,
      muteHttpExceptions: true
    });
    const code = response.getResponseCode();
    const body = response.getContentText();
    if (code === 404) throw new Error("Jira group '" + groupName + "' was not found. " + body.substring(0, 300));
    if (code === 403) throw new Error("Jira denied access to group '" + groupName + "'. The API token needs permission to browse users and groups.");
    if (code !== 200) throw new Error("Jira group '" + groupName + "' lookup failed (" + code + "): " + body.substring(0, 500));
    let data;
    try { data = JSON.parse(body); }
    catch (e) { throw new Error("Jira group '" + groupName + "' returned invalid JSON: " + body.substring(0, 500)); }
    const values = data.values || [];
    values.forEach(user => users.push(user));
    if (data.isLast || !values.length) return indexGroupMembers(users);
    const nextStart = startAt + values.length;
    if (nextStart <= startAt) throw new Error("Jira group '" + groupName + "' repeated the same page. Stopped to avoid a loop.");
    startAt = nextStart;
  }
  throw new Error("Jira group '" + groupName + "' has more members than this run reads.");
}

function fetchResolverChangelogs(issues, headers) {
  const idToKey = {};
  const keys = [];
  (issues || []).forEach(issue => {
    const key = issue && issue.key ? String(issue.key).toUpperCase() : "";
    if (!key) return;
    keys.push(key);
    if (issue.id !== undefined && issue.id !== null && issue.id !== "") idToKey[String(issue.id)] = key;
  });
  const pages = [];
  for (let i = 0; i < keys.length; i += 100) {
    const batch = keys.slice(i, i + 100);
    let nextPageToken = "";
    for (let page = 0; page < 40; page++) {
      const payload = { issueIdsOrKeys: batch, fieldIds: [RESOLVER_FIELD], maxResults: 1000 };
      if (nextPageToken) payload.nextPageToken = nextPageToken;
      const response = UrlFetchApp.fetch("https://" + JIRA_DOMAIN + "/rest/api/3/changelog/bulkfetch", {
        method: "post",
        headers: headers,
        contentType: "application/json",
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
      const code = response.getResponseCode();
      const body = response.getContentText();
      if (code !== 200) throw new Error("Jira changelog lookup failed (" + code + "): " + body.substring(0, 500));
      let data;
      try { data = JSON.parse(body); }
      catch (e) { throw new Error("Jira changelog lookup returned invalid JSON: " + body.substring(0, 500)); }
      pages.push(data);
      if (!data.nextPageToken || data.nextPageToken === nextPageToken) break;
      nextPageToken = data.nextPageToken;
      if (page === 39) throw new Error("Resolver changelog has more pages than this run reads.");
    }
  }
  return collectChangelogHistories(pages, idToKey);
}

function fetchResolverToColumnAX() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME_OVERALL_ANALYSISOverall);
  if (!sheet) { SpreadsheetApp.getUi().alert("Error: Sheet '" + SHEET_NAME_OVERALL_ANALYSISOverall + "' not found."); return; }
  const lastRow = lastTicketRow(sheet);
  if (lastRow < 2) { SpreadsheetApp.getUi().alert("No ticket rows to update."); return; }
  const headers = getJiraAuthHeaders();
  if (!headers) { SpreadsheetApp.getUi().alert("Error: 'Jira_API_TOKEN_SK' not found in Script Properties."); return; }
  const totalRows = lastRow - 1;
  const rowKeys = sheet.getRange(2, 1, totalRows, 1).getDisplayValues().map(row => jiraIssueKey(row[0]) || rosterCellText(row[0]));
  const uniqueKeys = [], seen = {};
  rowKeys.forEach(key => { const parsed = jiraIssueKey(key); if (!parsed || seen[parsed]) return; seen[parsed] = true; uniqueKeys.push(parsed); });
  if (!uniqueKeys.length) { SpreadsheetApp.getUi().alert("No ticket keys in column A."); return; }
  const resolverByKey = {};
  let groupMembers;
  try {
    groupMembers = fetchJiraGroupMembers(RESOLVER_GROUP, headers);
    if (!Object.keys(groupMembers.accountIds).length) {
      SpreadsheetApp.getUi().alert("Jira group '" + RESOLVER_GROUP + "' has no members. Column AX was not changed.");
      return;
    }
    const issues = [];
    for (let i = 0; i < uniqueKeys.length; i += 50) {
      fetchIssuesByJql("key in (" + uniqueKeys.slice(i, i + 50).join(",") + ")", ["key", RESOLVER_FIELD], headers).issues.forEach(issue => issues.push(issue));
    }
    const historiesByKey = fetchResolverChangelogs(issues, headers);
    issues.forEach(issue => {
      const key = issue.key.toUpperCase();
      const field = (issue.fields || {})[RESOLVER_FIELD];
      const histories = historiesByKey[key] || [];
      resolverByKey[key] = {
        picked: firstResolverInGroup(field, histories, groupMembers),
        hadResolver: resolverWasSet(field, histories)
      };
    });
  } catch (e) { SpreadsheetApp.getUi().alert("Resolver fetch failed:\n" + e.message); return; }
  let kept = 0, outside = 0;
  const values = rowKeys.map(key => {
    const parsed = jiraIssueKey(key);
    const record = parsed ? resolverByKey[parsed] : null;
    if (record && record.picked) kept++;
    else if (record && record.hadResolver) outside++;
    return [record ? record.picked : ""];
  });
  sheet.getRange(1, 50).setValue("Resolver");
  sheet.getRange(2, 50, totalRows, 1).setValues(values);
  SpreadsheetApp.flush();
  ss.toast("Kept " + kept + " earliest resolvers from " + RESOLVER_GROUP + ". Left " + outside + " blank because that group never resolved them.", "Jira", 8);
}

function safeAlert(title, message) {
  try {
    const ui = SpreadsheetApp.getUi();
    if (message) ui.alert(title, message, ui.ButtonSet.OK); else ui.alert(title);
  } catch (e) { Logger.log(message ? title + "\n\n" + message : title); }
}
function escapeHtml(value) {
  return String(value === undefined || value === null ? "" : value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function flowText(map) { return Object.keys(map || {}).sort().map(name => name + ": " + map[name]).join(", "); }
function receivedText(flow, team) {
  const parts = [];
  Object.keys(flow).sort().forEach(src => { const count = (flow[src] || {})[team] || 0; if (count) parts.push(src + ": " + count); });
  return parts.join(", ");
}
function showUiTables(title, blocks) {
  const css = "body{font-family:Arial,Helvetica,sans-serif;margin:16px;color:#1f2933;font-size:13px;}h2{margin:18px 0 8px;font-size:14px;}.stats{display:flex;flex-wrap:wrap;gap:8px;}.stat{border:1px solid #d0d7de;border-radius:6px;padding:8px 12px;min-width:140px;background:#f8fafc;}.stat span{display:block;color:#52606d;font-size:11px;}.stat b{display:block;margin-top:2px;font-size:18px;}table{border-collapse:collapse;width:100%;}th,td{border:1px solid #d0d7de;padding:6px 8px;text-align:left;vertical-align:top;}th{background:#eef2f6;}tr:nth-child(even) td{background:#fafbfc;}.note{color:#52606d;margin:0 0 8px;}";
  let body = "";
  (blocks || []).forEach(block => {
    if (block.kind === "stats") {
      body += '<div class="stats">';
      (block.items || []).forEach(item => { body += '<div class="stat"><span>' + escapeHtml(item.label) + '</span><b>' + escapeHtml(item.value) + '</b></div>'; });
      body += "</div>";
      return;
    }
    body += "<h2>" + escapeHtml(block.title || "") + "</h2>";
    if (block.note) body += '<p class="note">' + escapeHtml(block.note) + "</p>";
    body += "<table><thead><tr>";
    (block.headers || []).forEach(header => { body += "<th>" + escapeHtml(header) + "</th>"; });
    body += "</tr></thead><tbody>";
    ((block.rows && block.rows.length) ? block.rows : [["None"]]).forEach(row => {
      body += "<tr>";
      row.forEach(cell => { body += "<td>" + escapeHtml(cell) + "</td>"; });
      body += "</tr>";
    });
    body += "</tbody></table>";
  });
  try {
    SpreadsheetApp.getUi().showModalDialog(HtmlService.createHtmlOutput("<!DOCTYPE html><html><head><base target=\"_top\"><style>" + css + "</style></head><body>" + body + "</body></html>").setWidth(980).setHeight(680), title);
  } catch (e) { Logger.log(title); }
}
function writeDistributionSummary(sheet, report) {
  const teamRows = [];
  report.teamNames.forEach(team => {
    const before = report.teamBefore[team] || 0, after = report.teamAfter[team] || 0;
    if (!before && !after) return;
    const memberCount = (report.teamMemberMap[team] || []).length;
    teamRows.push([team, team === "Unassigned Team" ? "Unassigned Squad" : (report.teamSquad[team] || "Unassigned Squad"), memberCount, before, formatShare(before, memberCount), after, flowText(report.flow[team]), receivedText(report.flow, team)]);
  });
  const squadRows = [];
  Object.keys(report.squadMemberMap).sort((a, b) => report.squadRankOf(a) - report.squadRankOf(b) || a.localeCompare(b)).forEach(squad => {
    const before = Object.keys(report.teamBefore).reduce((sum, team) => sum + (report.teamSquad[team] === squad ? (report.teamBefore[team] || 0) : 0), 0);
    const memberCount = report.squadMemberMap[squad].length;
    const after = Object.keys(report.teamAfter).reduce((sum, team) => sum + (report.teamSquad[team] === squad ? (report.teamAfter[team] || 0) : 0), 0);
    const squadCap = memberCount * report.personCap;
    squadRows.push([squad, memberCount, before, formatShare(before, memberCount), after, squadCap, before <= squadCap ? "Manageable" : "Shared onward"]);
  });
  const peopleRows = report.availableMembers.slice().sort((a, b) => {
    const rankDiff = report.squadRankOf(a.squad) - report.squadRankOf(b.squad);
    if (rankDiff !== 0) return rankDiff;
    if (a.team !== b.team) return a.team.localeCompare(b.team);
    return a.name.localeCompare(b.name);
  }).map(member => [member.name, member.team || "Unassigned Team", member.squad || "Unassigned Squad", report.keptByName[member.name] || 0, Math.max((report.assignedCount[member.name] || 0) - (report.keptByName[member.name] || 0), 0), report.assignedCount[member.name] || 0]);
  const leaveRows = report.leaveMembers.map(member => [member.name, member.team || "Unassigned Team", member.squad || "Unassigned Squad", (report.releasedByLeave || {})[member.name] || 0]);
  showUiTables("Before split -> After split", [
    { kind: "stats", items: [
      { label: "Kept with available assignee", value: report.keptTickets },
      { label: "Released (assignee on leave)", value: report.releasedFromLeave },
      { label: "Remaining tickets shared", value: report.restTickets },
      { label: "In, blank, or *first HD", value: report.availableMembers.length },
      { label: "Submitted leave", value: report.leaveMembers.length },
      { label: "Cap per person", value: report.personCap },
      { label: "Per head", value: formatShare(report.shareBase, report.availableMembers.length) },
      { label: "Jira labels added", value: report.labelReport ? report.labelReport.labelled : 0 },
      { label: "Jira labels already on ticket", value: report.labelReport ? report.labelReport.already : 0 }
    ]},
    { kind: "table", title: "Teams", note: "Before and After count tickets that are shared. A ticket stays with its assignee when Availability is In, blank, or *first HD, and only up to the cap.", headers: ["Team", "Squad", "Available", "Before", "Each", "After", "Shared to", "Received from"], rows: teamRows },
    { kind: "table", title: "Squads", headers: ["Squad", "Available", "Before", "Each", "After", "Cap", "Status"], rows: squadRows },
    { kind: "table", title: "Individuals", note: "Kept is limited to the cap. Remaining share is what they received. After = Kept + Remaining share.", headers: ["Name", "Team", "Squad", "Kept", "Remaining share", "After"], rows: peopleRows },
    { kind: "table", title: "Submitted leave", note: "Members with Availability In, blank, or *first HD in KTLO_Daily_Data!AF2:AL20 keep or receive tickets. CL, SL, and other submitted leave marks release their skill-eligible tickets.", headers: ["Name", "Team", "Squad", "Released"], rows: leaveRows }
  ]);
}

function populateOverallAnalysisARtoAW() {
  const lines = [];
  ["Overall-Analysis", "Overall-Analysis - Test"].forEach(sheetName => {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
    if (!sheet) { lines.push(sheetName + ": sheet not found, skipped"); return; }
    lines.push(runOctoberEodFetch({
      sheetName: sheetName,
      fields: ["customfield_19783", "customfield_19818", "customfield_19782", "customfield_19817"],
      labelPrefixes: ["etagent_", "caagent_"],
      startCol: 44,
      labelPositions: [2, 5],
      headers: [
        "EOD - AI ErrorType Agent Result",
        "EOD - AI ErrorType Engineer Result",
        "EOD - AI ErrorType Label",
        "EOD AI CodeAdapt Agent Result",
        "EOD AI CodeAdapt Engineer Result",
        "EOD AI CodeAdapt Label"
      ]
    }));
  });
  safeAlert("EOD update", lines.filter(String).join("\n\n"));
}

function populateOverallAnalysisOctARtoAW() {
  populateOverallAnalysisARtoAW();
}

function itdWhiteboardFieldValue(text, schema) {
  const custom = schema && schema.custom ? String(schema.custom) : "";
  const type = schema && schema.type ? String(schema.type) : "";
  if (custom.indexOf(":textarea") !== -1) {
    return { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: text }] }] };
  }
  if (custom.indexOf(":multiselect") !== -1 || custom.indexOf(":multicheckboxes") !== -1) {
    return text.split(",").map(part => rosterCellText(part)).filter(Boolean).map(part => ({ value: part }));
  }
  if (custom.indexOf(":select") !== -1 || custom.indexOf(":radiobuttons") !== -1 || type === "option") {
    return { value: text };
  }
  if (type === "number") {
    const numeric = Number(String(text).replace(/,/g, ""));
    return isNaN(numeric) ? text : numeric;
  }
  return text;
}

function itdWhiteboardCurrentText(fieldValue) {
  if (fieldValue && typeof fieldValue === "object" && !Array.isArray(fieldValue) && fieldValue.type === "doc") {
    return rosterCellText(extractFieldValue(fieldValue));
  }
  if (Array.isArray(fieldValue)) {
    return fieldValue.map(item => itdWhiteboardCurrentText(item)).filter(Boolean).join(", ");
  }
  if (fieldValue && typeof fieldValue === "object") {
    return rosterCellText(fieldValue.value || fieldValue.name || fieldValue.displayName || extractFieldValue(fieldValue));
  }
  return rosterCellText(extractFieldValue(fieldValue));
}

function collectColumnApUpdates(keys, apValues) {
  const wanted = {};
  const order = [];
  const rows = Math.min(keys.length, apValues.length);
  for (let i = 0; i < rows; i++) {
    const key = jiraIssueKey(keys[i] && keys[i][0]);
    const text = rosterCellText(apValues[i] && apValues[i][0]);
    if (!key || !text || wanted[key]) continue;
    wanted[key] = text;
    order.push(key);
  }
  return { wanted: wanted, order: order };
}

function fetchItdWhiteboardSchema(headers) {
  const response = UrlFetchApp.fetch("https://" + JIRA_DOMAIN + "/rest/api/3/field", {
    method: "get",
    headers: headers,
    muteHttpExceptions: true
  });
  const code = response.getResponseCode();
  const body = response.getContentText();
  if (code !== 200) throw new Error("Jira field lookup failed (" + code + "): " + body.substring(0, 300));
  let fields;
  try { fields = JSON.parse(body); }
  catch (e) { throw new Error("Jira field lookup returned invalid JSON: " + body.substring(0, 300)); }
  const field = (fields || []).filter(item => item && item.id === ITD_WHITEBOARD_FIELD)[0];
  if (!field) throw new Error("Jira field " + ITD_WHITEBOARD_FIELD + " (ITD Whiteboard) was not found.");
  return field.schema || {};
}

function updateItdWhiteboardFromColumnAP() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME_OVERALL_ANALYSISOverall);
  if (!sheet) {
    safeAlert("ITD Whiteboard", "Sheet '" + SHEET_NAME_OVERALL_ANALYSISOverall + "' was not found.");
    return;
  }
  const headers = getJiraAuthHeaders();
  if (!headers) {
    safeAlert("Missing token", "'Jira_API_TOKEN_SK' was not found in Script Properties.");
    return;
  }
  const lastRow = lastTicketRow(sheet);
  if (lastRow < 2) {
    safeAlert("ITD Whiteboard", "No ticket keys in column A of '" + SHEET_NAME_OVERALL_ANALYSISOverall + "'.");
    return;
  }
  SpreadsheetApp.flush();
  const totalRows = lastRow - 1;
  const collected = collectColumnApUpdates(
    sheet.getRange(2, 1, totalRows, 1).getDisplayValues(),
    sheet.getRange(2, OVERALL_ANALYSIS_AP_COLUMN, totalRows, 1).getDisplayValues()
  );
  if (!collected.order.length) {
    safeAlert("ITD Whiteboard", "Column AP on '" + SHEET_NAME_OVERALL_ANALYSISOverall + "' has no values to write.");
    return;
  }

  let schema;
  try { schema = fetchItdWhiteboardSchema(headers); }
  catch (e) { safeAlert("ITD Whiteboard", e.message); return; }

  const currentByKey = {};
  try {
    for (let i = 0; i < collected.order.length; i += 50) {
      const batch = collected.order.slice(i, i + 50);
      fetchIssuesByJql("key in (" + batch.join(",") + ")", [ITD_WHITEBOARD_FIELD], headers).issues.forEach(issue => {
        if (!issue || !issue.key) return;
        currentByKey[issue.key.toUpperCase()] = itdWhiteboardCurrentText((issue.fields || {})[ITD_WHITEBOARD_FIELD]);
      });
    }
  } catch (e) { safeAlert("ITD Whiteboard", e.message); return; }

  const pending = [];
  let already = 0, missing = 0;
  collected.order.forEach(key => {
    if (!Object.prototype.hasOwnProperty.call(currentByKey, key)) { missing++; return; }
    if (currentByKey[key] === collected.wanted[key]) { already++; return; }
    pending.push({ key: key, text: collected.wanted[key] });
  });
  if (!pending.length) {
    safeAlert("ITD Whiteboard", "Column AP is already on ITD Whiteboard for " + already + " tickets."
      + (missing ? " " + missing + " keys were not found in Jira." : ""));
    return;
  }

  let updated = 0, failed = 0;
  const errors = [];
  for (let i = 0; i < pending.length; i += 10) {
    const batch = pending.slice(i, i + 10);
    const requests = batch.map(item => {
      const fields = {};
      fields[ITD_WHITEBOARD_FIELD] = itdWhiteboardFieldValue(item.text, schema);
      return {
        url: "https://" + JIRA_DOMAIN + "/rest/api/3/issue/" + encodeURIComponent(item.key),
        method: "put",
        headers: headers,
        contentType: "application/json",
        payload: JSON.stringify({ fields: fields }),
        muteHttpExceptions: true
      };
    });
    const responses = UrlFetchApp.fetchAll(requests);
    responses.forEach((response, index) => {
      const code = response.getResponseCode();
      if (code === 204 || code === 200) { updated++; return; }
      failed++;
      if (errors.length < 5) errors.push(batch[index].key + " (" + code + "): " + response.getContentText().substring(0, 180));
    });
  }
  safeAlert("ITD Whiteboard", "Wrote Overall-Analysis column AP into ITD Whiteboard (" + ITD_WHITEBOARD_FIELD + ") on " + updated + " tickets."
    + (already ? " " + already + " already matched." : "")
    + (missing ? " " + missing + " keys were not found in Jira." : "")
    + (failed ? " " + failed + " failed.\n\n" + errors.join("\n") : ""));
}

function runOctoberEodFetch(config) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(config.sheetName);
  if (!sheet) return config.sheetName + ": sheet not found";
  const headers = getJiraAuthHeaders();
  if (!headers) { safeAlert("Missing token", "'Jira_API_TOKEN_SK' was not found in Script Properties."); return ""; }
  const keyColumn = findKeyColumn(sheet);
  if (!keyColumn) return config.sheetName + ": no Jira key column found.\n" + sheetPreview(sheet);

  const height = Math.max(sheet.getLastRow(), 2) - 1;
  const range = sheet.getRange(2, keyColumn, height, 1);
  const displays = range.getDisplayValues();
  const formulas = range.getFormulas();
  const values = range.getValues();
  const richText = range.getRichTextValues();
  const rowKeys = [];
  for (let i = 0; i < height; i++) {
    const richUrl = richText[i][0] ? richText[i][0].getLinkUrl() : "";
    rowKeys.push(jiraIssueKey(displays[i][0]) || jiraIssueKey(formulas[i][0]) || jiraIssueKey(values[i][0]) || jiraIssueKey(richUrl));
  }

  const today = new Date();
  const day = String(today.getDate()).padStart(2, "0");
  const monthNames = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const targetLabelNames = config.labelPrefixes.map(prefix => prefix + day + monthNames[today.getMonth()] + today.getFullYear());
  const requestedFields = config.fields.concat(["labels"]);
  const issueByKey = {}, uniqueKeys = [], seen = {};
  rowKeys.forEach(key => { if (!key || seen[key]) return; seen[key] = true; uniqueKeys.push(key); });
  if (!uniqueKeys.length) return config.sheetName + ": no Jira keys found.";

  for (let i = 0; i < uniqueKeys.length; i += 50) {
    fetchIssuesByJql("key in (" + uniqueKeys.slice(i, i + 50).join(",") + ")", requestedFields, headers).issues.forEach(issue => {
      if (issue && issue.key) issueByKey[issue.key.toUpperCase()] = issue;
    });
  }

  const numColumnsToWrite = config.fields.length + targetLabelNames.length;
  const outputValues = [];
  let successCount = 0, skippedCount = 0, missingCount = 0;
  rowKeys.forEach(issueKey => {
    if (!issueKey) { outputValues.push(new Array(numColumnsToWrite).fill("")); skippedCount++; return; }
    const issue = issueByKey[issueKey];
    if (!issue) { outputValues.push(new Array(numColumnsToWrite).fill("Not found")); missingCount++; return; }
    const fields = issue.fields || {};
    const extractedFields = config.fields.map(field => extractFieldValue(fields[field]));
    const extractedLabels = targetLabelNames.map(labelName => extractTargetLabel(fields.labels, labelName));
    const rowOutput = [];
    let fieldIdx = 0, labelIdx = 0;
    for (let pos = 0; pos < numColumnsToWrite; pos++) {
      if (config.labelPositions.indexOf(pos) !== -1) rowOutput.push(extractedLabels[labelIdx++] || "");
      else rowOutput.push(extractedFields[fieldIdx++] || "");
    }
    outputValues.push(rowOutput);
    successCount++;
  });

  const clearRows = Math.max(999, outputValues.length);
  sheet.getRange(2, config.startCol, clearRows, numColumnsToWrite).clearContent();
  if (outputValues.length) sheet.getRange(2, config.startCol, outputValues.length, numColumnsToWrite).setValues(outputValues);
  sheet.getRange(1, config.startCol, 1, numColumnsToWrite).setValues([config.headers]);
  SpreadsheetApp.flush();
  return config.sheetName + "\nKeys read from: column " + columnName(keyColumn) + "\nFirst key used: " + uniqueKeys[0] + "\nColumns written: AR to AW\nUpdated: " + successCount + "\nSkipped: " + skippedCount + "\nNot found: " + missingCount;
}

function findKeyColumn(sheet) {
  const lastCol = Math.min(Math.max(sheet.getLastColumn(), 1), 20);
  const lastRow = Math.max(sheet.getLastRow(), 2);
  const displays = sheet.getRange(1, 1, lastRow, lastCol).getDisplayValues();
  const formulas = sheet.getRange(1, 1, lastRow, lastCol).getFormulas();
  let bestCol = 0, bestCount = 0;
  for (let c = 0; c < lastCol; c++) {
    let count = 0;
    for (let r = 0; r < lastRow; r++) if (jiraIssueKey(displays[r][c]) || jiraIssueKey(formulas[r][c])) count++;
    if (count > bestCount) { bestCount = count; bestCol = c + 1; }
  }
  return bestCount > 0 ? bestCol : 0;
}

function sheetPreview(sheet) {
  const cols = Math.min(Math.max(sheet.getLastColumn(), 1), 8);
  const rows = Math.min(Math.max(sheet.getLastRow(), 1), 3);
  return sheet.getRange(1, 1, rows, cols).getDisplayValues().map((row, index) => "Row " + (index + 1) + ": " + row.join(" | ")).join("\n");
}

function jiraIssueKey(raw) {
  const text = rosterCellText(raw).replace(/[\u2010-\u2015\u2212]/g, "-");
  const match = text.match(/[A-Z][A-Z0-9_]+-\d+/i);
  return match ? match[0].toUpperCase() : "";
}

function extractTargetLabel(labelsArray, targetLabel) {
  if (!Array.isArray(labelsArray) || labelsArray.length === 0) return "";
  const found = labelsArray.find(label => String(label).trim().toLowerCase() === targetLabel);
  return found || "";
}

function columnName(index) {
  let name = "", n = index;
  while (n > 0) { const rem = (n - 1) % 26; name = String.fromCharCode(65 + rem) + name; n = Math.floor((n - 1) / 26); }
  return name;
}
