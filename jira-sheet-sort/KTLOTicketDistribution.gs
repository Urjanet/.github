// Sheet Names
const SHEET_NAME_KTLO_DAILYtest = 'KTLO_Daily_Data';
const SHEET_NAME_OVERALL_TESTText = 'Overall-Analysis - Test2';

const JIRA_DOMAIN = "arcadiapower.atlassian.net";
const JIRA_EMAIL = "sowmiya.kirubakaran@arcadia.com";
const JIRA_SEARCH_PAGE_SIZE = 100;
const JIRA_SEARCH_MAX_PAGES = 50;

/**
 * Automatically creates a custom menu in Google Sheets when opened.
 */
function onOpen() {
  try {
    const ui = SpreadsheetApp.getUi();
    ui.createMenu('KTLO Skill - Ticket Distribution')
      .addItem('Overall Fetch Jira Tickets & Distribute', 'fetchJiraDataFromB27Query')
      .addItem('Run Hierarchical Distribution & Sort Only', 'distributeTickets')
      .addItem('Code Adapt Update', 'fetchJiraDataFromB28Query')
      .addToUi();
  } catch (e) {
    Logger.log("Skipped UI creation: Executed outside active sheet UI context.");
  }
}

/**
 * Parses Jira fields, including Atlassian Document Format (ADF) JSON objects.
 */
function extractFieldValue(val) {
  if (val === undefined || val === null) return "";

  if (Array.isArray(val)) {
    return val.map(item => extractFieldValue(item)).filter(String).join(", ");
  }

  if (typeof val === 'object') {
    if (val.type === 'doc' && Array.isArray(val.content)) {
      var textParts = [];
      function extractAdfText(node) {
        if (!node) return;
        if (node.type === 'text' && node.text) {
          textParts.push(node.text);
        }
        if (Array.isArray(node.content)) {
          node.content.forEach(extractAdfText);
        }
      }
      val.content.forEach(extractAdfText);
      return textParts.join(" ").trim();
    }

    return val.displayName || val.value || val.name || JSON.stringify(val);
  }

  if (typeof val === 'string' && val.trim().startsWith('{"type":"doc"')) {
    try {
      var parsedObj = JSON.parse(val);
      return extractFieldValue(parsedObj);
    } catch (e) {
      return val;
    }
  }

  return val;
}

/**
 * Runs the evaluated JQL in KTLO_Daily_Data!B27 against Jira Cloud search,
 * writes the matching issues to columns A-T, then fills formulas and distributes.
 */
function fetchJiraDataFromB27Query() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ktloSheet = ss.getSheetByName(SHEET_NAME_KTLO_DAILYtest);
  const targetSheet = ss.getSheetByName(SHEET_NAME_OVERALL_TESTText);

  if (!ktloSheet) {
    SpreadsheetApp.getUi().alert(`Error: Sheet '${SHEET_NAME_KTLO_DAILYtest}' not found.`);
    return;
  }
  if (!targetSheet) {
    SpreadsheetApp.getUi().alert(`Error: Sheet '${SHEET_NAME_OVERALL_TESTText}' not found.`);
    return;
  }

  const jqlCell = ktloSheet.getRange("B27");
  let jqlQuery = jqlCell.getDisplayValue().toString().trim();
  if (!jqlQuery) {
    jqlQuery = jqlCell.getValue().toString().trim();
  }
  if (!jqlQuery) {
    SpreadsheetApp.getUi().alert(`Error: Formula in cell B27 of '${SHEET_NAME_KTLO_DAILYtest}' returned empty text.`);
    return;
  }

  const scriptProperties = PropertiesService.getScriptProperties();
  const API_TOKEN = scriptProperties.getProperty('Jira_API_TOKEN_SK');

  if (!API_TOKEN) {
    SpreadsheetApp.getUi().alert("Error: 'Jira_API_TOKEN_SK' not found in Script Properties.");
    return;
  }

  const headers = {
    "Authorization": "Basic " + Utilities.base64Encode(JIRA_EMAIL + ":" + API_TOKEN),
    "Accept": "application/json",
    "Content-Type": "application/json"
  };

  const requestedFields = [
    "key", "reporter", "status", "created", "duedate",
    "customfield_11168", "customfield_15610", "customfield_11271", "customfield_11183",
    "customfield_11772", "customfield_11178", "customfield_11171", "assignee",
    "customfield_12282", "customfield_12284", "labels",
    "customfield_19783", "customfield_19818", "customfield_19782", "customfield_19817"
  ];

  let searchResult;
  try {
    searchResult = fetchIssuesByJql(jqlQuery, requestedFields, headers);
  } catch (e) {
    SpreadsheetApp.getUi().alert("Jira search using B27 failed:\n" + e.message);
    return;
  }

  const issues = searchResult.issues;
  if (issues.length === 0) {
    SpreadsheetApp.getUi().alert("B27 JQL returned no issues. Existing ticket rows were left unchanged.\n\n" + jqlQuery.substring(0, 500));
    return;
  }

  const rowsToInsert = issues.map(issueToRow);

  const targetLastRow = targetSheet.getLastRow();
  if (targetLastRow > 1) {
    targetSheet.getRange(2, 1, targetLastRow - 1, 20).clearContent();
  }

  targetSheet.getRange(2, 1, rowsToInsert.length, 20).setValues(rowsToInsert);
  SpreadsheetApp.flush();

  if (searchResult.truncated) {
    SpreadsheetApp.getUi().alert(
      "Loaded the first " + rowsToInsert.length + " issues from B27. The JQL has more pages than this run keeps (" +
      (JIRA_SEARCH_MAX_PAGES * JIRA_SEARCH_PAGE_SIZE) + ")."
    );
  } else {
    ss.toast("Loaded " + rowsToInsert.length + " issues from the B27 JQL.", "Jira", 5);
  }

  applyMissingFormulas();
  waitForEligibilityFormulas(targetSheet);
  distributeTickets();
}

/**
 * Column AM/AO are sheet formulas. Distribution reads them as values, so wait
 * until the first ticket row has calculated before sorting and assigning.
 */
function waitForEligibilityFormulas(sheet) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    SpreadsheetApp.flush();
    const eligibility = sheet.getRange("AM2").getDisplayValue().toString().trim();
    if (eligibility) return;
    Utilities.sleep(1000);
  }
  Logger.log("Timed out waiting for column AM formulas to calculate.");
}

/**
 * POSTs the B27 JQL to /rest/api/3/search/jql and follows nextPageToken.
 * The JQL string is sent unchanged on every page.
 */
function fetchIssuesByJql(jqlQuery, requestedFields, headers) {
  const searchUrl = "https://" + JIRA_DOMAIN + "/rest/api/3/search/jql";
  const issues = [];
  const seenKeys = {};
  let nextPageToken = "";

  for (let page = 0; page < JIRA_SEARCH_MAX_PAGES; page++) {
    const payload = {
      jql: jqlQuery,
      maxResults: JIRA_SEARCH_PAGE_SIZE,
      fields: requestedFields
    };
    if (nextPageToken) {
      payload.nextPageToken = nextPageToken;
    }

    const response = UrlFetchApp.fetch(searchUrl, {
      method: "post",
      headers: headers,
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    const code = response.getResponseCode();
    const body = response.getContentText();
    if (code !== 200) {
      throw new Error("Jira search failed (" + code + "): " + body.substring(0, 500));
    }

    let data;
    try {
      data = JSON.parse(body);
    } catch (e) {
      throw new Error("Jira search returned invalid JSON: " + body.substring(0, 500));
    }

    const pageIssues = data.issues || [];
    pageIssues.forEach(issue => {
      const key = issue && issue.key;
      if (!key || seenKeys[key]) return;
      seenKeys[key] = true;
      issues.push(issue);
    });

    if (data.isLast || !data.nextPageToken) {
      return { issues: issues, truncated: false };
    }
    if (data.nextPageToken === nextPageToken) {
      throw new Error("Jira search repeated the same page token. Stopped to avoid a loop.");
    }
    nextPageToken = data.nextPageToken;
  }

  return { issues: issues, truncated: true };
}

function issueToRow(issue) {
  const key = issue.key;
  const keyHyperlink = `=HYPERLINK("https://${JIRA_DOMAIN}/browse/${key}", "${key}")`;
  const f = issue.fields || {};
  return [
    keyHyperlink,
    extractFieldValue(f.reporter),
    extractFieldValue(f.status),
    f.created ? f.created.substring(0, 10) : "",
    f.duedate || "",
    extractFieldValue(f.customfield_11168),
    extractFieldValue(f.customfield_15610),
    extractFieldValue(f.customfield_11271),
    extractFieldValue(f.customfield_11183),
    extractFieldValue(f.customfield_11772),
    extractFieldValue(f.customfield_11178),
    extractFieldValue(f.customfield_11171),
    extractFieldValue(f.assignee),
    extractFieldValue(f.customfield_12282), // Column N: Search Template Provider
    extractFieldValue(f.customfield_12284),
    extractFieldValue(f.labels),
    extractFieldValue(f.customfield_19783),
    extractFieldValue(f.customfield_19818),
    extractFieldValue(f.customfield_19782),
    extractFieldValue(f.customfield_19817)
  ];
}

function rosterCellText(value) {
  return value === undefined || value === null ? "" : value.toString().trim();
}

function rosterNorm(value) {
  return rosterCellText(value).toLowerCase();
}

var ROSTER_HARD_LEAVE = ["pl", "cl", "sl", "fl", "al", "leave", "on leave", "absent", "unavailable", "not available", "not planned"];

function rosterMarksLeave(status) {
  return ROSTER_HARD_LEAVE.indexOf(status) !== -1;
}

/**
 * Attendance columns in AE2:AK20 are: date, Availability, Not planned.
 * "Not planned" = No means the person is planned and stays in the share.
 */
function memberIsOnLeave(attendance, availability, notPlanned) {
  const day = rosterNorm(attendance);
  const avail = rosterNorm(availability);
  const planned = rosterNorm(notPlanned);

  if (rosterMarksLeave(day) || day === "no" || day === "n" || day === "0") return true;
  if (rosterMarksLeave(avail) || avail === "no" || avail === "n" || avail === "0") return true;
  if (rosterMarksLeave(planned) || planned === "yes" || planned === "y" || planned === "1" || planned === "true") return true;
  return false;
}

function rememberLabel(canonByNorm, raw) {
  const display = rosterCellText(raw);
  if (!display) return "";
  const key = display.toLowerCase();
  if (!canonByNorm[key]) canonByNorm[key] = display;
  return canonByNorm[key];
}

function canonicalLabel(canonByNorm, raw) {
  const display = rosterCellText(raw);
  if (!display) return "";
  return canonByNorm[display.toLowerCase()] || display;
}

function addMemberToGroup(groupMap, groupName, memberName) {
  if (!groupName) return;
  if (!groupMap[groupName]) groupMap[groupName] = [];
  groupMap[groupName].push(memberName);
}

function majorityLabel(rowIndexes, columnValues, canonByNorm) {
  const counts = {};
  rowIndexes.forEach(idx => {
    const label = canonicalLabel(canonByNorm, columnValues[idx][0]);
    if (!label) return;
    counts[label] = (counts[label] || 0) + 1;
  });

  let best = "";
  let bestCount = 0;
  Object.keys(counts).forEach(label => {
    if (counts[label] > bestCount) {
      best = label;
      bestCount = counts[label];
    }
  });
  return best;
}

function leastLoadedName(names, assignedCount) {
  if (!names || names.length === 0) return "";
  const sorted = names.slice().sort((a, b) => {
    const diff = (assignedCount[a] || 0) - (assignedCount[b] || 0);
    return diff !== 0 ? diff : a.localeCompare(b);
  });
  return sorted[0];
}

function pickUnderCap(names, batchSize, cap, assignedCount) {
  if (!names || names.length === 0 || batchSize > cap) return "";
  const sorted = names.slice().sort((a, b) => {
    const diff = (assignedCount[a] || 0) - (assignedCount[b] || 0);
    return diff !== 0 ? diff : a.localeCompare(b);
  });
  const under = sorted.filter(name => (assignedCount[name] || 0) + batchSize <= cap);
  return under.length ? under[0] : "";
}

/**
 * Fill the ticket's team up to its equal share, then the squad, then everyone.
 * A template batch is never split: one person receives the whole group.
 */
function chooseAssignee(teamNames, squadNames, allNames, batchSize, teamCap, globalCap, assignedCount) {
  return pickUnderCap(teamNames, batchSize, teamCap, assignedCount)
    || pickUnderCap(squadNames, batchSize, globalCap, assignedCount)
    || pickUnderCap(allNames, batchSize, globalCap, assignedCount)
    || leastLoadedName(teamNames, assignedCount)
    || leastLoadedName(squadNames, assignedCount)
    || leastLoadedName(allNames, assignedCount);
}

function formatShare(numerator, denominator) {
  if (!denominator) return "0";
  const value = numerator / denominator;
  return value === Math.round(value) ? String(value) : value.toFixed(2);
}

/**
 * Template-grouped ticket distribution.
 * Roster AE2:AK20 columns: Team, Member, attendance date, Availability, Not planned, Member, Squad.
 * Ticket team is column AK. Same column N template stays with one person.
 * Share within that team, then that squad, then all available members.
 * Leave members are excluded from the share and listed as disabled in the summary.
 */
function distributeTickets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const dataSheet = ss.getSheetByName(SHEET_NAME_OVERALL_TESTText);
  const rosterSheet = ss.getSheetByName(SHEET_NAME_KTLO_DAILYtest);

  if (!dataSheet) {
    SpreadsheetApp.getUi().alert(`Sheet '${SHEET_NAME_OVERALL_TESTText}' not found.`);
    return;
  }

  const lastRow = dataSheet.getLastRow();
  if (lastRow < 2) {
    SpreadsheetApp.getUi().alert("No ticket data available to distribute.");
    return;
  }

  const totalRows = lastRow - 1;
  const availabilityData = rosterSheet ? rosterSheet.getRange("AE2:AK20").getValues() : [];

  const availableMembers = [];
  const leaveMembers = [];
  const squadMemberMap = {};
  const teamMemberMap = {};
  const teamCanon = {};
  const squadCanon = {};
  const seenNames = {};

  for (let i = 0; i < availabilityData.length; i++) {
    const row = availabilityData[i];
    const team = rememberLabel(teamCanon, row[0]);
    let name = rosterCellText(row[1]);
    if (!name) name = rosterCellText(row[5]);
    const squad = rememberLabel(squadCanon, row[6]);
    if (!name || seenNames[name.toLowerCase()]) continue;
    seenNames[name.toLowerCase()] = true;

    const person = { name: name, squad: squad, team: team };
    if (memberIsOnLeave(row[2], row[3], row[4])) {
      leaveMembers.push(person);
      continue;
    }

    availableMembers.push(person);
    addMemberToGroup(teamMemberMap, team, name);
    addMemberToGroup(squadMemberMap, squad, name);
  }

  if (availableMembers.length === 0) {
    SpreadsheetApp.getUi().alert("No available team members found in AE2:AK20 of 'KTLO_Daily_Data'.");
    return;
  }

  const ticketKeys = dataSheet.getRange(2, 1, totalRows, 1).getValues();
  const templates = dataSheet.getRange(2, 14, totalRows, 1).getValues();
  const ticketSquads = dataSheet.getRange(2, 23, totalRows, 1).getValues();
  const ticketTeams = dataSheet.getRange(2, 37, totalRows, 1).getValues();
  const colAMData = dataSheet.getRange(2, 39, totalRows, 1).getValues();
  const colAOData = dataSheet.getRange(2, 41, totalRows, 1).getValues();

  const initialCalculatedCount = {};
  const finalAssignedCount = {};
  availableMembers.forEach(m => {
    initialCalculatedCount[m.name] = 0;
    finalAssignedCount[m.name] = 0;
  });

  let totalEligibleTickets = 0;
  const templateGroups = {};
  const teamBefore = {};
  const squadBefore = {};

  for (let k = 0; k < totalRows; k++) {
    const key = rosterCellText(ticketKeys[k][0]);
    const templateName = rosterCellText(templates[k][0]);
    const amVal = rosterNorm(colAMData[k][0]);
    const aoVal = rosterNorm(colAOData[k][0]);
    const isSkillEligible = amVal === "skill eligible" || aoVal === "skill eligible";
    if (!key || !isSkillEligible) continue;

    totalEligibleTickets++;
    const groupKey = templateName || `NO_TEMPLATE_${k}`;
    if (!templateGroups[groupKey]) templateGroups[groupKey] = [];
    templateGroups[groupKey].push(k);

    const teamLabel = canonicalLabel(teamCanon, ticketTeams[k][0]) || "Unassigned Team";
    const squadLabel = canonicalLabel(squadCanon, ticketSquads[k][0]) || "Unassigned Squad";
    teamBefore[teamLabel] = (teamBefore[teamLabel] || 0) + 1;
    squadBefore[squadLabel] = (squadBefore[squadLabel] || 0) + 1;
  }

  availableMembers.forEach(m => {
    const teamLabel = m.team || "Unassigned Team";
    const squadLabel = m.squad || "Unassigned Squad";
    const mates = teamMemberMap[m.team] || [];
    const teamTickets = teamBefore[teamLabel] || 0;
    initialCalculatedCount[m.name] = mates.length ? Math.round(teamTickets / mates.length) : 0;
    if (teamBefore[teamLabel] === undefined) teamBefore[teamLabel] = 0;
    if (squadBefore[squadLabel] === undefined) squadBefore[squadLabel] = 0;
  });

  const globalCap = Math.max(Math.ceil(totalEligibleTickets / availableMembers.length), 1);
  const allNames = availableMembers.map(m => m.name);
  const assignedMemberByRow = {};

  const sortedTemplateKeys = Object.keys(templateGroups).sort((a, b) => {
    return templateGroups[b].length - templateGroups[a].length;
  });

  sortedTemplateKeys.forEach(groupKey => {
    const rowIndices = templateGroups[groupKey];
    const batchSize = rowIndices.length;
    const templateTeam = majorityLabel(rowIndices, ticketTeams, teamCanon);
    const templateSquad = majorityLabel(rowIndices, ticketSquads, squadCanon);
    const teamNames = templateTeam ? (teamMemberMap[templateTeam] || []) : [];
    const squadNames = templateSquad ? (squadMemberMap[templateSquad] || []) : [];
    const teamTickets = teamBefore[templateTeam] || batchSize;
    const teamCap = Math.max(Math.ceil(teamTickets / Math.max(teamNames.length, 1)), 1);

    const chosenMember = chooseAssignee(
      teamNames,
      squadNames,
      allNames,
      batchSize,
      teamCap,
      globalCap,
      finalAssignedCount
    );

    rowIndices.forEach(rIdx => {
      assignedMemberByRow[rIdx] = chosenMember;
    });
    finalAssignedCount[chosenMember] += batchSize;
  });

  const assignmentsAL = [];
  for (let k = 0; k < totalRows; k++) {
    assignmentsAL.push([assignedMemberByRow[k] || ""]);
  }

  dataSheet.getRange(2, 38, totalRows, 1).setValues(assignmentsAL);
  SpreadsheetApp.flush();

  const maxColumn = dataSheet.getLastColumn();
  dataSheet.getRange(2, 1, totalRows, maxColumn).sort([
    { column: 38, ascending: true },
    { column: 41, ascending: false },
    { column: 39, ascending: false }
  ]);

  const teamAfter = {};
  const squadAfter = {};
  availableMembers.forEach(m => {
    const teamLabel = m.team || "Unassigned Team";
    const squadLabel = m.squad || "Unassigned Squad";
    if (!teamAfter[teamLabel]) teamAfter[teamLabel] = 0;
    if (!squadAfter[squadLabel]) squadAfter[squadLabel] = 0;
    teamAfter[teamLabel] += finalAssignedCount[m.name];
    squadAfter[squadLabel] += finalAssignedCount[m.name];
    if (teamBefore[teamLabel] === undefined) teamBefore[teamLabel] = 0;
    if (squadBefore[squadLabel] === undefined) squadBefore[squadLabel] = 0;
  });

  let summaryText = `Total Eligible Tickets: ${totalEligibleTickets}\n`;
  summaryText += `Available Members: ${availableMembers.length}\n`;
  summaryText += `On Leave (disabled): ${leaveMembers.length}\n`;
  summaryText += `Per head count: ${totalEligibleTickets} / ${availableMembers.length} = ${formatShare(totalEligibleTickets, availableMembers.length)}\n`;
  summaryText += `Total Unique Template Providers: ${sortedTemplateKeys.length}\n\n`;

  summaryText += `=== TEAM BREAKDOWN (from column AK) ===\n`;
  Object.keys(teamBefore).sort().forEach(team => {
    const after = teamAfter[team] || 0;
    summaryText += `Team ${team}: Before = ${teamBefore[team]} -> After = ${after}\n`;
  });

  summaryText += `\n=== SQUAD BREAKDOWN ===\n`;
  Object.keys(squadBefore).sort().forEach(squad => {
    const after = squadAfter[squad] || 0;
    summaryText += `Squad ${squad}: Before = ${squadBefore[squad]} -> After = ${after}\n`;
  });

  summaryText += `\n=== INDIVIDUAL MEMBER BREAKDOWN ===\n`;
  availableMembers.forEach(m => {
    summaryText += `${m.name} [Squad: ${m.squad || "Unassigned Squad"} | Team: ${m.team || "Unassigned Team"}]: Before = ${initialCalculatedCount[m.name]} -> After = ${finalAssignedCount[m.name]}\n`;
  });

  summaryText += `\n=== ON LEAVE (disabled, excluded from sharing) ===\n`;
  if (leaveMembers.length === 0) {
    summaryText += "None\n";
  } else {
    leaveMembers.forEach(m => {
      summaryText += `${m.name} [Squad: ${m.squad || "Unassigned Squad"} | Team: ${m.team || "Unassigned Team"}]: On leave — disabled\n`;
    });
  }

  Logger.log(summaryText);
  SpreadsheetApp.getUi().alert("Ticket Distribution Summary (Template Grouped)", summaryText, SpreadsheetApp.getUi().ButtonSet.OK);
}

/**
 * Checks Columns U through AO for missing formulas and applies standard R1C1 formulas.
 */
function applyMissingFormulas() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const dataSheet = ss.getSheetByName(SHEET_NAME_OVERALL_TESTText);

  if (!dataSheet) {
    SpreadsheetApp.getUi().alert(`Error: Sheet '${SHEET_NAME_OVERALL_TESTText}' not found.`);
    return;
  }

  const lastRow = dataSheet.getLastRow();
  if (lastRow < 2) return;

  const totalRows = lastRow - 1;
  const ticketKeys = dataSheet.getRange(2, 1, totalRows, 1).getValues();

  const formulaMap = {
    21: '=IF(RC1="","",WEEKNUM(RC4))',                                                                  // Col U  (Created Week)
    22: '=IF(RC1="","",WEEKNUM(RC5))',                                                                  // Col V  (Due date Week)
    23: '=IF(RC1="","",VLOOKUP(RC13,\'TeamList-2026\'!B:E,3,FALSE))',                                   // Col W  (Squad)
    24: '=IF(RC1="","",TODAY())',                                                                       // Col X  (Current Date)
    25: '=IF(RC1="","",IFS(RC5<RC24,"1-Past Due",RC5<RC24+1,"2-Current Due",RC5>RC24+1,"4-Future Due",RC5>RC24,"3-Due Tommorow"))', // Col Y
    26: '=IF(RC1="","",IF(RC16="", "", IFNA(REGEXEXTRACT(RC16, "YMIR404"), "No issues")))',              // Col Z  (Template Count)
    27: '=IF(RC1="","",IF(RC16="", "", IFNA(REGEXEXTRACT(RC16, "INTL_BILL"), "REGULAR")))',             // Col AA (Bill Type)
    28: '=IF(RC19<>"","Already Processed","")',                                                          // Col AB (Processed via CA?)
    29: '=IF(RC1="","",CONCAT(RC15,RC10))',                                                             // Col AC (Customer)
    30: '=IF(RC17<>"","Already Processed","")',                                                          // Col AD (Processed via ET?)
    31: '=IF(RC1="","",IF(AND(REGEXMATCH(RC12,"^(Initial_Bill_Change|Bill_Change|Initial_Bill_Change_History|Bill_Change_History)$"),RC2="SVC Automon Jira User",OR(RC6="PDF",RC6="")),"Eligible","Source Not Eligible"))', // Col AE
    32: '=IF(RC1="","",IF(RC16="", "", IFNA(REGEXEXTRACT(RC16, "TOP_300"), "NON TOP300")))',            // Col AF (BAND)
    33: '=IF(RC1="","",IFS(RC16="", "", REGEXMATCH(RC44, "Critical Error|N/A: Ymir Log Not Available\\(404\\)|N/A: Reached Threshold Bill Pages \\(>10\\)|N/A: International Bill|N/A: High Yield Providers|N/A: Automon Link Not Available|N/A: Console Log Not Available|N/A"), "Not Eligible", RC31 <> "Eligible", "Source not eligible", AND(REGEXMATCH(RC35, "MissingChargeDetected|Charge_Extracted_Twice|OB_Missing"), RC32 = "NON TOP300", RC36 = "NON HYP_Band"), "Code Adapt Primary", AND(REGEXMATCH(RC35, "MissingChargeDetected|Charge_Extracted_Twice|OB_Missing"), RC32 = "TOP_300", RC36 = "NON HYP_Band"), "Code Adapt Secondary", RC36 = "HYP_Band", "TOP_300-Hyp", TRUE, "Code Adapt Last"))', // Col AG
    34: '=IF(RC1="","",IF(RC12 = "", "", IF(REGEXMATCH(RC12, "^(Initial_)?Bill_Change(_History)?$"), "Inscope", "OutScope")))', // Col AH
    35: '=IF(RC1="","",IF(RC16="", "", IFNA(REGEXEXTRACT(RC16, "MissingChargeDetected|STATEMENTS_IN_PRODUCTION|Charge_Extracted_Twice|OB_Missing"), "Non PAD")))', // Col AI
    36: '=IF(RC1="", "", IF(OR(OR(RC14="PacificGasAndElectricTemplateProvider",RC14="SouthernCompanyTemplateProvider"), REGEXMATCH(RC16, "HYP_Band")), "HYP_Band", "NON HYP_Band"))', // Col AJ
    37: '=IFERROR(VLOOKUP(RC13, \'TeamList-2026\'!B:D, 2, FALSE))',                                      // Col AK (Team)
    39: '=IF(RC1="","",IF(AND(REGEXMATCH(RC12, "^(Initial_)?Bill_Change(_History)?$"), RC35 = "Non PAD", RC30 <> "Already Processed", RC36 = "NON HYP_Band", RC31 = "Eligible", OR(AND(RC6 <> "HTML", RC7 <> "XLS"), RC7 = "")), "SKILL Eligible", "Not Eligible"))', // Col AM
    41: '=IF(RC1="","",IF(OR(RC33 = "", RC28 = "Already processed"), "Not Eligible", IF(REGEXMATCH(RC33, "Code Adapt.*"), "SKILL Eligible", "Not eligible")))' // Col AO
  };

  for (let colIndex in formulaMap) {
    const col = parseInt(colIndex);
    const formulaString = formulaMap[col];
    const range = dataSheet.getRange(2, col, totalRows, 1);
    const existingFormulas = range.getFormulas();

    for (let r = 0; r < totalRows; r++) {
      const ticketKey = ticketKeys[r][0];
      if (ticketKey && ticketKey.toString().trim() !== "") {
        const currentFormula = existingFormulas[r][0];
        if (!currentFormula || currentFormula.trim() === "") {
          dataSheet.getRange(r + 2, col).setFormulaR1C1(formulaString);
        }
      }
    }
  }

  SpreadsheetApp.flush();
}
