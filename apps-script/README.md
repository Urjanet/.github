# Move B27 tickets to On Hold

`MoveToOnHold.js` follows the same opening as `fetchJiraDataFromB27Query`: read the JQL in `KTLO_Daily_Data!B27`, write those issues onto `Overall-Analysis`, then transition each issue to **On Hold**.

It is a second script file in the existing Apps Script project. It does not replace the KTLO distribution script, and it does not need `appsscript.json`.

## Install

1. Open the spreadsheet. Choose **Extensions > Apps Script**.
2. Add a script file and paste `MoveToOnHold.js` into it. Save. Leave the existing KTLO file in place.
3. The API token is the Script Property already used by the KTLO script: `Jira_API_TOKEN_SK`. The account email in the file is `sowmiya.kirubakaran@arcadia.com`.
4. Run `installOnHoldMenu` once and approve the permissions. Reloading the spreadsheet shows **KTLO On Hold**.

Or add these items to the existing `onOpen` menu:

```javascript
.addItem('Fetch B27 tickets and move to On Hold', 'fetchJiraDataAndMoveToOnHold')
.addItem('Move loaded tickets to On Hold', 'moveLoadedTicketsToOnHold')
```

## What the menu does

**Fetch B27 tickets and move to On Hold** asks before it runs. It clears `Overall-Analysis` rows 2:1000, writes the same 20 columns as the B27 fetch (status is column C), then posts the On Hold transition for every issue that is not already On Hold. Column C becomes `On Hold` only after Jira accepts the transition.

**Move loaded tickets to On Hold** leaves the sheet contents in place. It reads issue keys from column A, skips rows whose column C is already On Hold, and transitions the rest.

**Show On Hold transition id for FS-187174** lists the transitions available from that issue's current status and shows the id whose destination is On Hold. That id changes with the source status, so the move uses whatever id Jira offers for each ticket.

Skill labels and ticket distribution stay in the existing KTLO script.

## Local checks

```bash
node --check apps-script/MoveToOnHold.js
node --test test/on-hold.test.js
```
