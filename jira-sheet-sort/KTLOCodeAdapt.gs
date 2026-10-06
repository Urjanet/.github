/**
 * Separate script for KTLO - Code Adapt.
 * Reads the JQL in KTLO_Daily_Data!B28, writes columns A:T, then fills formulas in U:AP.
 * This script does not assign tickets or sort rows.
 */
function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu('KTLO Code Adapt')
      .addItem('Fetch Jira Tickets', 'fetchJiraDataFromB28Query')
      .addToUi();
  } catch (e) {
    Logger.log("Skipped UI creation: Executed outside active sheet UI context.");
  }
}

/**
 * Reads JQL from KTLO_Daily_Data!B28, executes Jira query returning ONLY the 20 specified columns (A:T),
 * and populates calculated formulas across columns U:AP for the exact returned row count.
 */
function fetchJiraDataFromB28Query() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // 1. Get JQL Query directly from KTLO_Daily_Data Cell B28
  var dailyDataSheet = ss.getSheetByName("KTLO_Daily_Data");
  if (!dailyDataSheet) {
    Logger.log("Error: 'KTLO_Daily_Data' sheet not found.");
    return;
  }

  var jqlQuery = dailyDataSheet.getRange("B28").getValue();
  if (!jqlQuery) {
    Logger.log("Error: Cell B28 in KTLO_Daily_Data is empty.");
    return;
  }
  Logger.log("Executing JQL Query from B28: " + jqlQuery);

  // 2. Set Target Sheet
  var targetSheetName = "KTLO - Code Adapt";
  var targetSheet = ss.getSheetByName(targetSheetName);

  if (!targetSheet) {
    Logger.log("Error: Target sheet '" + targetSheetName + "' not found.");
    return;
  }

  // =========================================================================
  // STEP 1: CLEAR TARGET SHEET
  // =========================================================================
  targetSheet.clearContents();

  // =========================================================================
  // STEP 2: EXECUTE JQL QUERY RETURNING EXCLUSIVELY COLUMNS A:T
  // =========================================================================
  var fieldsList = [
    "Key",
    "Reporter",
    "Status",
    "Created",
    "Due date",
    "TemplateSources",
    "Dev ETA",
    "Re-assigned Date",
    "Customer Alias",
    "Customer Name",
    "Resolver",
    "Catalyst (migrated)",
    "Assignee",
    "Search Template",
    "Search Customer",
    "Labels",
    "AI ErrorType Agent Result",
    "AI ErrorType Engineer Result",
    "AI CodeAdapt Agent Result",
    "AI CodeAdapt Engineer Result"
  ].join(", ");

  var safeJql = String(jqlQuery).replace(/"/g, '""');

  // Formula syntax: =JIRA("JQL Query", "Field1, Field2, ...")
  var jiraFormula = '=JIRA("' + safeJql + '", "' + fieldsList + '")';

  targetSheet.getRange("A1").setFormula(jiraFormula);

  // Flush to trigger formula execution
  SpreadsheetApp.flush();
  Utilities.sleep(2500); // Wait 2.5 seconds for Jira to populate 20 columns

  var lastRow = targetSheet.getLastRow();

  if (lastRow < 2) {
    Logger.log("Jira query executed. If data is still loading, re-run after a moment.");
    return;
  }

  Logger.log("Jira successfully populated " + (lastRow - 1) + " issues across columns A:T.");

  // =========================================================================
  // STEP 3: WRITE HEADERS FOR COLUMNS U:AP (Row 1)
  // =========================================================================
  var headersU_AP = [
    ["Skill Assignee", "Processed?", "Squad", "Current Date", "Due Classification",
     "Template Count", "Aging Days", "Aging Category", "Customer", "Is already processed via CA?",
     "Worked by", "PAD", "HYP_Provider", "ERROR TYPE", "Team",
     "Source Eligiblity", "BAND", "CODE ADAPT", "Catalyst InScope", "Eligiblity",
     "Not Feasiblity Details", "Feasibility Status"]
  ];
  targetSheet.getRange(1, 21, 1, 22).setValues(headersU_AP);

  // =========================================================================
  // STEP 4: APPLY FORMULAS U:AP FOR RETURNED ROW COUNT (Row 2 to lastRow)
  // =========================================================================
  var formulasMatrix = [];

  for (var r = 2; r <= lastRow; r++) {
    var rowFormulas = [
      /* U  Skill Assignee */          '=IF($A' + r + '="","",Iferror(VLOOKUP(M' + r + ',KTLO_Daily_Data!AF:AJ,5,false),"KTLO Member"))',
      /* V  Processed? */              '=IF($A' + r + '="","",Ifna(REGEXEXTRACT(P' + r + ',"CAAgent_23Sep*"),""))',
      /* W  Squad */                   '=IF($A' + r + '="","",Ifna(VLOOKUP(M' + r + ',\'TeamList-2026\'!B:E,3,False),""))',
      /* X  Current Date */            '=IF($A' + r + '="","",TODAY())',
      /* Y  Due Classification */      '=IF($A' + r + '="","",IFS($E' + r + '<$X' + r + ',"1-Past Due",$E' + r + '<$X' + r + '+1,"2-Current Due",$E' + r + '>$X' + r + '+1,"4-Future Due",$E' + r + '>$X' + r + ',"3-Due Tommorow"))',
      /* Z  Template Count */          '=IF($A' + r + '="","",COUNTIF(N:N,N' + r + '))',
      /* AA Aging Days */              '=IF($A' + r + '="","",NETWORKDAYS(D' + r + ', TODAY()))',
      /* AB Aging Category */          '=IF($A' + r + '="","",IF(AA' + r + ' <= 3, "0-3 days", IF(AA' + r + ' <= 5, ">3 days", IF(AA' + r + ' <= 10, "6-10 days", IF(AA' + r + ' <= 30, "<1 month", IF(AA' + r + ' <= 60, "<2 months", ">2 months"))))))',
      /* AC Customer */                '=IF($A' + r + '="","",CONCAT(O' + r + ',I' + r + '))',
      /* AD Is processed via CA? */    '=IF($A' + r + '="","",IF(S' + r + ' <> "", "Already Processed", ""))',
      /* AE Worked by */               '', // Static / Empty
      /* AF PAD */                     '=IF($A' + r + '="","",IF(P' + r + '="", "", IFNA(REGEXEXTRACT(P' + r + ', "MissingChargeDetected|STATEMENTS_IN_PRODUCTION|Charge_Extracted_Twice|OB_Missing|TRANSITION_TO_(?:DA|AA|Reporter)"), "Non PAD")))',
      /* AG HYP_Provider */            '=IF(P' + r + '="", "", IF(OR(N' + r + '="PacificGasAndElectricTemplateProvider", REGEXMATCH(P' + r + ', "HYP_Band")), "HYP_Band", "NON HYP_Band"))',
      /* AH ERROR TYPE */              '=IF(L' + r + ' = "", "", IF(AND(REGEXMATCH(L' + r + ', "^(Initial_)?Bill_Change(_History)?$"), AF' + r + ' = "Non PAD", AG' + r + ' = "NON HYP_Band"), "SKILL Eligible", "Not Eligible"))',
      /* AI Team */                    '=IF(M' + r + ' = "", "", IFNA(VLOOKUP(M' + r + ', \'TeamList-2026\'!B:D, 2, FALSE), "NPC/Leads Q"))',
      /* AJ Source Eligiblity */       '=IF(L' + r + ' = "", "", IF(AND(REGEXMATCH(L' + r + ', "^(Initial_)?Bill_Change(_History)?$"), B' + r + ' = "SVC Automon Jira User", OR(F' + r + ' = "PDF", F' + r + ' = "")), "Eligible", "Source Not Eligible"))',
      /* AK BAND */                    '=IF(P' + r + '="", "", IFNA(REGEXEXTRACT(P' + r + ', "TOP_300"), "NON TOP300"))',
      /* AL CODE ADAPT */              '=IFS(P' + r + '="", "", REGEXMATCH(Q' + r + ', "Critical Error|N/A: Ymir Log Not Available\\(404\\)|N/A: Reached Threshold Bill Pages \\(>10\\)|N/A: International Bill|N/A: High Yield Providers|N/A: Automon Link Not Available|N/A: Console Log Not Available|N/A"), "Not Eligible", AJ' + r + ' <> "Eligible", "Source not eligible", AND(REGEXMATCH(AF' + r + ', "MissingChargeDetected|Charge_Extracted_Twice|OB_Missing"), AK' + r + ' = "NON TOP300", AG' + r + ' = "NON HYP_Band"), "Code Adapt Primary", AND(REGEXMATCH(AF' + r + ', "MissingChargeDetected|Charge_Extracted_Twice|OB_Missing"), AK' + r + ' = "TOP_300", AG' + r + ' = "NON HYP_Band"), "Code Adapt Secondary", AG' + r + ' = "HYP_Band", "TOP_300-Hyp", TRUE, "Code Adapt Last")',
      /* AM Catalyst InScope */        '=IF(L' + r + ' = "", "", IF(REGEXMATCH(L' + r + ', "^(Initial_Bill_Change|Bill_Change|Initial_Bill_Change_History|Bill_Change_History)$"), "Inscope", "OutScope"))',
      /* AN Eligiblity */              '=IF($A' + r + '="","",IF(OR(AL' + r + ' = "", AD' + r + ' = "Already processed"), "Not Eligible", IF(REGEXMATCH(AL' + r + ', "Code Adapt.*"), "Eligible", "Not eligible")))',
      /* AO Not Feasiblity Details */  '=VLOOKUP(A' + r + ',\'Overall-Analysis\'!A:AQ,43,false)',
      /* AP Feasibility Status */      '=VLOOKUP(A' + r + ',\'Overall-Analysis\'!A:AP,42,false)'
    ];

    formulasMatrix.push(rowFormulas);
  }

  // Set formulas strictly starting from column U (Column 21)
  targetSheet.getRange(2, 21, lastRow - 1, 22).setFormulas(formulasMatrix);

  Logger.log("Successfully updated " + targetSheetName + " with 20 Jira columns and matching U:AP formulas.");
}
