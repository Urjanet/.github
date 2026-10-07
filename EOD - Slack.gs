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
var EOD_SLACK_TEXT_LIMIT = 35000;

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
  const sections = [
    buildEodHeading_(),
    buildKtloDailySection_(),
    buildUnprocessedSection_(),
    buildMissingJavaSuiteSection_()
  ];

  const messages = chunkEodMessages_(sections, EOD_SLACK_TEXT_LIMIT);
  for (let i = 0; i < messages.length; i++) {
    postEodSlackMessage_(token, channel, messages[i]);
  }

  Logger.log("Posted EOD to Slack channel " + channel + " in " + messages.length + " message(s).");
}

function buildEodHeading_() {
  return "*EOD*";
}

/**
 * KTLO_Daily_Data columns A and F:P, rows 1 through 10.
 */
function buildKtloDailySection_() {
  const sheet = eodRequireSheet_("KTLO_Daily_Data");
  const columnA = sheet.getRange("A1:A10").getDisplayValues();
  const columnsFToP = sheet.getRange("F1:P10").getDisplayValues();
  const rows = [];

  for (let i = 0; i < columnA.length; i++) {
    rows.push([columnA[i][0]].concat(columnsFToP[i]));
  }

  return "*KTLO_Daily_Data*\n" + formatEodTable_(rows);
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

  return "*Unprocessed ticket without Update (To be updated)*\n" +
    "Unprocessed tickets without data\n" +
    formatEodTable_(tableRows);
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
  return "*Missing ticket from Java suit (To be updated)*\n" + formatEodTable_(tableRows);
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

function postEodSlackMessage_(token, channel, text) {
  const response = UrlFetchApp.fetch("https://slack.com/api/chat.postMessage", {
    method: "post",
    contentType: "application/json; charset=utf-8",
    headers: { Authorization: "Bearer " + token },
    payload: JSON.stringify({
      channel: channel,
      text: text,
      unfurl_links: false,
      unfurl_media: false
    }),
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

function chunkEodMessages_(sections, limit) {
  const pieces = [];
  for (let i = 0; i < sections.length; i++) {
    const split = splitEodSection_(sections[i], limit);
    for (let j = 0; j < split.length; j++) {
      pieces.push(split[j]);
    }
  }

  const messages = [];
  let current = "";
  for (let i = 0; i < pieces.length; i++) {
    const addition = current ? "\n\n" + pieces[i] : pieces[i];
    if (current && current.length + addition.length > limit) {
      messages.push(current);
      current = pieces[i];
    } else {
      current += addition;
    }
  }
  if (current) {
    messages.push(current);
  }
  return messages;
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

function formatEodTable_(rows) {
  const dataRows = rows.filter(function (row) {
    return row.some(function (cell) {
      return !eodIsBlank_(cell);
    });
  });
  if (dataRows.length === 0) {
    return "None";
  }

  const rendered = dataRows.map(function (row) {
    return row.map(eodCellText_);
  });
  const widths = [];
  for (let r = 0; r < rendered.length; r++) {
    for (let c = 0; c < rendered[r].length; c++) {
      widths[c] = Math.max(widths[c] || 0, rendered[r][c].length);
    }
  }

  const lines = rendered.map(function (row) {
    return row.map(function (cell, index) {
      return cell.padEnd(widths[index], " ");
    }).join(" | ");
  });

  return "```\n" + lines.join("\n") + "\n```";
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
