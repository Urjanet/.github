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

/**
 * 2. Template-Grouped Hierarchical Ticket Distribution Engine
 *    - Keeps all tickets with the same Template Provider (Column N) assigned to the SAME member.
 *    - Respects Leave filtering from Range AE2:AK20.
 *    - Applies Squad -> Team -> Cross-Team Priority Allocation.
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

  // Read AE2:AK20 range (7 columns: AE: Squad, AF: Name, AG..AJ: Leave Columns, AK: Team)
  const availabilityData = rosterSheet ? rosterSheet.getRange("AE2:AK20").getValues() : [];

  const availableMembers = [];
  const squadMemberMap = {};   // Squad -> Member Names
  const teamMemberMap = {};    // Team -> Member Names

  const leaveCodes = ["pl", "cl", "sl", "fl", "al", "leave", "absent", "no", "0", "not planned"];

  for (let i = 0; i < availabilityData.length; i++) {
    const squad = availabilityData[i][0] ? availabilityData[i][0].toString().trim() : "";
    const name = availabilityData[i][1] ? availabilityData[i][1].toString().trim() : "";
    const team = availabilityData[i][6] ? availabilityData[i][6].toString().trim() : ""; // Col AK

    if (name !== "") {
      let isAvailable = true;

      // Check leave status across columns AG to AJ (indices 2 to 5)
      for (let j = 2; j <= 5; j++) {
        const status = availabilityData[i][j] ? availabilityData[i][j].toString().toLowerCase().trim() : "";
        if (leaveCodes.includes(status)) {
          isAvailable = false;
          break;
        }
      }

      if (isAvailable) {
        availableMembers.push({ name: name, squad: squad, team: team });

        if (squad !== "") {
          if (!squadMemberMap[squad]) squadMemberMap[squad] = [];
          squadMemberMap[squad].push(name);
        }

        if (team !== "") {
          if (!teamMemberMap[team]) teamMemberMap[team] = [];
          teamMemberMap[team].push(name);
        }
      }
    }
  }

  if (availableMembers.length === 0) {
    SpreadsheetApp.getUi().alert("No available team members found in AE2:AK20 of 'KTLO_Daily_Data'.");
    return;
  }

  // Read ticket data from Overall-Analysis - Test2
  const ticketKeys = dataSheet.getRange(2, 1, totalRows, 1).getValues();      // Col A: Key
  const templates = dataSheet.getRange(2, 14, totalRows, 1).getValues();      // Col N: Search Template
  const ticketSquads = dataSheet.getRange(2, 23, totalRows, 1).getValues();  // Col W: Squad
  const ticketTeams = dataSheet.getRange(2, 37, totalRows, 1).getValues();   // Col AK: Team
  const colAMData = dataSheet.getRange(2, 39, totalRows, 1).getValues();    // Col AM: Error Type
  const colAOData = dataSheet.getRange(2, 41, totalRows, 1).getValues();    // Col AO: Code Adapt

  const initialCalculatedCount = {};
  const finalAssignedCount = {};

  availableMembers.forEach(m => {
    initialCalculatedCount[m.name] = 0;
    finalAssignedCount[m.name] = 0;
  });

  let totalEligibleTickets = 0;

  // Group eligible tickets by Template Provider (Col N)
  // templateGroups = { "TemplateName": [rowIndexes] }
  const templateGroups = {};
  const rowToTemplateKey = {};

  for (let k = 0; k < totalRows; k++) {
    const key = ticketKeys[k][0] ? ticketKeys[k][0].toString().trim() : "";
    const tName = templates[k][0] ? templates[k][0].toString().trim() : "";
    const ticketSquad = ticketSquads[k][0] ? ticketSquads[k][0].toString().trim() : "";
    const amVal = colAMData[k][0] ? colAMData[k][0].toString().trim().toLowerCase() : "";
    const aoVal = colAOData[k][0] ? colAOData[k][0].toString().trim().toLowerCase() : "";

    const isSkillEligible = (amVal === "skill eligible" || aoVal === "skill eligible");

    if (key !== "" && isSkillEligible) {
      totalEligibleTickets++;

      // Use template name or fallback to unique row index if blank
      const groupKey = tName !== "" ? tName : `NO_TEMPLATE_${k}`;
      if (!templateGroups[groupKey]) {
        templateGroups[groupKey] = [];
      }
      templateGroups[groupKey].push(k);
      rowToTemplateKey[k] = groupKey;

      // Calculate initial origin count for squad members
      const squadMembers = (ticketSquad && squadMemberMap[ticketSquad]) ? squadMemberMap[ticketSquad] : [];
      if (squadMembers.length > 0) {
        const share = 1 / squadMembers.length;
        squadMembers.forEach(mName => {
          if (initialCalculatedCount[mName] !== undefined) {
            initialCalculatedCount[mName] += share;
          }
        });
      }
    }
  }

  availableMembers.forEach(m => {
    initialCalculatedCount[m.name] = Math.round(initialCalculatedCount[m.name]);
  });

  const FAIR_CAP = Math.max(Math.ceil(totalEligibleTickets / availableMembers.length), 1);

  // Map to store chosen assignee per row index
  const assignedMemberByRow = {};

  // Sort template groups by size (descending) to allocate larger template clusters first
  const sortedTemplateKeys = Object.keys(templateGroups).sort((a, b) => {
    return templateGroups[b].length - templateGroups[a].length;
  });

  // Perform Batch Distribution per Template Group
  sortedTemplateKeys.forEach(groupKey => {
    const rowIndices = templateGroups[groupKey];
    const batchSize = rowIndices.length;

    // Determine primary squad and team for this template group from its first row
    const firstRowIndex = rowIndices[0];
    const templateSquad = ticketSquads[firstRowIndex][0] ? ticketSquads[firstRowIndex][0].toString().trim() : "";
    const templateTeam = ticketTeams[firstRowIndex][0] ? ticketTeams[firstRowIndex][0].toString().trim() : "";

    let chosenMember = "";

    // PRIORITY 1: Squad Members (Prefer those under Fair Cap)
    const squadCandidates = (templateSquad && squadMemberMap[templateSquad]) ? squadMemberMap[templateSquad] : [];
    const eligibleSquadMembers = squadCandidates
      .slice()
      .sort((a, b) => finalAssignedCount[a] - finalAssignedCount[b]);

    const squadUnderCap = eligibleSquadMembers.filter(m => finalAssignedCount[m] + batchSize <= FAIR_CAP + 1);

    if (squadUnderCap.length > 0) {
      chosenMember = squadUnderCap[0];
    } else if (eligibleSquadMembers.length > 0) {
      chosenMember = eligibleSquadMembers[0];
    } else {
      // PRIORITY 2: Team Members
      const teamCandidates = (templateTeam && teamMemberMap[templateTeam]) ? teamMemberMap[templateTeam] : [];
      const eligibleTeamMembers = teamCandidates
        .slice()
        .sort((a, b) => finalAssignedCount[a] - finalAssignedCount[b]);

      const teamUnderCap = eligibleTeamMembers.filter(m => finalAssignedCount[m] + batchSize <= FAIR_CAP + 1);

      if (teamUnderCap.length > 0) {
        chosenMember = teamUnderCap[0];
      } else if (eligibleTeamMembers.length > 0) {
        chosenMember = eligibleTeamMembers[0];
      } else {
        // PRIORITY 3: Cross-Team Allocation (Lowest workload)
        const sortedAllMembers = availableMembers
          .slice()
          .sort((a, b) => finalAssignedCount[a.name] - finalAssignedCount[b.name]);

        chosenMember = sortedAllMembers[0].name;
      }
    }

    // Assign all tickets in this template group to the chosen member
    rowIndices.forEach(rIdx => {
      assignedMemberByRow[rIdx] = chosenMember;
    });

    finalAssignedCount[chosenMember] += batchSize;
  });

  // Prepare Column AL outputs array
  const assignmentsAL = [];
  for (let k = 0; k < totalRows; k++) {
    if (assignedMemberByRow[k]) {
      assignmentsAL.push([assignedMemberByRow[k]]);
    } else {
      assignmentsAL.push([""]);
    }
  }

  // Write outputs to Column AL (Column 38)
  dataSheet.getRange(2, 38, totalRows, 1).setValues(assignmentsAL);
  SpreadsheetApp.flush();

  // Multi-column Sorting (AL Ascending, AO Descending, AM Descending)
  const maxColumn = dataSheet.getLastColumn();
  const sortRange = dataSheet.getRange(2, 1, totalRows, maxColumn);

  sortRange.sort([
    { column: 38, ascending: true },  // AL: Assigned Member Name
    { column: 41, ascending: false }, // AO: Code Adapt Eligibility
    { column: 39, ascending: false }  // AM: Error Type Eligibility
  ]);

  // Aggregate Team & Squad Level Statistics
  const teamStats = {};
  const squadStats = {};

  availableMembers.forEach(m => {
    const tName = m.team || "Unassigned Team";
    const sName = m.squad || "Unassigned Squad";

    if (!teamStats[tName]) teamStats[tName] = { before: 0, after: 0 };
    if (!squadStats[sName]) squadStats[sName] = { before: 0, after: 0 };

    teamStats[tName].before += initialCalculatedCount[m.name];
    teamStats[tName].after += finalAssignedCount[m.name];

    squadStats[sName].before += initialCalculatedCount[m.name];
    squadStats[sName].after += finalAssignedCount[m.name];
  });

  // Construct Detailed Summary Message
  let summaryText = `Total Eligible Tickets: ${totalEligibleTickets}\nTarget Fair Cap: ~${FAIR_CAP}\nTotal Unique Template Providers: ${sortedTemplateKeys.length}\n\n`;

  summaryText += `=== TEAM BREAKDOWN ===\n`;
  for (let team in teamStats) {
    summaryText += `Team ${team}: Before = ${teamStats[team].before} -> After = ${teamStats[team].after}\n`;
  }

  summaryText += `\n=== SQUAD BREAKDOWN ===\n`;
  for (let squad in squadStats) {
    summaryText += `Squad ${squad}: Before = ${squadStats[squad].before} -> After = ${squadStats[squad].after}\n`;
  }

  summaryText += `\n=== INDIVIDUAL MEMBER BREAKDOWN ===\n`;
  availableMembers.forEach(m => {
    summaryText += `${m.name} [Squad: ${m.squad} | Team: ${m.team}]: Before = ${initialCalculatedCount[m.name]} -> After = ${finalAssignedCount[m.name]}\n`;
  });

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

/**
 * Executes JQL for KTLO - Code Adapt
 */
function fetchJiraDataFromB28Query() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var dailyDataSheet = ss.getSheetByName("KTLO_Daily_Data");
  if (!dailyDataSheet) return;

  var jqlQuery = dailyDataSheet.getRange("B28").getValue();
  if (!jqlQuery) return;

  var targetSheet = ss.getSheetByName("KTLO - Code Adapt");
  if (!targetSheet) return;

  targetSheet.clearContents();

  var fieldsList = [
    "Key", "Reporter", "Status", "Created", "Due date", "TemplateSources",
    "Dev ETA", "Re-assigned Date", "Customer Alias", "Customer Name", "Resolver",
    "Catalyst (migrated)", "Assignee", "Search Template", "Search Customer",
    "Labels", "AI ErrorType Agent Result", "AI ErrorType Engineer Result",
    "AI CodeAdapt Agent Result", "AI CodeAdapt Engineer Result"
  ].join(", ");

  var safeJql = String(jqlQuery).replace(/"/g, '""');
  var jiraFormula = '=JIRA("' + safeJql + '", "' + fieldsList + '")';

  targetSheet.getRange("A1").setFormula(jiraFormula);
  SpreadsheetApp.flush();
  Utilities.sleep(2500);

  var lastRow = targetSheet.getLastRow();
  if (lastRow < 2) return;

  var headersU_AP = [
    ["Skill Assignee", "Processed?", "Squad", "Current Date", "Due Classification",
     "Template Count", "Aging Days", "Aging Category", "Customer", "Is already processed via CA?",
     "Worked by", "PAD", "HYP_Provider", "ERROR TYPE", "Team",
     "Source Eligiblity", "BAND", "CODE ADAPT", "Catalyst InScope", "Eligiblity",
     "Not Feasiblity Details", "Feasibility Status"]
  ];
  targetSheet.getRange(1, 21, 1, 22).setValues(headersU_AP);

  var formulasMatrix = [];
  for (var r = 2; r <= lastRow; r++) {
    var rowFormulas = [
      '=IF($A' + r + '="","",Iferror(VLOOKUP(M' + r + ',KTLO_Daily_Data!AE:AK,5,false),"KTLO Member"))',
      '=IF($A' + r + '="","",Ifna(REGEXEXTRACT(P' + r + ',"CAAgent_23Sep*"),""))',
      '=IF($A' + r + '="","",Ifna(VLOOKUP(M' + r + ',\'TeamList-2026\'!B:E,3,False),""))',
      '=IF($A' + r + '="","",TODAY())',
      '=IF($A' + r + '="","",IFS($E' + r + '<$X' + r + ',"1-Past Due",$E' + r + '<$X' + r + '+1,"2-Current Due",$E' + r + '>$X' + r + '+1,"4-Future Due",$E' + r + '>$X' + r + ',"3-Due Tommorow"))',
      '=IF($A' + r + '="","",COUNTIF(N:N,N' + r + '))',
      '=IF($A' + r + '="","",NETWORKDAYS(D' + r + ', TODAY()))',
      '=IF($A' + r + '="","",IF(AA' + r + ' <= 3, "0-3 days", IF(AA' + r + ' <= 5, ">3 days", IF(AA' + r + ' <= 10, "6-10 days", IF(AA' + r + ' <= 30, "<1 month", IF(AA' + r + ' <= 60, "<2 months", ">2 months"))))))',
      '=IF($A' + r + '="","",CONCAT(O' + r + ',I' + r + '))',
      '=IF($A' + r + '="","",IF(S' + r + ' <> "", "Already Processed", ""))',
      '',
      '=IF($A' + r + '="","",IF(P' + r + '="", "", IFNA(REGEXEXTRACT(P' + r + ', "MissingChargeDetected|STATEMENTS_IN_PRODUCTION|Charge_Extracted_Twice|OB_Missing|TRANSITION_TO_(?:DA|AA|Reporter)"), "Non PAD")))',
      '=IF(P' + r + '="", "", IF(OR(N' + r + '="PacificGasAndElectricTemplateProvider", REGEXMATCH(P' + r + ', "HYP_Band")), "HYP_Band", "NON HYP_Band"))',
      '=IF(L' + r + ' = "", "", IF(AND(REGEXMATCH(L' + r + ', "^(Initial_)?Bill_Change(_History)?$"), AF' + r + ' = "Non PAD", AG' + r + ' = "NON HYP_Band"), "SKILL Eligible", "Not Eligible"))',
      '=IF(M' + r + ' = "", "", IFNA(VLOOKUP(M' + r + ', \'TeamList-2026\'!B:D, 2, FALSE), "NPC/Leads Q"))',
      '=IF(L' + r + ' = "", "", IF(AND(REGEXMATCH(L' + r + ', "^(Initial_)?Bill_Change(_History)?$"), B' + r + ' = "SVC Automon Jira User", OR(F' + r + ' = "PDF", F' + r + ' = "")), "Eligible", "Source Not Eligible"))',
      '=IF(P' + r + '="", "", IFNA(REGEXEXTRACT(P' + r + ', "TOP_300"), "NON TOP300"))',
      '=IFS(P' + r + '="", "", REGEXMATCH(Q' + r + ', "Critical Error|N/A: Ymir Log Not Available\\(404\\)|N/A: Reached Threshold Bill Pages \\(>10\\)|N/A: International Bill|N/A: High Yield Providers|N/A: Automon Link Not Available|N/A: Console Log Not Available|N/A"), "Not Eligible", AJ' + r + ' <> "Eligible", "Source not eligible", AND(REGEXMATCH(AF' + r + ', "MissingChargeDetected|Charge_Extracted_Twice|OB_Missing"), AK' + r + ' = "NON TOP300", AG' + r + ' = "NON HYP_Band"), "Code Adapt Primary", AND(REGEXMATCH(AF' + r + ', "MissingChargeDetected|Charge_Extracted_Twice|OB_Missing"), AK' + r + ' = "TOP_300", AG' + r + ' = "NON HYP_Band"), "Code Adapt Secondary", AG' + r + ' = "HYP_Band", "TOP_300-Hyp", TRUE, "Code Adapt Last")',
      '=IF(L' + r + ' = "", "", IF(REGEXMATCH(L' + r + ', "^(Initial_Bill_Change|Bill_Change|Initial_Bill_Change_History|Bill_Change_History)$"), "Inscope", "OutScope"))',
      '=IF($A' + r + '="","",IF(OR(AL' + r + ' = "", AD' + r + ' = "Already processed"), "Not Eligible", IF(REGEXMATCH(AL' + r + ', "Code Adapt.*"), "Eligible", "Not eligible")))',
      '=VLOOKUP(A' + r + ',\'Overall-Analysis\'!A:AQ,43,false)',
      '=VLOOKUP(A' + r + ',\'Overall-Analysis\'!A:AP,42,false)'
    ];
    formulasMatrix.push(rowFormulas);
  }

  targetSheet.getRange(2, 21, lastRow - 1, 22).setFormulas(formulasMatrix);
}
