"""Olympus team EOD: member contribution and the tickets behind it.

The day is Asia/Kolkata. A ticket counts for a member when that member
moves it, after local midnight, to Resolved, Under Reporter, Pending
Audits, or Under OCR.

Resolved is the move to Resolved. The other three are Transitioned.
A ticket moved to both on the same day counts in both, and once in
Total Ticket Worked.

Skill is ITD Whiteboard = CA-Feasible. Non Skill is an empty whiteboard,
CA-Not Feasible, or ET-Transition. Effort fields are minutes. Time
tracking is that member's Jira worklogs started on the report day.
Each member has 7 available hours.
"""

from __future__ import annotations

import csv
from datetime import datetime, timedelta, timezone
from pathlib import Path

IST = timezone(timedelta(hours=5, minutes=30))
AVAILABLE_HOURS = 7
RESOLVED = "Resolved"
TRANSITION = {"Pending Audits", "Under Reporter", "Under OCR"}
QUALIFYING = {RESOLVED, *TRANSITION}

ROSTER = [
    {"label": "Sriya Nayak", "jira_name": "Sriya Nayak", "account_id": "630ce9149796033b256baa38"},
    {"label": "Stanley", "jira_name": "Stanley Deivanayagam", "account_id": "712020:c62627da-e408-46af-b58b-8d63ca7a11fd"},
    {"label": "Chandrakanth", "jira_name": "Chandru K S", "account_id": "712020:ca41a80c-aa6a-47f1-9e83-f6e7fbe40962"},
    {"label": "Saipriyadarsini", "jira_name": "B Saipriyadarsini Saipriyadarsini", "account_id": "712020:f22f3465-eeeb-4727-b025-397f5355a6b3"},
    {"label": "Karthik C", "jira_name": "Karthik C", "account_id": "712020:673d7247-a68f-452d-903a-be0c0a062c0d"},
    {"label": "Aldan Immanuel C", "jira_name": "Aldan Immanuel C", "account_id": "712020:5c70012b-a674-4aef-a864-359f3a8c0567"},
    {"label": "Vanjarapu Amrutha Valli", "jira_name": "Amrutha Valli", "account_id": "712020:99123952-ca9e-4b9f-b9a6-3df43dc6fb20"},
    {"label": "Sangeetha R", "jira_name": "Sangeetha R", "account_id": "712020:5ff4d953-9590-4982-9451-829f3f7d17d7"},
]

def norm(name: str | None) -> str:
    return " ".join((name or "").replace(".", " ").split()).lower()


ACCOUNT_LABEL = {person["account_id"]: person["label"] for person in ROSTER}
NAME_LABEL = {}
for person in ROSTER:
    NAME_LABEL[norm(person["jira_name"])] = person["label"]
    NAME_LABEL[norm(person["label"])] = person["label"]


def member_label(author: dict | None) -> str | None:
    author = author or {}
    account = author.get("accountId") or ""
    if account in ACCOUNT_LABEL:
        return ACCOUNT_LABEL[account]
    return NAME_LABEL.get(norm(author.get("displayName")))


def parse_jira_time(text: str) -> datetime | None:
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+0000"
    for fmt in ("%Y-%m-%dT%H:%M:%S.%f%z", "%Y-%m-%dT%H:%M:%S%z"):
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    return None


def day_window(day: datetime) -> tuple[datetime, datetime]:
    start = datetime(day.year, day.month, day.day, tzinfo=IST)
    return start, start + timedelta(days=1)


def plain_number(value: float) -> int | float:
    rounded = round(value + 1e-9, 2)
    if rounded == int(rounded):
        return int(rounded)
    return float(f"{rounded:.2f}".rstrip("0").rstrip("."))


def tab_name(day: datetime) -> str:
    return day.strftime("%b %d")


def jql_quote(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def status_jql(day: datetime, jira_name: str) -> str:
    begin = (day - timedelta(days=1)).strftime("%Y-%m-%d")
    finish = (day + timedelta(days=2)).strftime("%Y-%m-%d")
    statuses = ", ".join(jql_quote(status) for status in ("Resolved", "Pending Audits", "Under Reporter", "Under OCR"))
    return (
        f"status changed BY {jql_quote(jira_name)} TO ({statuses}) "
        f'AFTER "{begin}" BEFORE "{finish}"'
    )


def worklog_jql(day: datetime, jira_name: str) -> str:
    day_text = day.strftime("%Y-%m-%d")
    return f"worklogAuthor = {jql_quote(jira_name)} AND worklogDate = {jql_quote(day_text)}"


def canon_status(value: str | None) -> str:
    key = " ".join((value or "").split()).lower()
    return {
        "resolved": RESOLVED,
        "pending audits": "Pending Audits",
        "under reporter": "Under Reporter",
        "under ocr": "Under OCR",
    }.get(key, "")


# Hours for one worked ticket. Columns are Non Top, Top 1000, Top 300.
# Top 300 and Top 1000 are the catalyst expected. Every other band uses Non Top,
# the generalised expected.
CATALYST_EXPECTED = [
    ("Bill_Change", 1, 1.5, 2),
    ("Bill_Change_History", 1, 1.5, 2),
    ("Bill_Change_Major", 4, 4, 6),
    ("Initial_Bill_Change", 1, 1.5, 2),
    ("Initial_Bill_Change_History", 2, 1.5, 2),
    ("Migration", 3, 3, 3),
    ("Zendesk", 2, 2, 3),
    ("NAVIGATION_EVENT_TRACKING", 1, 1, 1),
    ("Product_Enhancements", 1, 1, 2),
    ("Website_Change_History", 2, 2, 2),
    ("Website_Change", 1.5, 1.5, 1.5),
    ("Provider Addition", 0.16, 0.16, 0.16),
    ("ITD_History", 12.5, 12.5, 12.5),
    ("Initial Build", 8, 8, 8),
    ("Source Cleaner", 3, 3, 3),
    ("Initial_Website_Change_History", 3.5, 3.5, 3.5),
    ("Feature_Implement", 10.5, 10.5, 10.5),
    ("Initial_New_Url_Mapping", 2.5, 2.5, 2.5),
    ("NEW_URL_MAPPING", 2.5, 2.5, 2.5),
    ("DeliveryTesting", 1, 1, 1),
    ("Special_OPS", 1, 1.5, 3),
    ("Change_Request", 3, 3, 3),
]
WITHIN = "Within expected"
OVER = "Over expected"
NO_EXPECTED = "No expected"
CATALYST_BASIS = "Catalyst expected"
GENERAL_BASIS = "Generalised expected"
BAND_FILE = Path(__file__).resolve().parent.parent / "data" / "pib-2026-band.csv"
_BANDS: dict[str, str] | None = None


def name_key(value: str | None) -> str:
    return " ".join((value or "").replace("_", " ").replace("-", " ").split()).lower()


EXPECTED_BY_CATALYST = {
    name_key(name): {"non top": non_top, "top 1000": top_1000, "top 300": top_300}
    for name, non_top, top_1000, top_300 in CATALYST_EXPECTED
}


def load_bands() -> dict[str, str]:
    global _BANDS
    if _BANDS is not None:
        return _BANDS
    bands: dict[str, str] = {}
    with BAND_FILE.open(newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            name = (row.get("templateName") or "").strip()
            if name and name not in bands:
                bands[name] = (row.get("Band") or "").strip()
    _BANDS = bands
    return bands


def option_value(value) -> str:
    if isinstance(value, dict):
        return str(value.get("value") or value.get("name") or "").strip()
    return str(value or "").strip()


def band_column(template: str, bands: dict[str, str]) -> tuple[str, str]:
    if not template:
        return "No template", "non top"
    band = bands.get(template)
    if band is None:
        return "Not in PIB 2026", "non top"
    key = name_key(band)
    if key == "top 300":
        return band, "top 300"
    if key == "top 1000":
        return band, "top 1000"
    return band or "Non Top", "non top"


def expectation(catalyst: str, column: str) -> tuple[float | None, str]:
    row = EXPECTED_BY_CATALYST.get(name_key(catalyst))
    if row is None:
        return None, NO_EXPECTED
    if column in {"top 300", "top 1000"}:
        return row[column], CATALYST_BASIS
    return row["non top"], GENERAL_BASIS


def judge(actual: float, expected: float | None) -> tuple[str, float | str]:
    if expected is None:
        return NO_EXPECTED, ""
    actual_hours = round(actual + 1e-9, 2)
    expected_hours = round(float(expected) + 1e-9, 2)
    status = WITHIN if actual_hours <= expected_hours else OVER
    return status, round(actual_hours - expected_hours + 1e-9, 2)


def classify(whiteboard: str | None) -> str:
    text = " ".join((whiteboard or "").split())
    key = text.lower()
    if key == "ca-feasible":
        return "Skill"
    if key in {"", "ca-not feasible", "et-transition"}:
        return "Non Skill"
    return "Other"


def number(value) -> float:
    if value is None or value == "":
        return 0.0
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def effort_minutes(fields: dict) -> dict[str, float]:
    analysis = fields.get("customfield_11184")
    if analysis is None:
        analysis = fields.get("customfield_15845")
    return {
        "analysis": number(analysis),
        "dev": number(fields.get("customfield_11187")),
        "unit": number(fields.get("customfield_11185")),
        "review": number(fields.get("customfield_11186")),
    }


def hours_of(minutes: float) -> float:
    return minutes / 60.0


def in_window(when: datetime | None, start: datetime, end: datetime) -> bool:
    return when is not None and start <= when < end


def collect(issues: list[dict], day: datetime, bands: dict[str, str] | None = None) -> dict[str, dict]:
    bands = load_bands() if bands is None else bands
    start, end = day_window(day)
    blank = {label: empty_bucket() for label in (person["label"] for person in ROSTER)}
    for issue in issues:
        fields = issue.get("fields") or {}
        whiteboard = str(fields.get("customfield_11239") or "").strip()
        kind = classify(whiteboard)
        minutes = effort_minutes(fields)
        per_member: dict[str, dict] = {}

        def bucket(label: str) -> dict:
            row = per_member.get(label)
            if row is None:
                row = {
                    "resolved": False,
                    "transitioned": False,
                    "statuses": [],
                    "seconds": 0,
                }
                per_member[label] = row
            return row

        for history in issue.get("_histories") or []:
            when = parse_jira_time(history.get("created") or "")
            if not in_window(when, start, end):
                continue
            label = member_label(history.get("author"))
            if not label:
                continue
            for item in history.get("items") or []:
                if (item.get("field") or "").lower() != "status":
                    continue
                status = canon_status(item.get("toString"))
                if status not in QUALIFYING:
                    continue
                row = bucket(label)
                if status not in row["statuses"]:
                    row["statuses"].append(status)
                if status == RESOLVED:
                    row["resolved"] = True
                else:
                    row["transitioned"] = True
        for entry in issue.get("_worklogs") or []:
            when = parse_jira_time(entry.get("started") or "")
            if not in_window(when, start, end):
                continue
            label = member_label(entry.get("author"))
            if not label:
                continue
            bucket(label)["seconds"] += int(entry.get("timeSpentSeconds") or 0)

        for label, action in per_member.items():
            addressed = action["resolved"] or action["transitioned"]
            record = blank[label]
            ticket = ticket_row(issue, fields, whiteboard, kind, minutes, action, addressed, bands)
            record["tickets"].append(ticket)
            record["tracked_seconds"] += action["seconds"]
            if kind == "Skill":
                record["skill_worklog_seconds"] += action["seconds"]
            if not addressed:
                continue
            record["worked"] += 1
            if ticket["validation"] == WITHIN:
                record["within"] += 1
            elif ticket["validation"] == OVER:
                record["over"] += 1
            elif ticket["validation"] == NO_EXPECTED:
                record["no_expected"] += 1
            record["resolved"] += int(action["resolved"])
            record["transitioned"] += int(action["transitioned"])
            if kind == "Skill":
                record["skill_worked"] += 1
                record["skill_transitioned"] += int(action["transitioned"])
            effort = sum(minutes.values())
            record["analysis"] += minutes["analysis"]
            record["dev"] += minutes["dev"]
            record["unit"] += minutes["unit"]
            record["review"] += minutes["review"]
            record["effort"] += effort
            if kind == "Skill":
                record["skill_effort"] += effort
            elif kind == "Non Skill":
                record["nonskill_effort"] += effort
            if action["resolved"]:
                record["resolution_effort"] += effort
                record["resolution_seconds"] += action["seconds"]
            if action["transitioned"]:
                record["transition_effort"] += effort
                record["transition_seconds"] += action["seconds"]
            record["expected_hours"] += ticket["expected_hours"]
    return blank


def empty_bucket() -> dict:
    return {
        "worked": 0,
        "resolved": 0,
        "transitioned": 0,
        "skill_worked": 0,
        "skill_transitioned": 0,
        "analysis": 0.0,
        "dev": 0.0,
        "unit": 0.0,
        "review": 0.0,
        "effort": 0.0,
        "skill_effort": 0.0,
        "nonskill_effort": 0.0,
        "resolution_effort": 0.0,
        "transition_effort": 0.0,
        "tracked_seconds": 0,
        "skill_worklog_seconds": 0,
        "resolution_seconds": 0,
        "transition_seconds": 0,
        "within": 0,
        "over": 0,
        "no_expected": 0,
        "expected_hours": 0.0,
        "tickets": [],
    }


def ticket_row(issue, fields, whiteboard, kind, minutes, action, addressed, bands: dict[str, str]) -> dict:
    if action["resolved"] and action["transitioned"]:
        activity = "Resolved and transitioned"
    elif action["resolved"]:
        activity = "Resolved"
    elif action["transitioned"]:
        activity = "Transitioned"
    else:
        activity = "Time logged"
    project = fields.get("project") or {}
    project_key = project.get("key") if isinstance(project, dict) else ""
    catalyst = option_value(fields.get("customfield_11171"))
    template = option_value(fields.get("customfield_12282"))
    effort = hours_of(sum(minutes.values())) if addressed else 0.0
    band_label, column = band_column(template, bands)
    expected, basis = expectation(catalyst, column)
    status, variance = judge(effort, expected) if addressed else ("", "")
    if not addressed:
        basis = ""
        expected_cell: float | str = ""
        variance = ""
    else:
        expected_cell = "" if expected is None else plain_number(float(expected))
    return {
        "key": issue.get("key") or "",
        "summary": fields.get("summary") or "",
        "project": project_key or "",
        "status": (fields.get("status") or {}).get("name") or "",
        "assignee": ((fields.get("assignee") or {}).get("displayName") or ""),
        "action": activity,
        "statuses": ", ".join(action["statuses"]),
        "whiteboard": whiteboard or "empty",
        "class": kind,
        "addressed": addressed,
        "analysis": hours_of(minutes["analysis"]) if addressed else 0.0,
        "dev": hours_of(minutes["dev"]) if addressed else 0.0,
        "unit": hours_of(minutes["unit"]) if addressed else 0.0,
        "review": hours_of(minutes["review"]) if addressed else 0.0,
        "tracked": action["seconds"] / 3600,
        "effort": effort,
        "catalyst": catalyst,
        "template": template,
        "band": band_label,
        "basis": basis if addressed else "",
        "expected": expected_cell,
        "expected_hours": float(expected) if addressed and expected is not None else 0.0,
        "variance": plain_number(variance) if isinstance(variance, float) else variance,
        "validation": status,
    }


def member_view(record: dict) -> dict:
    effort_hours = hours_of(record["effort"])
    skill_hours = hours_of(record["skill_effort"])
    tracked = record["tracked_seconds"] / 3600
    overall = effort_hours + tracked
    skill_time = skill_hours + record["skill_worklog_seconds"] / 3600
    return {
        "worked": record["worked"],
        "resolved": record["resolved"],
        "transitioned": record["transitioned"],
        "skill_worked": record["skill_worked"],
        "skill_transitioned": record["skill_transitioned"],
        "analysis": hours_of(record["analysis"]),
        "dev": hours_of(record["dev"]),
        "unit": hours_of(record["unit"]),
        "review": hours_of(record["review"]),
        "tracked": tracked,
        "effort": effort_hours,
        "skill_effort": skill_hours,
        "nonskill_effort": hours_of(record["nonskill_effort"]),
        "resolution_effort": hours_of(record["resolution_effort"]),
        "transition_effort": hours_of(record["transition_effort"]),
        "overall": overall,
        "overall_resolution": hours_of(record["resolution_effort"]) + record["resolution_seconds"] / 3600,
        "overall_transition": hours_of(record["transition_effort"]) + record["transition_seconds"] / 3600,
        "skill_time": skill_time,
        "within": record["within"],
        "over": record["over"],
        "no_expected": record["no_expected"],
        "expected_hours": record["expected_hours"],
    }


def percent(part: float, whole: float) -> str:
    if whole <= 0:
        return ""
    return f"{part / whole * 100:.1f}%"


def per_day(hours: float) -> str:
    """Overall hours as a percentage of the 7 available hours."""
    return percent(hours, AVAILABLE_HOURS)


def member_header() -> list[str]:
    return [
        "Team member",
        "Total Ticket Worked",
        "Total Resolved",
        "Total Transitioned",
        "Total Skill Worked",
        "Total Skill Transitioned",
        "Analysis Efforts",
        "Dev Efforts",
        "Unit Testing Efforts",
        "Review Efforts",
        "Time Tracking",
        "Total Efforts Spend",
        "Total Efforts Spent on Skill",
        "Total Efforts Spend on Non Skill",
        "Total Efforts Spend on Resolution",
        "Total Efforts Spend on Transition",
        "Overall time Spent",
        "Overall Time spent on Resolution",
        "Overall Time spent on Transition",
        "Time Spent / day",
        "Skill Utilisation percentage against overall",
        "Within expected",
        "Over expected",
        "No expected",
    ]


def member_line(label: str, view: dict) -> list:
    return [
        label,
        view["worked"],
        view["resolved"],
        view["transitioned"],
        view["skill_worked"],
        view["skill_transitioned"],
        plain_number(view["analysis"]),
        plain_number(view["dev"]),
        plain_number(view["unit"]),
        plain_number(view["review"]),
        plain_number(view["tracked"]),
        plain_number(view["effort"]),
        plain_number(view["skill_effort"]),
        plain_number(view["nonskill_effort"]),
        plain_number(view["resolution_effort"]),
        plain_number(view["transition_effort"]),
        plain_number(view["overall"]),
        plain_number(view["overall_resolution"]),
        plain_number(view["overall_transition"]),
        per_day(view["overall"]),
        percent(view["skill_time"], view["overall"]),
        view["within"],
        view["over"],
        view["no_expected"],
    ]


def planned_header() -> list[str]:
    return [
        "Team member",
        "Efforts hours from ticket",
        "Expected hours to planned as per catalyst",
    ]


def planned_line(label: str, view: dict) -> list:
    return [label, plain_number(view["effort"]), plain_number(view["expected_hours"])]


def planned_total(views: list[tuple[str, dict]]) -> list:
    return [
        "Total",
        plain_number(sum(view["effort"] for _label, view in views)),
        plain_number(sum(view["expected_hours"] for _label, view in views)),
    ]


def ticket_header() -> list[str]:
    return [
        "Team member",
        "Ticket",
        "Summary",
        "Project",
        "Current status",
        "Action",
        "Statuses changed to",
        "ITD Whiteboard",
        "Class",
        "Assignee",
        "Analysis Efforts",
        "Dev Efforts",
        "Unit Testing Efforts",
        "Review Efforts",
        "Time Tracking",
        "Efforts",
        "Catalyst",
        "Template",
        "Band",
        "Expected basis",
        "Expected hours",
        "Variance",
        "Validation",
    ]


def ticket_line(label: str, ticket: dict) -> list:
    key = ticket["key"]
    link = f'=HYPERLINK("https://arcadiapower.atlassian.net/browse/{key}","{key}")' if key else ""
    show_effort = ticket["addressed"]
    return [
        label,
        link,
        ticket["summary"],
        ticket["project"],
        ticket["status"],
        ticket["action"],
        ticket["statuses"],
        ticket["whiteboard"],
        ticket["class"],
        ticket["assignee"],
        plain_number(ticket["analysis"]) if show_effort else "",
        plain_number(ticket["dev"]) if show_effort else "",
        plain_number(ticket["unit"]) if show_effort else "",
        plain_number(ticket["review"]) if show_effort else "",
        plain_number(ticket["tracked"]),
        plain_number(ticket["effort"]) if show_effort else "",
        ticket["catalyst"],
        ticket["template"],
        ticket["band"],
        ticket["basis"],
        ticket["expected"],
        ticket["variance"],
        ticket["validation"],
    ]


def build_sheet(
    day: datetime,
    issues: list[dict],
    generated: datetime,
    bands: dict[str, str] | None = None,
) -> list[list]:
    grouped = collect(issues, day, bands)
    views = [(person["label"], member_view(grouped[person["label"]])) for person in ROSTER]
    title = f"Olympus EOD — {day.day} {day.strftime('%b')} {day.year}"
    stamp = generated.astimezone(IST).strftime("%Y-%m-%d %H:%M IST")
    rules = (
        "Total Ticket Worked: status changed after midnight IST to Resolved, Under Reporter, Pending Audits, or Under OCR. "
        "Total Resolved is the move to Resolved. Total Transitioned is the move to Under Reporter, Pending Audits, or Under OCR. "
        "A ticket moved to both counts in both, and once in Total Ticket Worked. "
        "Skill: ITD Whiteboard = CA-Feasible. Non Skill: empty, CA-Not Feasible, or ET-Transition. "
        "Analysis, Dev, Unit Testing, and Review are the ticket effort fields, in hours (Jira stores minutes). "
        "Time Tracking is the member's Jira worklog hours started that day. "
        "Total Efforts Spend is the effort on tickets they resolved or transitioned. "
        "Overall time Spent adds Time Tracking to that effort. "
        "Each member has 7 available hours. Time Spent / day is overall hours divided by 7, shown as a percentage of that day. "
        "Skill utilisation is skill effort plus skill-ticket worklogs, divided by overall time. "
        "Worked tickets are validated on effort hours against PIB 2026. "
        "Top 300 and Top 1000 use the catalyst expected for that band. "
        "Every other band, a missing template, or #N/A uses the Non Top hours, the generalised expected. "
        "Within expected means the effort is at or under that number."
    )
    rows: list[list] = [
        [title],
        ["Team Olympus", "ops-developers-olympus", "Asia/Kolkata", f"Generated {stamp}"],
        [rules],
        [],
        ["Member contribution"],
        member_header(),
    ]
    for label, view in views:
        rows.append(member_line(label, view))
    rows.append(total_line(views))
    rows.append([])
    rows.append(["Catalyst planned hours"])
    rows.append(
        [
            "Efforts hours from ticket are Analysis + Dev + Unit testing + Review on tickets the member resolved or transitioned. "
            "Expected hours are the catalyst standard: Top 300 and Top 1000 use that band's hours, and every other PIB 2026 band uses the Non Top hours."
        ]
    )
    rows.append(planned_header())
    for label, view in views:
        rows.append(planned_line(label, view))
    rows.append(planned_total(views))
    rows.append([])
    rows.append(["Member Contribution in Tickets"])
    rows.append(
        [
            "One row per ticket a member resolved, transitioned, or logged time on. "
            "Effort cells are filled only when the member resolved or transitioned the ticket. "
            "Time logged is worklog time with no qualifying status change. "
            "Validation compares effort hours with the catalyst expected for Top 300 and Top 1000, "
            "or the generalised Non Top expected for every other band."
        ]
    )
    rows.append(ticket_header())
    for label, _view in views:
        tickets = sorted(grouped[label]["tickets"], key=lambda item: item["key"])
        for ticket in tickets:
            rows.append(ticket_line(label, ticket))
        if not tickets:
            rows.append([label, "", "No qualifying ticket or worklog"])
    return rows


def total_line(views: list[tuple[str, dict]]) -> list:
    keys = [
        "worked",
        "resolved",
        "transitioned",
        "skill_worked",
        "skill_transitioned",
        "analysis",
        "dev",
        "unit",
        "review",
        "tracked",
        "effort",
        "skill_effort",
        "nonskill_effort",
        "resolution_effort",
        "transition_effort",
        "overall",
        "overall_resolution",
        "overall_transition",
    ]
    totals = {key: sum(view[key] for _label, view in views) for key in keys}
    skill_time = sum(view["skill_time"] for _label, view in views)
    return [
        "Total",
        *[plain_number(totals[key]) for key in keys],
        per_day(totals["overall"]),
        percent(skill_time, totals["overall"]),
        sum(view["within"] for _label, view in views),
        sum(view["over"] for _label, view in views),
        sum(view["no_expected"] for _label, view in views),
    ]


def self_test() -> None:
    day = datetime(2026, 11, 4)
    sriya = ROSTER[0]["account_id"]
    other = "712020:someone-else"

    def history(account: str, stamp: str, status: str) -> dict:
        return {
            "created": stamp,
            "author": {"accountId": account, "displayName": "ignored"},
            "items": [{"field": "status", "toString": status}],
        }

    def worklog(account: str, stamp: str, seconds: int) -> dict:
        return {
            "started": stamp,
            "author": {"accountId": account},
            "timeSpentSeconds": seconds,
        }

    def issue(key, whiteboard, analysis=0, dev=0, unit=0, review=0, histories=None, worklogs=None):
        return {
            "key": key,
            "fields": {
                "summary": key + " summary",
                "status": {"name": "Open"},
                "assignee": {"displayName": "Owner"},
                "project": {"key": "EXT"},
                "customfield_11239": whiteboard,
                "customfield_11184": analysis,
                "customfield_11187": dev,
                "customfield_11185": unit,
                "customfield_11186": review,
            },
            "_histories": histories or [],
            "_worklogs": worklogs or [],
        }

    inside = "2026-11-04T10:00:00.000+0530"
    issues = [
        issue("A", "CA-Feasible", analysis=60, histories=[history(sriya, inside, "Resolved")], worklogs=[worklog(sriya, inside, 1800)]),
        issue("B", None, analysis=30, histories=[history(sriya, inside, "pending audits")]),
        issue(
            "C",
            "ET-Transition",
            dev=60,
            review=30,
            histories=[
                history(sriya, "2026-11-04T11:00:00.000+0530", "Under OCR"),
                history(sriya, "2026-11-04T12:00:00.000+0530", "Resolved"),
            ],
        ),
        issue("D", "CA-Feasible", analysis=120, worklogs=[worklog(sriya, inside, 3600)]),
        issue("E", "CA-Feasible", histories=[history(other, inside, "Resolved")]),
        issue("F", "CA-Not Feasible", histories=[history(sriya, "2026-11-03T23:00:00.000+0530", "Resolved")]),
        issue("G", "CA-Not Feasible", analysis=None, histories=[history(sriya, "2026-11-05T00:00:00.000+0530", "Resolved")]),
    ]
    issues[6]["fields"]["customfield_11184"] = None
    issues[6]["fields"]["customfield_15845"] = 60
    grouped = collect(issues, day)
    view = member_view(grouped["Sriya Nayak"])
    assert view["worked"] == 3, view
    assert view["resolved"] == 2, view
    assert view["transitioned"] == 2, view
    assert view["skill_worked"] == 1, view
    assert view["skill_transitioned"] == 0, view
    assert view["analysis"] == 1.5, view
    assert view["dev"] == 1, view
    assert view["review"] == 0.5, view
    assert view["tracked"] == 1.5, view
    assert view["effort"] == 3, view
    assert view["skill_effort"] == 1, view
    assert view["nonskill_effort"] == 2, view
    assert view["resolution_effort"] == 2.5, view
    assert abs(view["transition_effort"] - 2.0) < 1e-9, view
    assert view["overall"] == 4.5, view
    assert view["overall_resolution"] == 3, view
    assert abs(view["overall_transition"] - 2.0) < 1e-9, view
    assert percent(view["skill_time"], view["overall"]) == "55.6%", view
    assert member_view(grouped["Stanley"])["worked"] == 0
    sheet = build_sheet(day, issues, datetime(2026, 11, 4, 16, 49, tzinfo=IST))
    assert sheet[0][0] == "Olympus EOD — 4 Nov 2026"
    assert sheet[4][0] == "Member contribution"
    assert sheet[5][0] == "Team member"
    assert sheet[5][1] == "Total Ticket Worked"
    assert sheet[6][0] == "Sriya Nayak"
    assert sheet[6][1] == 3
    assert sheet[6][19] == "64.3%"
    assert sheet[6][20] == "55.6%"
    planned = next(i for i, row in enumerate(sheet) if row and row[0] == "Catalyst planned hours")
    assert sheet[planned + 2] == planned_header()
    assert sheet[planned + 3][0] == "Sriya Nayak"
    assert sheet[planned + 3][1] == 3
    assert sheet[planned + 3][2] == 0
    bands = {
        "AlphaTemplateProvider": "Top 300",
        "BetaTemplateProvider": "Top 1000",
        "GammaTemplateProvider": "10-70 Accts",
    }
    planned_issues = [
        issue("P1", "CA-Feasible", analysis=60, histories=[history(sriya, inside, "Resolved")]),
        issue("P2", "CA-Feasible", analysis=180, histories=[history(sriya, inside, "Resolved")]),
        issue("P3", None, analysis=30, histories=[history(sriya, inside, "Under Reporter")]),
        issue("P4", None, analysis=60, histories=[history(sriya, inside, "Resolved")]),
    ]
    planned_issues[0]["fields"]["customfield_11171"] = {"value": "Bill_Change"}
    planned_issues[0]["fields"]["customfield_12282"] = {"value": "AlphaTemplateProvider"}
    planned_issues[1]["fields"]["customfield_11171"] = {"value": "Bill_Change"}
    planned_issues[1]["fields"]["customfield_12282"] = {"value": "BetaTemplateProvider"}
    planned_issues[2]["fields"]["customfield_11171"] = {"value": "Zendesk"}
    planned_issues[2]["fields"]["customfield_12282"] = {"value": "GammaTemplateProvider"}
    planned_issues[3]["fields"]["customfield_11171"] = {"value": "Not a catalyst"}
    planned_issues[3]["fields"]["customfield_12282"] = {"value": "AlphaTemplateProvider"}
    planned_grouped = collect(planned_issues, day, bands)
    planned_view = member_view(planned_grouped["Sriya Nayak"])
    assert planned_view["expected_hours"] == 5.5, planned_view
    assert planned_view["effort"] == 5.5, planned_view
    assert planned_view["within"] == 2, planned_view
    assert planned_view["over"] == 1, planned_view
    assert planned_view["no_expected"] == 1, planned_view
    first = planned_grouped["Sriya Nayak"]["tickets"]
    by_key = {item["key"]: item for item in first}
    assert by_key["P1"]["basis"] == CATALYST_BASIS and by_key["P1"]["expected"] == 2
    assert by_key["P2"]["basis"] == CATALYST_BASIS and by_key["P2"]["validation"] == OVER
    assert by_key["P3"]["basis"] == GENERAL_BASIS and by_key["P3"]["expected"] == 2
    assert by_key["P4"]["validation"] == NO_EXPECTED
    assert sheet[14][0] == "Total"
    assert any(row and row[0] == "Member Contribution in Tickets" for row in sheet)
    keys = [row[1] for row in sheet if len(row) > 1 and isinstance(row[1], str) and row[1].startswith("=HYPERLINK")]
    assert any('/browse/A"' in item for item in keys)
    assert any('/browse/D"' in item for item in keys)
    assert all('/browse/F"' not in item and '/browse/G"' not in item and '/browse/E"' not in item for item in keys)
    assert tab_name(day) == "Nov 04"
    assert classify("") == "Non Skill"
    assert classify("CA-Not Feasible") == "Non Skill"
    assert classify("ET-Transition") == "Non Skill"
    assert classify("CA-Feasible") == "Skill"
    assert classify("Something else") == "Other"
    print("self-test ok")


if __name__ == "__main__":
    self_test()
