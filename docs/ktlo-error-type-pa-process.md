# KTLO Error Type PA Process

This is the daily process for Error Type and Code Adapt tickets. It covers who does the work, which tickets can be planned, and what gets updated at the end of the day.

## Teams and members

There are 6 teams. Tickets are shared across these teams.

| Team | KTLO skill members |
| --- | --- |
| Nebula | Venkat Ganesh R |
| Neon | Chandana C Savalgimath, Nitish Kumar Jangam |
| Nexus | Esvar K N, Janani Nataraj Kumar, K Pavankumar, Tharun Vijayakumar |
| Nova | Pooja Sri Balakrishnan, Raghuram selvaraj, Sartaj R |
| Olympus | Karthik C, Saipriyadarsini Balaji, Chandru K S, Stanley Deivanayagam |
| Orin | Anusha M, Dinesh Ramasamy, Yogesh Thambidurai, Smitha R Gulalakai |

Each team has a **SPOC** and a **Secondary SPOC**. After the end-of-day notification, they update missed tickets and tickets that were not processed.

## How the day runs

1. **In time is 8:30 AM.**
2. **After PAD, a script updates the ticket list.**
3. **Tickets are planned with an equal share across teams.** Planning follows this order: team, then squad, then the overall team.
4. **A ticket already with a skill member stays with that person.** It is not moved to another team or squad.
5. **During the day, the team fills in feasibility** on the Overall-Analysis sheet, including the reason when a ticket is not feasible. Those reasons are how failure data is captured.
6. **At end of day, an Apps Script updates the overall sheet**, takes a sheet backup, and sends the Slack notification.
7. **The Daily KTLO sheet is updated from that run.**
8. **The SPOC and Secondary SPOC close the gaps** by updating missed and unprocessed tickets.

## Which tickets can be planned

A ticket is planned only when it is **SKILL Eligible**. There are two checks: Error Type and Code Adapt. A ticket that was already handled in an earlier run is left out.

### 1. Error Type (column AM)

Column AM is **SKILL Eligible** only when every condition below is true.

| Check | Column | Required value |
| --- | --- | --- |
| Not already processed | Error Type or Code Adapt processed flag | Anything other than "Already Processed" |
| Source eligibility | AE | Eligible |
| PAD status | AI | Non PAD |
| Provider band | AJ | NON HYP_Band |

If any condition fails, column AM is **Not Eligible**.

What those checks mean:

- **Already processed.** The ticket was already handled through Error Type or Code Adapt. It is not planned again.
- **Source eligibility.** Column AE must say Eligible.
- **Non PAD.** The ticket is not a process automation defect. Defects that are left out include MissingChargeDetected, Charge_Extracted_Twice, STATEMENTS_IN_PRODUCTION, and OB_Missing.
- **NON HYP_Band.** The ticket is outside a Hypercare provider band.

### 2. Code Adapt (column AO)

Column AO uses the Code Adapt tier in column AG.

| Column AG (CODE ADAPT) | Column AO |
| --- | --- |
| Code Adapt Primary, Code Adapt Secondary, or Code Adapt Last | SKILL Eligible |
| Not Eligible, Source not eligible, TOP_300-Hyp, or blank | Not Eligible |
| Already processed through Code Adapt | Not Eligible |

Primary, Secondary, and Last are the active tiers. They are worked in that order: Primary, then Secondary, then Last.

## How filtering works

Tickets pass through four filters, in this order.

1. **Already processed.** Remove tickets already handled through Error Type or Code Adapt.
2. **Technical limits.** Check the file format and provider rules (source eligibility and HYP provider). Remove PAD defect types such as MissingChargeDetected, Charge_Extracted_Twice, STATEMENTS_IN_PRODUCTION, and OB_Missing.
3. **Priority tier.** Group the remaining Code Adapt tickets into Primary, Secondary, and Last.
4. **Feasibility.** A skill-eligible ticket can still be set aside when it is not feasible to run. The team records the reason on the Overall-Analysis sheet.

### Reasons a ticket is not feasible

- Transition to AA
- Already fixed by dev / Fixed by Dev
- Multibound / Multi Bond bills
- Complex template
- Bill is more than 10 pages
- EZ fix
- INT Bill / International Bill
- Connector Upgrade
- Navigation issue

## End-of-day update

The Apps Script does three things:

1. Writes the result fields on the overall sheet.
2. Backs up the sheet.
3. Sends the Slack notification, including screenshots of the field updates.

Fields written on each ticket:

- Error Type agent result
- Error Type engineer result
- ET processed
- Code Adapt agent result
- Code Adapt engineer result
- CA processed

The Daily KTLO sheet is refreshed from this update. After the Slack notification, the team's SPOC and Secondary SPOC update any missed or unprocessed tickets.
