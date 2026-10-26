# Move InActive tickets to On Hold

`MoveToOnHold.js` searches Jira with the customer-alias query, writes ten columns on the `Tickets` sheet, and transitions only the rows whose column J is `InActive`.

The query is in the script. It is the open issues assigned to `ops_dev_extraction` whose Customer Alias contains one of the listed customers (7-Eleven, Albertson's, Verizon, and the rest).

## Columns on Tickets

| Column | Header | Source |
| --- | --- | --- |
| A | Key | Jira |
| B | Summary | Jira |
| C | Catalyst (migrated) | Jira |
| D | Status | Jira, then `On Hold` after a successful transition |
| E | Assignee | Jira |
| F | Search Template | Jira |
| G | Reporter | Jira |
| H | Created | Jira |
| I | Customer Alias | Jira |
| J | Active Status | Formula |
| L | Inactive aliases | You. The script does not clear this column |

Column J for row 2:

```text
=IF(I2 = "", "", IF(ISNUMBER(MATCH(I2, L:L, 0)), "InActive", "Active"))
```

A row is moved only when column J is `InActive` and column D is not already `On Hold`. Active rows stay open.

## Install

1. Open the spreadsheet. Choose **Extensions > Apps Script**.
2. Add a script file and paste `MoveToOnHold.js`. Save. No manifest file.
3. Use the existing Script Property `Jira_API_TOKEN_SK`.
4. Put the inactive customer aliases in `Tickets` column L.
5. Run `installOnHoldMenu` once. The **On Hold** menu appears when the spreadsheet opens.

## Menu

**Fetch inactive tickets and move to On Hold** rewrites columns A–J, fills column J, waits for it to calculate, and transitions the InActive rows.

**Move InActive tickets to On Hold** uses the rows already on the sheet. It does not clear the sheet.

**Show On Hold transition id for FS-187174** shows the transition id Jira offers from that issue's current status.

## Local checks

```bash
node --check apps-script/MoveToOnHold.js
node --test test/on-hold.test.js
```
