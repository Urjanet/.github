/**
 * Daily KTLO appends.
 *
 * Any appended cell that contains an EXT-<number> or FS-<number> ticket id is
 * written as a Jira hyperlink:
 * https://arcadiapower.atlassian.net/browse/EXT-2029692
 * The visible text stays the ticket id, for example EXT-2029692.
 */
var JIRA_BROWSE_BASE = "https://arcadiapower.atlassian.net/browse/";

/**
 * Master Runner to execute all 4 append tasks sequentially.
 */
function runAllAppendsNew() {
  appendKTLOData();
  appendOverallSummaryData();
  appendOverallAnalysisRawData();
  appendUnprocessedData();
}

/**
 * Turn EXT-/FS- ticket ids in a value grid into link descriptors.
 * Pure ticket cells are normalized to the id itself (EXT-2029692).
 * A leading colon is accepted, so ":EXT-2029692" displays as EXT-2029692.
 * Ticket ids inside other text keep the surrounding text and link each id.
 * Returns {row, column, text, links} positions relative to the grid.
 */
function linkTicketIds(values) {
  var linked = [];
  var purePattern = /^\s*:?((?:EXT|FS)-\d+)\s*$/i;

  for (var r = 0; r < values.length; r++) {
    for (var c = 0; c < values[r].length; c++) {
      var value = values[r][c];
      if (typeof value !== "string" || value.charAt(0) === "=") {
        continue;
      }

      var pure = value.match(purePattern);
      if (pure) {
        var id = pure[1].toUpperCase();
        values[r][c] = id;
        linked.push({
          row: r,
          column: c,
          text: id,
          links: [{ start: 0, end: id.length, url: JIRA_BROWSE_BASE + id }]
        });
        continue;
      }

      var embedded = linkifyTicketText(value);
      if (!embedded) {
        continue;
      }
      values[r][c] = embedded.text;
      linked.push({
        row: r,
        column: c,
        text: embedded.text,
        links: embedded.links
      });
    }
  }

  return linked;
}

function linkifyTicketText(text) {
  var pattern = /\b((?:EXT|FS)-\d+)\b/gi;
  var links = [];
  var out = "";
  var last = 0;
  var match;

  while ((match = pattern.exec(text)) !== null) {
    var id = match[1].toUpperCase();
    out += text.substring(last, match.index) + id;
    links.push({
      start: out.length - id.length,
      end: out.length,
      url: JIRA_BROWSE_BASE + id
    });
    last = match.index + match[1].length;
  }

  if (!links.length) {
    return null;
  }

  out += text.substring(last);
  return { text: out, links: links };
}

function groupLinkRuns(linkedCells) {
  var sorted = linkedCells.slice().sort(function(a, b) {
    return a.column - b.column || a.row - b.row;
  });
  var runs = [];

  for (var i = 0; i < sorted.length; i++) {
    var cell = sorted[i];
    var current = runs.length ? runs[runs.length - 1] : null;
    if (current && current.column === cell.column && current.startRow + current.cells.length === cell.row) {
      current.cells.push(cell);
    } else {
      runs.push({ column: cell.column, startRow: cell.row, cells: [cell] });
    }
  }

  return runs;
}

function rememberTicketLinks(pending, startRow, startColumn, links) {
  for (var i = 0; i < links.length; i++) {
    pending.push({
      row: (startRow - 1) + links[i].row,
      column: (startColumn - 1) + links[i].column,
      text: links[i].text,
      links: links[i].links
    });
  }
}

/**
 * Apply Jira hyperlinks. linkedCells use row/column offsets from startRow/startColumn.
 * Consecutive ticket cells in one column are written together.
 */
function applyTicketHyperlinks(sheet, startRow, startColumn, linkedCells) {
  if (!linkedCells || !linkedCells.length) {
    return;
  }

  var runs = groupLinkRuns(linkedCells);
  for (var i = 0; i < runs.length; i++) {
    var run = runs[i];
    var rich = [];
    for (var j = 0; j < run.cells.length; j++) {
      var cell = run.cells[j];
      var builder = SpreadsheetApp.newRichTextValue().setText(cell.text);
      for (var k = 0; k < cell.links.length; k++) {
        var link = cell.links[k];
        builder.setLinkUrl(link.start, link.end, link.url);
      }
      rich.push([builder.build()]);
    }
    sheet.getRange(startRow + run.startRow, startColumn + run.column, run.cells.length, 1)
      .setRichTextValues(rich);
  }
}

/**
 * Task 1: Existing KTLO Daily Summary Append
 */
function appendKTLOData() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const today = new Date();
  const timeZone = ss.getSpreadsheetTimeZone();
  const todayFormatted = Utilities.formatDate(today, timeZone, "MMM-dd");

  // Weekend Guard
  const dayOfWeek = today.getDay(); // 0 = Sunday, 6 = Saturday
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    Logger.log("Skipping KTLOData execution: Today is a weekend.");
    return;
  }

  const sourceSheet = ss.getSheetByName("KTLO_Daily_Data");
  const targetSheet = ss.getSheetByName("KTLO Daily Summary");

  if (!sourceSheet || !targetSheet) {
    SpreadsheetApp.getUi().alert("Error: Ensure both 'KTLO_Daily_Data' and 'KTLO Daily Summary' sheets exist.");
    return;
  }

  // Deduplication Check
  const lastRow = targetSheet.getLastRow();
  if (lastRow > 1) {
    const datesInColumnA = targetSheet.getRange(2, 1, lastRow - 1, 1).getValues();

    const dateExists = datesInColumnA.some(row => {
      if (row[0]) {
        if (row[0] instanceof Date) {
          return Utilities.formatDate(row[0], timeZone, "MMM-dd") === todayFormatted;
        }
        return row[0].toString().trim() === todayFormatted;
      }
      return false;
    });

    if (dateExists) {
      Logger.log("Skipping KTLOData: Data for today (" + todayFormatted + ") already exists.");
      return;
    }
  }

  const rawData = sourceSheet.getRange("A2:Z16").getValues();
  const formattedData = rawData.map(row => [todayFormatted, ...row]);
  const ticketLinks = linkTicketIds(formattedData);

  const startRow = lastRow + 1;
  const numRows = formattedData.length;
  const numCols = formattedData[0].length;

  const targetRange = targetSheet.getRange(startRow, 1, numRows, numCols);
  targetRange.setValues(formattedData);

  if (numRows > 1) {
    const dateColumnRange = targetSheet.getRange(startRow, 1, numRows, 1);
    dateColumnRange.merge();
    dateColumnRange.setVerticalAlignment("middle");
    dateColumnRange.setHorizontalAlignment("center");
  }

  applyTicketHyperlinks(targetSheet, startRow, 1, ticketLinks);

  Logger.log("Successfully appended KTLO Daily Summary data for today.");
}

/**
 * Task 2: Append B10:Y10 to Overall Summary
 * Column A: Date (MMM-dd), Column B: Day, Columns C+: B10:Y10 values
 */
function appendOverallSummaryData() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const today = new Date();
  const timeZone = ss.getSpreadsheetTimeZone();
  const todayFormatted = Utilities.formatDate(today, timeZone, "MMM-dd");

  const dayOfWeek = today.getDay();
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    Logger.log("Skipping OverallSummary execution: Today is a weekend.");
    return;
  }

  const sourceSheet = ss.getSheetByName("KTLO_Daily_Data");
  const targetSheet = ss.getSheetByName("Overall Summary");

  if (!sourceSheet || !targetSheet) {
    SpreadsheetApp.getUi().alert("Error: Ensure target sheet 'Overall Summary' exists.");
    return;
  }

  // Deduplication Check
  const lastRow = targetSheet.getLastRow();
  if (lastRow > 1) {
    const datesInColumnA = targetSheet.getRange(2, 1, lastRow - 1, 1).getValues();

    const dateExists = datesInColumnA.some(row => {
      if (row[0]) {
        if (row[0] instanceof Date) {
          return Utilities.formatDate(row[0], timeZone, "MMM-dd") === todayFormatted;
        }
        return row[0].toString().trim() === todayFormatted;
      }
      return false;
    });

    if (dateExists) {
      Logger.log("Skipping OverallSummary: Data for today (" + todayFormatted + ") already exists.");
      return;
    }
  }

  // Get Day Name
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const dayName = dayNames[dayOfWeek];

  // Fetch range B10:Y10 from source sheet
  const rawData = sourceSheet.getRange("B9:AA9").getValues()[0];

  // Combine: [Date, Day, ...BB10:Y10]
  const rowToAppend = [[todayFormatted, dayName, ...rawData]];
  const ticketLinks = linkTicketIds(rowToAppend);

  const startRow = lastRow + 1;
  targetSheet.getRange(startRow, 1, 1, rowToAppend[0].length).setValues(rowToAppend);
  applyTicketHyperlinks(targetSheet, startRow, 1, ticketLinks);

  Logger.log("Successfully appended Overall Summary data for today.");
}

/**
 * Task 3: Append 'KTLO - Code Adapt'!A2:AP250 to 'Code Adapt - Raw Data'
 */
function appendOverallAnalysisRawData() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const today = new Date();
  const timeZone = ss.getSpreadsheetTimeZone();
  const todayFormatted = Utilities.formatDate(today, timeZone, "MMM-dd");

  // Weekend Guard
  const dayOfWeek = today.getDay();
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    Logger.log("Skipping CodeAdapt execution: Today is a weekend.");
    return;
  }

  const sourceSheet = ss.getSheetByName("Overall-Analysis");
  const targetSheet = ss.getSheetByName("Overall Analysis - Oct");

  if (!sourceSheet || !targetSheet) {
    SpreadsheetApp.getUi().alert("Error: Ensure sheets 'Overall-Analysis' and 'Overall Analysis - Oct' exist.");
    return;
  }

  // Find actual last row
  const colAData = targetSheet.getRange("A:A").getValues();
  let actualLastRow = 0;
  for (let r = colAData.length - 1; r >= 0; r--) {
    if (colAData[r][0] !== "" && colAData[r][0] !== null) {
      actualLastRow = r + 1;
      break;
    }
  }

  // Deduplication Check
  if (actualLastRow > 1) {
    const datesInColumnA = targetSheet.getRange(2, 1, actualLastRow - 1, 1).getValues();

    const dateExists = datesInColumnA.some(row => {
      if (row[0]) {
        if (row[0] instanceof Date) {
          return Utilities.formatDate(row[0], timeZone, "MMM-dd") === todayFormatted;
        }
        return row[0].toString().trim() === todayFormatted;
      }
      return false;
    });

    if (dateExists) {
      Logger.log("Skipping CodeAdapt: Data for today (" + todayFormatted + ") already exists.");
      return;
    }
  }

  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const dayName = dayNames[dayOfWeek];

  const colAValues = sourceSheet.getRange("A2:A750").getValues();
  const dataRangeValues = sourceSheet.getRange("B2:AY750").getValues();

  const filteredData = [];
  for (let i = 0; i < colAValues.length; i++) {
    const key = colAValues[i][0].toString().trim();
    if (key !== "") {
      filteredData.push([todayFormatted, dayName, key, ...dataRangeValues[i]]);
    }
  }

  if (filteredData.length === 0) {
    Logger.log("No non-empty Column A rows found to append for Code Adapt.");
    return;
  }

  const ticketLinks = linkTicketIds(filteredData);
  const startRow = (actualLastRow === 0 ? 1 : actualLastRow) + 1;
  const numRows = filteredData.length;
  const numCols = filteredData[0].length;

  const targetRange = targetSheet.getRange(startRow, 1, numRows, numCols);
  targetRange.setValues(filteredData);
  applyTicketHyperlinks(targetSheet, startRow, 1, ticketLinks);

  Logger.log(`Successfully appended ${numRows} rows into Overall Analysis.`);
}

/**
 * Task 4: Append 'KTLO - ErrorType'!A2:AP250 to 'ErrorType - Raw Data'
 */
function appendErrorTypeRawData() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const today = new Date();
  const timeZone = ss.getSpreadsheetTimeZone();
  const todayFormatted = Utilities.formatDate(today, timeZone, "MMM-dd");

  // Weekend Guard
  const dayOfWeek = today.getDay();
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    Logger.log("Skipping ErrorType execution: Today is a weekend.");
    return;
  }

  const sourceSheet = ss.getSheetByName("KTLO - ErrorType");
  const targetSheet = ss.getSheetByName("ErrorType - Raw Data");

  if (!sourceSheet || !targetSheet) {
    SpreadsheetApp.getUi().alert("Error: Ensure sheets 'KTLO - ErrorType' and 'ErrorType - Raw Data' exist.");
    return;
  }

  // Find actual last row
  const colAData = targetSheet.getRange("A:A").getValues();
  let actualLastRow = 0;
  for (let r = colAData.length - 1; r >= 0; r--) {
    if (colAData[r][0] !== "" && colAData[r][0] !== null) {
      actualLastRow = r + 1;
      break;
    }
  }

  // Deduplication Check
  if (actualLastRow > 1) {
    const datesInColumnA = targetSheet.getRange(2, 1, actualLastRow - 1, 1).getValues();

    const dateExists = datesInColumnA.some(row => {
      if (row[0]) {
        if (row[0] instanceof Date) {
          return Utilities.formatDate(row[0], timeZone, "MMM-dd") === todayFormatted;
        }
        return row[0].toString().trim() === todayFormatted;
      }
      return false;
    });

    if (dateExists) {
      Logger.log("Skipping ErrorType: Data for today (" + todayFormatted + ") already exists.");
      return;
    }
  }

  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const dayName = dayNames[dayOfWeek];

  const colAValues = sourceSheet.getRange("A2:A250").getValues();
  const dataRangeValues = sourceSheet.getRange("B2:AP250").getValues();

  const filteredData = [];
  for (let i = 0; i < colAValues.length; i++) {
    const key = colAValues[i][0].toString().trim();
    if (key !== "") {
      filteredData.push([todayFormatted, dayName, key, ...dataRangeValues[i]]);
    }
  }

  if (filteredData.length === 0) {
    Logger.log("No non-empty Column A rows found to append for ErrorType.");
    return;
  }

  const ticketLinks = linkTicketIds(filteredData);
  const startRow = (actualLastRow === 0 ? 1 : actualLastRow) + 1;
  const numRows = filteredData.length;
  const numCols = filteredData[0].length;

  const targetRange = targetSheet.getRange(startRow, 1, numRows, numCols);
  targetRange.setValues(filteredData);
  applyTicketHyperlinks(targetSheet, startRow, 1, ticketLinks);

  Logger.log(`Successfully appended ${numRows} rows into ErrorType - Raw Data starting at row ${startRow}.`);
}

/**
 * Append unprocessed Overall-Analysis rows to 'Unprocessed', one row at a time.
 *
 * Order: all ET Agent rows, then all CA Agent rows.
 * Columns: Date | Agent | Ticket ID (A) | Team (AK) | Eligibility Analysis
 *
 * Error Type: AM = "Skill Eligible", AR is empty, A is not empty. Analysis = AN.
 * Code Agent: AO = "Skill Eligible", AP = "Feasible", AU is empty, A is not empty. Analysis = AQ.
 */
function appendUnprocessedData() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const today = new Date();
  const timeZone = ss.getSpreadsheetTimeZone();
  const todayFormatted = Utilities.formatDate(today, timeZone, "MMM-dd");

  const dayOfWeek = today.getDay();
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    Logger.log("Skipping Unprocessed execution: Today is a weekend.");
    return;
  }

  const sourceSheet = ss.getSheetByName("Overall-Analysis");
  const targetSheet = ss.getSheetByName("Unprocessed");

  if (!sourceSheet || !targetSheet) {
    SpreadsheetApp.getUi().alert("Error: Ensure sheets 'Overall-Analysis' and 'Unprocessed' exist.");
    return;
  }

  const COL_TICKET = 0; // A
  const COL_TEAM = 36;  // AK
  const COL_AM = 38;    // AM
  const COL_AN = 39;    // AN
  const COL_AO = 40;    // AO
  const COL_AP = 41;    // AP
  const COL_AQ = 42;    // AQ
  const COL_AR = 43;    // AR
  const COL_AU = 46;    // AU

  const normalize = (value) => value === null || value === undefined ? "" : value.toString().trim().toLowerCase();
  const isBlank = (value) => normalize(value) === "";
  const dateLabel = (value) => {
    if (value instanceof Date) {
      return Utilities.formatDate(value, timeZone, "MMM-dd");
    }
    return value === null || value === undefined ? "" : value.toString().trim();
  };

  const lastRow = targetSheet.getLastRow();
  let hasEt = false;
  let hasCa = false;
  let todayStartRow = 0;
  let todayEndRow = 0;

  if (lastRow >= 2) {
    const existing = targetSheet.getRange(2, 1, lastRow - 1, 2).getValues();
    let activeDate = "";

    for (let i = 0; i < existing.length; i++) {
      const label = dateLabel(existing[i][0]);
      const agent = existing[i][1] === null || existing[i][1] === undefined ? "" : existing[i][1].toString().trim();

      if (label) {
        activeDate = label;
      } else if (!agent) {
        activeDate = "";
        continue;
      }

      if (activeDate === todayFormatted) {
        if (!todayStartRow) {
          todayStartRow = i + 2;
        }
        todayEndRow = i + 2;
        if (agent === "ET Agent") hasEt = true;
        if (agent === "CA Agent") hasCa = true;
      }
    }
  }

  if (hasEt && hasCa) {
    Logger.log("Skipping Unprocessed: ET Agent and CA Agent for today (" + todayFormatted + ") already exist.");
    return;
  }

  const sourceValues = sourceSheet.getRange("A2:AU750").getValues();
  const etRows = [];
  const caRows = [];

  for (let i = 0; i < sourceValues.length; i++) {
    const row = sourceValues[i];
    if (isBlank(row[COL_TICKET])) {
      continue;
    }

    if (!hasEt && normalize(row[COL_AM]) === "skill eligible" && isBlank(row[COL_AR])) {
      etRows.push([todayFormatted, "ET Agent", row[COL_TICKET], row[COL_TEAM], row[COL_AN]]);
    }

    if (!hasCa && normalize(row[COL_AO]) === "skill eligible" && normalize(row[COL_AP]) === "feasible" && isBlank(row[COL_AU])) {
      caRows.push([todayFormatted, "CA Agent", row[COL_TICKET], row[COL_TEAM], row[COL_AQ]]);
    }
  }

  if (etRows.length === 0 && caRows.length === 0) {
    Logger.log("No unprocessed rows found to append.");
    return;
  }

  let writeRow = lastRow + 1;
  const pendingLinks = [];

  const writeRowValues = (rowValues) => {
    const links = linkTicketIds([rowValues]);
    targetSheet.getRange(writeRow, 1, 1, rowValues.length).setValues([rowValues]);
    rememberTicketLinks(pendingLinks, writeRow, 1, links);
    if (!todayStartRow) {
      todayStartRow = writeRow;
    }
    todayEndRow = writeRow;
    writeRow++;
  };

  // 1. ET Agent, one row at a time
  for (let i = 0; i < etRows.length; i++) {
    writeRowValues(etRows[i]);
  }

  // 2. CA Agent, one row at a time
  for (let i = 0; i < caRows.length; i++) {
    writeRowValues(caRows[i]);
  }

  // 3. Merge today's Date cells when the new rows continue today's block
  const blockIsAtEnd = todayEndRow === writeRow - 1 && (lastRow < 2 || todayStartRow <= lastRow + 1);
  if (blockIsAtEnd && todayEndRow > todayStartRow) {
    const numRows = todayEndRow - todayStartRow + 1;
    const dateColumnRange = targetSheet.getRange(todayStartRow, 1, numRows, 1);
    dateColumnRange.getMergedRanges().forEach(range => range.breakApart());
    dateColumnRange.merge();
    dateColumnRange.setVerticalAlignment("middle");
    dateColumnRange.setHorizontalAlignment("center");
    targetSheet.getRange(todayStartRow, 1).setValue(todayFormatted);
  }

  applyTicketHyperlinks(targetSheet, 1, 1, pendingLinks);

  Logger.log("Appended " + etRows.length + " ET Agent row(s) and " + caRows.length + " CA Agent row(s).");
}
