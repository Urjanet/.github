---
name: skill-eod-sheet
description: >-
  Upload the SKILL EOD ticket list into the Google Sheet, the same kind of
  job as the PMU MTD sheet upload. Use when the user says run SKILL EOD,
  upload the skillable sheet, or run for a date such as Nov 04. JQL is
  labels IN (CASkillable-dd-Mon) AND status != "On Hold (migrated)".
---

# SKILL EOD sheet upload

This is a project skill. It lives at `.cursor/skills/skill-eod-sheet/` in the repository, so Cursor loads it for this project, including Cloud Agents. It is not a personal skill under the home directory.

This is the sheet-upload job for SKILL EOD. It follows the same shape as the PMU MTD job: one Jira query, one row per ticket, written into a known Google Sheet. It does not post to Slack and it does not print tokens.

## Credentials

Read credentials from `credentials/` in this skill. Do not print the file contents.

- `credentials/jira.env` or `credentials/jira.env.example` holds `JIRA_EMAIL` and `JIRA_API_TOKEN`.
- `credentials/google-service-account.json` or `credentials/google-service-account.json.example` holds the Google service-account JSON.
- `credentials/google-access-token.txt` or `credentials/google-access-token.txt.example` holds one access token when a service account is not used.

The copy without `.example` is gitignored and wins when it exists. A value that still contains `REPLACE_WITH_` or `REPLACE_ME` is empty. If the Google files are still placeholders, stop and say the sheet was not updated. Tell the user which file to fill in.

## When to run

Run this skill when the user asks to upload SKILL EOD, fill the skillable sheet, or "run for" a calendar date. A date with no other instruction still means this upload.

Do not run the PMU MTD job for this. MTD writes the monthly workbook `1aFvxbR76OJd6jNCUxwxCkdNqsfAhAM3imAwhgQWOpZ0` from the MTD filter. SKILL EOD writes a different sheet from the label query below.

## Sheet

- Spreadsheet: `1w3uc-rSxWuHBmGjh6IRpjBt1kWhDiQG3QLXalDvKtno`
- Link: https://docs.google.com/spreadsheets/d/1w3uc-rSxWuHBmGjh6IRpjBt1kWhDiQG3QLXalDvKtno/edit
- Date tab name: `Nov 04` for 4 Nov, matching the existing `Nov 03` tab. The form is `<Mon> <dd>`.

Create that tab when it does not exist, then write the day's member-contribution report there. On a later run for the same date, replace that tab. Do not write the tab whose gid is `1231097422`. That gid is the existing `Nov 03` report.

The report matches the 3 Nov tab. Row 1 is the title `Skillable EOD — 4 Nov 2026`. The member table columns are Team, Member, Available hours, Worked, Resolved, Transitioned, Skill resolved, Skill transitioned, Skill addressed, Non-skill resolved, Non-skill transitioned, Total hours, Manual hours, Skill hours, Non-skill hours, Skill leverage, and Skill performance.

Count a ticket for a person when that person moved it, on the report day in Asia/Kolkata, to Resolved, Pending Audits, Under Reporter, or Under OCR. Resolved is the move to Resolved. The other three are Transitioned. CA-Feasible is Skill. Every other ITD Whiteboard value is Non-skill. Skill and non-skill hours are analysis + unit testing + development minutes, divided by 60. Analysis is `customfield_11184` when that field is set. Manual hours are that member's Jira worklogs on the report day. Available hours are 7. The skill roster is listed even when the counts are zero. Anyone else who moved a label ticket is listed under `ops_Dev_extraction`.

## Query

Label form is `CASkillable-<dd>-<Mon>` with a zero-padded day and a three-letter month: `CASkillable-04-Nov`, `CASkillable-26-Oct`.

```
labels IN (CASkillable-04-Nov) AND status != "On Hold (migrated)"
```

Substitute the date. Include every status except `On Hold (migrated)`, including open tickets and tickets that also carry an ET label. Jira is `https://arcadiapower.atlassian.net`. Search with `GET /rest/api/3/search/jql` and follow `nextPageToken` until `isLast`.

## How to upload

Fill in the credential files first. Then, from the repo root:

```bash
python3 .cursor/skills/skill-eod-sheet/scripts/upload_skill_eod.py --date 2026-11-04
```

Environment variables still override the files: `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_API_TOKEN_FILE`, `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_ACCESS_TOKEN`, `GOOGLE_ACCESS_TOKEN_FILE`.

`--dry-run` fetches Jira and prints the row count and the On Hold exclusion count without calling Google. It exits 0 and does not change the sheet. A real run exits 0 only after the sheet body is replaced. Exit 2 means Google credentials are missing or were rejected, and the sheet was not changed.

The Google identity must already have edit access on that spreadsheet, the same way the PMU MTD run uses a credential that can edit the MTD workbook. Do not print the Jira token, the Google token, or the service-account private key. Do not commit them.

## Column rules

Match the header that is already on the tab. Fill only columns the script recognizes; leave the others blank rather than inventing a layout.

When those columns exist, score them as follows.

- Resolver is custom field `customfield_11178`. When it is empty on a Closed or Resolved ticket, use the person who last moved the ticket to Closed or Resolved. The template PR author is not the resolver.
- Skill group is Skill, Non Skill, or Other Team. The roster is in the script. `B Saipriyadarsini Saipriyadarsini` is Saipriyadarsini Balaji.
- Update type comes from artifacts, not from the AI fields. A template PR and an audit commit is Connector Upgrade+Override. A template PR only is Connector Upgrade. An audit only is Override. Neither is Non-resolved.
- A template PR is a `templates3` pull request from the Jira development panel or from a comment. An audit is an `auditoverrides5` commit URL in a comment. Template added-by is the Bitbucket author when the panel has it, otherwise the comment author. Audit added-by is the Jira comment author.
- A dash or a blank AI result is empty. Do not treat a dash as a Code Adapt result.
- One audit commit pasted on several tickets still counts on each ticket. Say so in the run summary when a commit is shared.

## After the run

Report the date, the JQL, how many tickets were written, how many On Hold tickets were excluded, and the sheet link. If Google credentials are missing, say the sheet was not updated and give the dry-run count. Do not substitute a canvas for the sheet write.
