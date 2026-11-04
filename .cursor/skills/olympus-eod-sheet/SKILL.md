---
name: olympus-eod-sheet
description: >-
  Build the Olympus team EOD and write it to The Olympus Google Sheet.
  Use when the user asks for the Olympus EOD, member contribution for
  ops-developers-olympus, or a date tab such as 04-Nov-2026.
---

# Olympus EOD sheet

This skill writes one day's Olympus status into The Olympus workbook. It follows the SKILL EOD upload: one Jira pull, one date tab, credentials kept out of git and out of the log.

## Credentials

Use the same Jira token and Google service-account JSON as `.cursor/skills/skill-eod-sheet/credentials/`.

This uploader reads those files when they are present. It also reads copies in this skill's `credentials/` folder. The gitignored copy wins over the `.example` file. A value that still contains `REPLACE_WITH_` or `REPLACE_ME` is empty.

- `jira.env`: `JIRA_EMAIL` and `JIRA_API_TOKEN`
- `google-service-account.json`: the Google service-account key
- `google-access-token.txt`: one access token, only when a service account is not used

Share the workbook with the service-account email as an Editor. Do not print the token or the private key. Do not commit them.

If the Google file is missing, the run prints the table and exits 2. The sheet is not changed.

## Sheet

- Spreadsheet: `1dPNzBUKZF4Xp-QPpY5ZMkRN_-a_6NPj4BAAMWfMRcLE`
- Link: https://docs.google.com/spreadsheets/d/1dPNzBUKZF4Xp-QPpY5ZMkRN_-a_6NPj4BAAMWfMRcLE/edit
- Tab name: the report date, `04-Nov-2026` for 4 Nov 2026
- Do not replace the tab whose gid is `377349833`

A later run for the same date replaces that date tab.

## Roster

Jira group `ops-developers-olympus`. The report lists these eight people, including zeros:

Sriya Nayak, Stanley, Chandrakanth (Jira: Chandru K S), Saipriyadarsini, Karthik C, Aldan Immanuel C, Vanjarapu Amrutha Valli (Jira: Amrutha Valli), Sangeetha R.

## What counts

The day is Asia/Kolkata, from midnight until the next midnight.

- Total Ticket Worked: the member changed the status to Resolved, Under Reporter, Pending Audits, or Under OCR.
- Total Resolved: changed to Resolved.
- Total Transitioned: changed to Under Reporter, Pending Audits, or Under OCR.
- A ticket that does both counts in both columns, and once in Total Ticket Worked.
- Skill: ITD Whiteboard is CA-Feasible.
- Non Skill: ITD Whiteboard is empty, CA-Not Feasible, or ET-Transition.
- Total Skill Worked and Total Skill Transitioned use that skill rule on the same status changes.
- Analysis, Dev, Unit Testing, and Review are `customfield_11184` (else `customfield_15845`), `customfield_11187`, `customfield_11185`, and `customfield_11186`. Jira stores minutes. The sheet shows hours.
- Time Tracking is that member's worklogs started on the report day.
- Total Efforts Spend is the effort on tickets they resolved or transitioned.
- Overall time Spent is that effort plus Time Tracking.
- Each person has 7 available hours. Time Spent / day is overall hours / 7.
- Skill utilisation is skill effort plus worklogs on skill tickets, divided by overall time.

## Sections

1. Member contribution
2. Member Contribution in Tickets

## How to run

From the repo root, for today in Asia/Kolkata:

```bash
python3 .cursor/skills/olympus-eod-sheet/scripts/upload_olympus_eod.py
```

For a chosen day:

```bash
python3 .cursor/skills/olympus-eod-sheet/scripts/upload_olympus_eod.py --date 2026-11-04
```

`--dry-run` prints the member table and does not call Google. `--self-test` checks the counting rules and does not call Jira or Google.

Environment variables override the files: `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_API_TOKEN_FILE`, `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_ACCESS_TOKEN`, `GOOGLE_ACCESS_TOKEN_FILE`.
