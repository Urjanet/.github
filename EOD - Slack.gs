/**
 * EOD Slack report.
 *
 * Run sendEodSlackReport(). It always does these steps in order:
 * 1. Fetch and Distribute.gs -> populateOverallAnalysisARtoAW()
 * 2. Append - new.gs -> appendUnprocessedData()
 * 3. Post the EOD to the Slack channel.
 *
 * Script properties (Project Settings -> Script properties):
 * - SLACK_BOT_TOKEN (required): Bot User OAuth token (xoxb-...) with chat:write.
 *   Invite that bot to the channel before the first run.
 * - SLACK_EOD_CHANNEL (optional): channel ID. Defaults to #ktlo-tracking for testing.
 */

var EOD_SLACK_CHANNEL_ID = "C0B3MSQABRV";

/**
 * Entry point. Bind a time-driven trigger to this function to send the EOD
 * after the daily sheet updates.
 */
function sendEodSlackReport() {
  if (typeof populateOverallAnalysisARtoAW !== "function") {
    throw new Error("Missing populateOverallAnalysisARtoAW. Add Fetch and Distribute.gs to this project.");
  }
  if (typeof appendUnprocessedData !== "function") {
    throw new Error("Missing appendUnprocessedData. Add Append - new.gs to this project.");
  }

  populateOverallAnalysisARtoAW();
  SpreadsheetApp.flush();

  appendUnprocessedData();
  SpreadsheetApp.flush();

  postEodToSlack();
}

/**
 * Build the EOD from the current sheets and post it with the Slack bot.
 */
function postEodToSlack() {
  const token = eodScriptProperty_("SLACK_BOT_TOKEN");
  if (!token) {
    throw new Error("Set Script property SLACK_BOT_TOKEN to the Slack bot token (xoxb-...) with chat:write.");
  }

  const channel = eodScriptProperty_("SLACK_EOD_CHANNEL") || EOD_SLACK_CHANNEL_ID;
  const blocks = [{
    type: "header",
    text: { type: "plain_text", text: "EOD" }
  }];

  const ktloBlocks = buildKtloBlocks_();
  for (let i = 0; i < ktloBlocks.length; i++) {
    blocks.push(ktloBlocks[i]);
  }
  blocks.push({ type: "divider" });
  eodPushMarkdown_(blocks, buildUnprocessedSection_());
  eodPushMarkdown_(blocks, buildMissingJavaSuiteSection_());

  const messages = chunkEodBlocks_(blocks);
  for (let i = 0; i < messages.length; i++) {
    postEodSlackMessage_(token, channel, "EOD", messages[i]);
  }

  Logger.log("Posted EOD to Slack channel " + channel + " in " + messages.length + " message(s).");
}

/**
 * KTLO_Daily_Data columns A and F:P, rows 1 through 10.
 * The wide grid is posted as two Slack tables: Error-Type, then Code-Adapt.
 */
function buildKtloBlocks_() {
  const sheet = eodRequireSheet_("KTLO_Daily_Data");
  const columnA = sheet.getRange("A1:A10").getDisplayValues();
  const columnsFToP = sheet.getRange("F1:P10").getDisplayValues();
  const rows = [];

  for (let i = 0; i < columnA.length; i++) {
    rows.push([columnA[i][0]].concat(columnsFToP[i]));
  }

  const split = eodSplitKtloGrid_(rows);
  const blocks = [];

  if (split.notes.length) {
    const lines = [];
    for (let i = 0; i < split.notes.length; i++) {
      lines.push("*" + split.notes[i].section + " unprocessed:* " + split.notes[i].value);
    }
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: lines.join("\n") }
    });
  }

  if (!split.codeAdapt.length) {
    blocks.push({
      type: "header",
      text: { type: "plain_text", text: "KTLO_Daily_Data" }
    });
    blocks.push(eodMetricTableBlock_(split.errorType) || eodNoneSection_());
    return blocks;
  }

  blocks.push({
    type: "header",
    text: { type: "plain_text", text: "Error-Type" }
  });
  blocks.push(eodMetricTableBlock_(split.errorType) || eodNoneSection_());
  blocks.push({
    type: "header",
    text: { type: "plain_text", text: "Code-Adapt" }
  });
  blocks.push(eodMetricTableBlock_(split.codeAdapt) || eodNoneSection_());
  return blocks;
}

/**
 * Split the KTLO grid on the first Code-Adapt column.
 * A blank team row that carries a label plus a count becomes the unprocessed note.
 */
function eodSplitKtloGrid_(rows) {
  const result = { errorType: [], codeAdapt: [], notes: [] };
  if (!rows.length) {
    return result;
  }

  const headers = rows[0].map(eodCellText_);
  let codeStart = -1;
  for (let i = 1; i < headers.length; i++) {
    if (/code[-\s]?adapt/i.test(headers[i])) {
      codeStart = i;
      break;
    }
  }

  if (codeStart === -1) {
    result.errorType = rows;
    return result;
  }

  result.errorType.push(["Team"].concat(headers.slice(1, codeStart).map(eodShortHeader_)));
  result.codeAdapt.push(["Team"].concat(headers.slice(codeStart).map(eodShortHeader_)));

  for (let r = 1; r < rows.length; r++) {
    const team = eodCellText_(rows[r][0]);
    const etCells = rows[r].slice(1, codeStart).map(eodCellText_);
    const caCells = rows[r].slice(codeStart).map(eodCellText_);
    const hasValue = etCells.concat(caCells).some(function (cell) {
      return !eodIsBlank_(cell);
    });
    if (!hasValue && !team) {
      continue;
    }

    if (!team) {
      const etNote = eodFootnote_(etCells);
      const caNote = eodFootnote_(caCells);
      if (etNote) {
        result.notes.push({ section: "Error-Type", label: etNote.label, value: etNote.value });
      }
      if (caNote) {
        result.notes.push({ section: "Code-Adapt", label: caNote.label, value: caNote.value });
      }
      if (etNote || caNote) {
        continue;
      }
    }

    result.errorType.push([team].concat(etCells));
    result.codeAdapt.push([team].concat(caCells));
  }

  return result;
}

function eodShortHeader_(header) {
  let text = eodCellText_(header).replace(/^(error[-\s]?type|code[-\s]?adapt)\s*/i, "");
  text = text.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  if (/^%\s*processed$/i.test(text)) {
    return "%";
  }
  if (/^total tickets$/i.test(text)) {
    return "Total";
  }
  if (/^not eligible$/i.test(text)) {
    return "Not eligible";
  }
  return text || eodCellText_(header);
}

function eodFootnote_(cells) {
  for (let i = 0; i < cells.length - 1; i++) {
    const label = cells[i];
    const value = cells[i + 1];
    if (label && !eodIsNumericText_(label) && eodIsNumericText_(value)) {
      return { label: label, value: value };
    }
  }
  return null;
}

function eodIsNumericText_(value) {
  const text = eodCellText_(value).replace(/,/g, "").replace(/%$/, "");
  return text !== "" && !isNaN(Number(text));
}

function eodMetricTableBlock_(rows) {
  if (!rows.length) {
    return null;
  }

  const columnCount = rows[0].length;
  const columnSettings = [];
  for (let c = 0; c < columnCount; c++) {
    columnSettings.push(c === 0 ? { align: "left" } : { align: "right" });
  }

  const tableRows = [];
  for (let r = 0; r < rows.length; r++) {
    const bold = r === 0 || /^total$/i.test(eodCellText_(rows[r][0]));
    const cells = [];
    for (let c = 0; c < columnCount; c++) {
      cells.push(eodTableCell_(c < rows[r].length ? rows[r][c] : "", bold));
    }
    tableRows.push(cells);
  }

  return {
    type: "table",
    column_settings: columnSettings,
    rows: tableRows
  };
}

function eodTableCell_(value, bold) {
  const text = eodCellText_(value) || " ";
  if (!bold) {
    return { type: "raw_text", text: text };
  }
  return {
    type: "rich_text",
    elements: [{
      type: "rich_text_section",
      elements: [{ type: "text", text: text, style: { bold: true } }]
    }]
  };
}

function eodNoneSection_() {
  return {
    type: "section",
    text: { type: "mrkdwn", text: "None" }
  };
}

/**
 * Unprocessed rows for today whose Eligibility Analysis (column E) is empty.
 * Posts columns B:E. A merged Date cell applies to the rows beneath it.
 */
function buildUnprocessedSection_() {
  const sheet = eodRequireSheet_("Unprocessed");
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const timeZone = ss.getSpreadsheetTimeZone();
  const todayFormatted = Utilities.formatDate(new Date(), timeZone, "MMM-dd");
  const lastRow = sheet.getLastRow();
  let selected = [];

  if (lastRow >= 1) {
    const values = sheet.getRange(1, 1, lastRow, 5).getValues();
    const display = sheet.getRange(1, 1, lastRow, 5).getDisplayValues();
    selected = eodSelectUnprocessedRows_(values, display, todayFormatted, timeZone);
  }

  const tableRows = selected.length
    ? [["Agent", "Ticket ID", "Team", "Eligibility Analysis"]].concat(selected)
    : [];

  return "## Unprocessed ticket without Update (To be updated)\n\n" +
    "Unprocessed tickets without data\n\n" +
    formatEodMarkdownTable_(tableRows);
}

/**
 * Overall-Analysis rows whose column AY is #N/A. Posts ticket (A) and team (AK).
 */
function buildMissingJavaSuiteSection_() {
  const sheet = eodRequireSheet_("Overall-Analysis");
  const lastRow = sheet.getLastRow();
  let selected = [];

  if (lastRow >= 2) {
    const numRows = lastRow - 1;
    const tickets = sheet.getRange(2, 1, numRows, 1).getDisplayValues();
    const teams = sheet.getRange(2, 37, numRows, 1).getDisplayValues();
    const suiteStatus = sheet.getRange(2, 51, numRows, 1).getDisplayValues();
    selected = eodSelectMissingTickets_(tickets, teams, suiteStatus);
  }

  const tableRows = selected.length ? [["Ticket ID", "Team"]].concat(selected) : [];
  return "## Missing ticket from Java suit (To be updated)\n\n" + formatEodMarkdownTable_(tableRows);
}

/**
 * Keep today's Unprocessed rows when column E is empty and B:D has a value.
 * Blank column A continues the date from the merged cell above.
 */
function eodSelectUnprocessedRows_(values, display, todayFormatted, timeZone) {
  const rows = [];
  let activeDate = "";

  for (let i = 0; i < values.length; i++) {
    const label = eodDateLabel_(values[i][0], timeZone);
    const posted = [display[i][1], display[i][2], display[i][3], display[i][4]];
    let hasDetail = false;
    for (let c = 0; c < 3; c++) {
      if (!eodIsBlank_(posted[c])) {
        hasDetail = true;
        break;
      }
    }

    if (label) {
      activeDate = label;
    } else if (!hasDetail) {
      activeDate = "";
      continue;
    }

    if (activeDate === todayFormatted && eodIsBlank_(values[i][4]) && hasDetail) {
      rows.push(posted);
    }
  }

  return rows;
}

/**
 * Keep Overall-Analysis ticket A and team AK when AY is #N/A and A is filled.
 */
function eodSelectMissingTickets_(tickets, teams, suiteStatus) {
  const rows = [];
  for (let i = 0; i < tickets.length; i++) {
    if (eodIsBlank_(tickets[i][0]) || !eodIsNa_(suiteStatus[i][0])) {
      continue;
    }
    rows.push([tickets[i][0], teams[i][0]]);
  }
  return rows;
}

function postEodSlackMessage_(token, channel, text, blocks) {
  const payload = {
    channel: channel,
    text: text,
    unfurl_links: false,
    unfurl_media: false
  };
  if (blocks && blocks.length) {
    payload.blocks = blocks;
  }

  const response = UrlFetchApp.fetch("https://slack.com/api/chat.postMessage", {
    method: "post",
    contentType: "application/json; charset=utf-8",
    headers: { Authorization: "Bearer " + token },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const body = JSON.parse(response.getContentText() || "{}");
  if (body.error === "channel_not_found" || body.error === "not_in_channel") {
    throw new Error("Slack chat.postMessage failed: " + body.error + " for channel " + channel +
      ". Private channels are hidden from the bot until it is added: in Slack, open the channel and run /invite @<bot name>.");
  }
  if (!body.ok) {
    throw new Error("Slack chat.postMessage failed: " + (body.error || response.getContentText()));
  }
}

function chunkEodBlocks_(blocks) {
  const messages = [];
  let current = [];
  let markdownChars = 0;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const added = block.type === "markdown" ? block.text.length : 0;
    const full = current.length >= 45 || (markdownChars + added > 11000 && current.length > 0);
    if (full) {
      messages.push(current);
      current = [];
      markdownChars = 0;
    }
    current.push(block);
    markdownChars += added;
  }

  if (current.length) {
    messages.push(current);
  }
  return messages;
}

function eodPushMarkdown_(blocks, text) {
  const parts = splitEodSection_(text, 4000);
  for (let i = 0; i < parts.length; i++) {
    blocks.push({ type: "markdown", text: parts[i] });
  }
}

function formatEodMarkdownTable_(rows) {
  const dataRows = rows.filter(function (row) {
    return row.some(function (cell) {
      return !eodIsBlank_(cell);
    });
  });
  if (dataRows.length === 0) {
    return "None";
  }

  const rendered = dataRows.map(function (row) {
    return row.map(function (cell) {
      return eodCellText_(cell).replace(/\|/g, "\\|");
    });
  });
  const header = "| " + rendered[0].join(" | ") + " |";
  const separator = "| " + rendered[0].map(function () {
    return "---";
  }).join(" | ") + " |";
  const body = [];
  for (let i = 1; i < rendered.length; i++) {
    body.push("| " + rendered[i].join(" | ") + " |");
  }
  return [header, separator].concat(body).join("\n");
}

function splitEodSection_(section, limit) {
  if (section.length <= limit) {
    return [section];
  }

  const lines = section.split("\n");
  const parts = [];
  let current = "";

  for (let i = 0; i < lines.length; i++) {
    const addition = current ? "\n" + lines[i] : lines[i];
    if (current && current.length + addition.length > limit) {
      parts.push(closeEodCodeFence_(current));
      current = openEodCodeFence_(lines[i], current);
    } else {
      current += addition;
    }
  }
  if (current) {
    parts.push(closeEodCodeFence_(current));
  }
  return parts;
}

function closeEodCodeFence_(text) {
  const fences = text.match(/```/g);
  if (fences && fences.length % 2 === 1) {
    return text + "\n```";
  }
  return text;
}

function openEodCodeFence_(line, previous) {
  const fences = previous.match(/```/g);
  if (fences && fences.length % 2 === 1 && line !== "```") {
    return "```\n" + line;
  }
  return line;
}

function eodRequireSheet_(name) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) {
    throw new Error("Missing sheet '" + name + "'.");
  }
  return sheet;
}

function eodScriptProperty_(key) {
  const value = PropertiesService.getScriptProperties().getProperty(key);
  return value ? String(value).trim() : "";
}

function eodCellText_(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/\s+/g, " ")
    .replace(/`/g, "'")
    .trim();
}

function eodIsBlank_(value) {
  return eodCellText_(value) === "";
}

function eodDateLabel_(value, timeZone) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, timeZone, "MMM-dd");
  }
  return eodCellText_(value);
}

function eodIsNa_(value) {
  const text = eodCellText_(value).toUpperCase();
  return text === "#N/A" || text === "#N/A!";
}
