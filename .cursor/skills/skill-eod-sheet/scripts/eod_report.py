"""Member-contribution layout used by the SKILL EOD sheet.

The numbers follow the 3 Nov 2026 tab:

- A qualifying action is a status change, on the report day in Asia/Kolkata,
  to Resolved, Pending Audits, Under Reporter, or Under OCR.
- Resolved is the move to Resolved. The other three are Transitioned.
- CA-Feasible tickets are Skill. Every other ITD Whiteboard value is Non-skill.
- Skill hours and non-skill hours are (analysis + unit testing + development)
  minutes / 60. Analysis is customfield_11184 when it is set.
- Manual hours are that member's Jira worklogs on the report day.
- Total hours = manual + skill + non-skill.
- Skill leverage = skill addressed / worked.
- Skill performance = (skill hours + non-skill hours) shown against 7 available hours.
- A member row is highlighted when Skill addressed is greater than 6.
- Overall tickets worked and overall effort cover the whole report day, not only the label.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30))
AVAILABLE_HOURS = 7
RESOLVED_STATUS = "Resolved"
TRANSITION_STATUSES = {"Pending Audits", "Under Reporter", "Under OCR"}
FEASIBLE = "CA-Feasible"
SKILL_COMPLETED_ABOVE = 6

ROSTER = [
    ("Nexus", "Tharun Vijayakumar"),
    ("Nebula", "Venkat Ganesh R"),
    ("Neon", "Chandana C Savalgimath"),
    ("Nexus", "Esvar K N"),
    ("Nexus", "Janani Nataraj Kumar"),
    ("Nexus", "K Pavankumar"),
    ("Nova", "Raghuram selvaraj"),
    ("Nova", "Pooja Sri Balakrishnan"),
    ("Neon", "Nitish Kumar Jangam"),
    ("Nova", "Sartaj R"),
    ("Olympus", "Karthik C"),
    ("Olympus", "Saipriyadarsini Balaji"),
    ("Olympus", "Chandru K S"),
    ("Olympus", "Stanley Deivanayagam"),
    ("Orin", "Anusha M"),
    ("Orin", "Dinesh Ramasamy"),
    ("Orin", "Smitha R Gulalakai"),
    ("Orin", "Yogesh Thambidurai"),
]
OPS_TEAM = "ops_Dev_extraction"

ALIASES = {
    "esvar kn": "Esvar K N",
    "esvar k n": "Esvar K N",
    "pavankumar k": "K Pavankumar",
    "k pavankumar": "K Pavankumar",
    "janani n": "Janani Nataraj Kumar",
    "janani nataraj kumar": "Janani Nataraj Kumar",
    "pooja sri b": "Pooja Sri Balakrishnan",
    "pooja sri balakrishnan": "Pooja Sri Balakrishnan",
    "b saipriyadarsini saipriyadarsini": "Saipriyadarsini Balaji",
    "saipriyadarsini balaji": "Saipriyadarsini Balaji",
    "smitha r g": "Smitha R Gulalakai",
    "smitha r gulalakai": "Smitha R Gulalakai",
    "yogesh t": "Yogesh Thambidurai",
    "yogesh thambidurai": "Yogesh Thambidurai",
}


def norm_name(name: str | None) -> str:
    return " ".join((name or "").replace(".", " ").split()).lower()


def canonical_name(name: str | None) -> str:
    key = norm_name(name)
    if key in ALIASES:
        return ALIASES[key]
    return " ".join((name or "").split())


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


def plain_number(value: float) -> int | float | str:
    rounded = round(value + 1e-9, 2)
    if rounded == int(rounded):
        return int(rounded)
    text = f"{rounded:.2f}".rstrip("0").rstrip(".")
    return float(text) if "." in text else int(text)


def performance(hours: float) -> str:
    return f"{hours:.2f}h / {AVAILABLE_HOURS}h"


def leverage(addressed: int, worked: int):
    if worked == 0:
        return ""
    return plain_number(addressed / worked)


def template_name(fields: dict) -> str:
    value = fields.get("customfield_12282")
    if isinstance(value, dict):
        return str(value.get("value") or value.get("name") or "")
    return str(value or "")


def whiteboard(fields: dict) -> str:
    return str(fields.get("customfield_11239") or "").strip()


def is_skill(fields: dict) -> bool:
    return whiteboard(fields) == FEASIBLE


def effort_minutes(fields: dict) -> tuple[float, float, float]:
    analysis = fields.get("customfield_11184")
    if analysis is None:
        analysis = fields.get("customfield_15845") or 0
    unit = fields.get("customfield_11185") or 0
    development = fields.get("customfield_11187") or 0
    return float(analysis or 0), float(unit or 0), float(development or 0)


def member_order() -> list[tuple[str, str]]:
    return list(ROSTER)


def jql_quote(name: str) -> str:
    return '"' + name.replace("\\", "\\\\").replace('"', '\\"') + '"'


def overall_jql(
    day: datetime,
    names: list[str],
    begin: str | None = None,
    finish: str | None = None,
) -> str:
    """Wide query around the report day. The caller still filters timestamps to Asia/Kolkata."""
    begin = begin or (day - timedelta(days=1)).strftime("%Y-%m-%d")
    finish = finish or (day + timedelta(days=2)).strftime("%Y-%m-%d")
    quoted = ", ".join(jql_quote(name) for name in names)
    return (
        f'(status changed BY ({quoted}) AFTER "{begin}" BEFORE "{finish}" '
        f'OR worklogAuthor in ({quoted}) AND worklogDate >= "{begin}" AND worklogDate <= "{finish}") '
        f'AND status != "On Hold (migrated)"'
    )


def day_totals(issues: list[dict], start: datetime, end: datetime) -> dict[str, dict]:
    """Tickets and effort for each person on the report day.

    A ticket counts when that person resolved it, transitioned it, or logged time on it.
    Effort is that person's worklogs plus analysis, unit testing, and development
    on the tickets they resolved or transitioned.
    """
    tickets: dict[str, set[str]] = defaultdict(set)
    seconds: dict[str, int] = defaultdict(int)
    minutes: dict[str, float] = defaultdict(float)
    for issue in issues:
        fields = issue.get("fields") or {}
        key = issue["key"]
        effort = sum(effort_minutes(fields))
        qualified: set[str] = set()
        for history in issue.get("_histories") or []:
            when = parse_jira_time(history.get("created") or "")
            if when is None or not (start <= when < end):
                continue
            author = canonical_name((history.get("author") or {}).get("displayName"))
            if not author:
                continue
            for item in history.get("items") or []:
                if item.get("field") != "status":
                    continue
                target = item.get("toString") or ""
                if target != RESOLVED_STATUS and target not in TRANSITION_STATUSES:
                    continue
                qualified.add(author)
                tickets[author].add(key)
        for author in qualified:
            minutes[author] += effort
        for entry in issue.get("_worklogs") or []:
            author = canonical_name((entry.get("author") or {}).get("displayName"))
            if not author:
                continue
            when = parse_jira_time(entry.get("started") or "")
            if when is None or not (start <= when < end):
                continue
            tickets[author].add(key)
            seconds[author] += int(entry.get("timeSpentSeconds") or 0)
    names = set(tickets) | set(seconds) | set(minutes)
    return {
        name: {"tickets": len(tickets[name]), "hours": seconds[name] / 3600 + minutes[name] / 60}
        for name in names
    }


def report_names(issues: list[dict], start: datetime, end: datetime) -> list[str]:
    names = {name for _, name in ROSTER}
    names.update(day_totals(issues, start, end))
    return sorted(names)


def build_sheet(
    day: datetime,
    issues: list[dict],
    jql: str,
    generated: datetime,
    overall_issues: list[dict] | None = None,
) -> list[list]:
    start, end = day_window(day)
    teams = {name: team for team, name in ROSTER}
    actions = []
    for issue in issues:
        fields = issue.get("fields") or {}
        histories = issue.get("_histories") or []
        latest: dict[str, tuple[datetime, str]] = {}
        for history in histories:
            when = parse_jira_time(history.get("created") or "")
            if when is None or not (start <= when < end):
                continue
            author = canonical_name((history.get("author") or {}).get("displayName"))
            if not author:
                continue
            for item in history.get("items") or []:
                if item.get("field") != "status":
                    continue
                target = item.get("toString") or ""
                if target != RESOLVED_STATUS and target not in TRANSITION_STATUSES:
                    continue
                previous = latest.get(author)
                if previous is None or when >= previous[0]:
                    latest[author] = (when, target)
        for author, (_, target) in latest.items():
            kind = "Resolved" if target == RESOLVED_STATUS else "Transitioned"
            actions.append(
                {
                    "key": issue["key"],
                    "summary": fields.get("summary") or "",
                    "status": (fields.get("status") or {}).get("name") or "",
                    "template": template_name(fields),
                    "whiteboard": whiteboard(fields) or "empty",
                    "skill": is_skill(fields),
                    "member": author,
                    "team": teams.get(author, OPS_TEAM),
                    "kind": kind,
                    "handoff": target if kind == "Transitioned" else "Resolved",
                    "minutes": effort_minutes(fields),
                    "manual_seconds": manual_seconds(issue, author, start, end),
                }
            )

    by_member: dict[str, list[dict]] = defaultdict(list)
    for action in actions:
        by_member[action["member"]].append(action)

    roster_names = [name for _, name in ROSTER]
    extras = sorted(name for name in by_member if name not in teams)
    members = [(teams[name], name) for name in roster_names]
    members.extend((OPS_TEAM, name) for name in extras)
    totals = day_totals(issues if overall_issues is None else overall_issues, start, end)

    member_rows = [
        member_record(team, name, by_member.get(name, []), totals.get(name))
        for team, name in members
    ]
    enabled = [row for row in member_rows if row["team"] != OPS_TEAM]
    others = [row for row in member_rows if row["team"] == OPS_TEAM]

    label_count = len(issues)
    worked_keys = {action["key"] for action in actions}
    feasible = [issue for issue in issues if is_skill(issue.get("fields") or {})]
    skill_resolved_keys = {action["key"] for action in actions if action["skill"] and action["kind"] == "Resolved"}
    status_counts: dict[str, int] = defaultdict(int)
    for issue in issues:
        status_counts[(issue.get("fields") or {}).get("status", {}).get("name") or ""] += 1

    title = f"Skillable EOD — {day.day} {day.strftime('%b')} {day.year}"
    stamp = generated.astimezone(IST).isoformat()
    label = jql.split(" AND ")[0].replace("labels IN (", "").replace(")", "")
    rows: list[list] = [
        [title],
        ["Asia/Kolkata", label, f"Generated {stamp}"],
        [jql],
        [
            "Skill resolved",
            sum(row["skill_resolved"] for row in member_rows),
            "Skill addressed",
            sum(row["skill_addressed"] for row in member_rows),
            "CA-Feasible not resolved",
            f"{len(feasible) - len(skill_resolved_keys)} of {len(feasible)}",
        ],
        [
            f"Tickets in label: {label_count}",
            f"Worked: {len(worked_keys)}",
            f"No resolve or handoff: {label_count - len(worked_keys)}",
            f"Pending Audits: {status_counts['Pending Audits']}",
            f"Under Reporter: {status_counts['Under Reporter']}",
        ],
        [],
        ["Skill resolved and skill addressed"],
        cohort_header(),
        cohort_row("Skill enabled", enabled),
        cohort_row("Not skill enabled", others),
        [],
        ["Member contribution"],
        [
            "Rows in green completed more than 6 skill tickets. "
            "Skill addressed is greater than 6. "
            "Overall tickets worked and overall effort cover the whole report day, including tickets outside this label."
        ],
        member_header(),
    ]
    rows.extend(member_line(row) for row in member_rows)
    rows.append([])
    resolved = [action for action in actions if action["kind"] == "Resolved"]
    rows.append([f"Resolver tickets and templates ({len(resolved)})"])
    rows.append(["Resolver moved the ticket to Resolved on the report day. Template is the Search Template on the ticket."])
    rows.append(["Ticket", "Template", "Resolver", "Team", "Cohort", "Status", "ITD Whiteboard", "Class", "Summary"])
    for action in sorted(resolved, key=lambda item: (roster_index(item["member"]), item["key"])):
        rows.append(
            [
                action["key"],
                action["template"],
                action["member"],
                action["team"],
                "Skill enabled" if action["member"] in teams else "Not skill enabled",
                action["status"],
                action["whiteboard"],
                "Skill" if action["skill"] else "Non-skill",
                action["summary"],
            ]
        )
    rows.append([])
    not_resolved = [
        issue
        for issue in feasible
        if issue["key"] not in skill_resolved_keys
    ]
    addressed_keys = {action["key"] for action in actions if action["skill"]}
    rows.append([f"CA-Feasible tickets not resolved ({len(not_resolved)})"])
    rows.append(["Ticket", "Status", "ITD Whiteboard", "Skill resolved", "Skill addressed", "Summary"])
    for issue in sorted(not_resolved, key=lambda item: item["key"]):
        fields = issue.get("fields") or {}
        rows.append(
            [
                issue["key"],
                (fields.get("status") or {}).get("name") or "",
                whiteboard(fields) or "empty",
                "No",
                "Yes" if issue["key"] in addressed_keys else "No",
                fields.get("summary") or "",
            ]
        )
    rows.append([])
    rows.append([f"Tickets resolved or transitioned ({len(actions)})"])
    rows.append(["Ticket", "Member", "Team", "Action", "Handoff", "Status", "ITD Whiteboard", "Class", "Summary"])
    for action in sorted(actions, key=lambda item: (roster_index(item["member"]), item["key"])):
        rows.append(
            [
                action["key"],
                action["member"],
                action["team"],
                action["kind"],
                action["handoff"],
                action["status"],
                action["whiteboard"],
                "Skill" if action["skill"] else "Non-skill",
                action["summary"],
            ]
        )
    rows.append([])
    rows.append(["Skill member effort calculation"])
    rows.append(
        [
            "Total hours = Manual hours + Skill hours + Non-skill hours. "
            "Skill hours = (Analysis minutes + Unit testing minutes + Development minutes) / 60 on CA-Feasible tickets. "
            "Non-skill hours use the same effort fields on every other ticket. "
            "Manual hours are the Jira worklogs that member logged on the report day. "
            "Overall effort (hours) adds that same effort for every ticket the member resolved, "
            "transitioned, or logged time on during the report day."
        ]
    )
    rows.append(["Team", "Member", "Ticket", "ITD Whiteboard", "Class", "Action", "Analysis minutes", "Unit testing minutes", "Development minutes"])
    for team, name in members:
        owned = sorted(by_member.get(name, []), key=lambda item: item["key"])
        for action in owned:
            analysis, unit, development = action["minutes"]
            rows.append(
                [
                    team,
                    name,
                    action["key"],
                    action["whiteboard"],
                    "Skill" if action["skill"] else "Non-skill",
                    action["kind"],
                    plain_number(analysis),
                    plain_number(unit),
                    plain_number(development),
                ]
            )
        if not owned:
            rows.append([team, name, "", "", "", "", 0, 0, 0])
        rows.append([team, name, "Total"])
    return rows


def manual_seconds(issue: dict, member: str, start: datetime, end: datetime) -> int:
    total = 0
    for entry in issue.get("_worklogs") or []:
        if canonical_name((entry.get("author") or {}).get("displayName")) != member:
            continue
        when = parse_jira_time(entry.get("started") or "")
        if when is None or not (start <= when < end):
            continue
        total += int(entry.get("timeSpentSeconds") or 0)
    return total


def member_record(team: str, name: str, owned: list[dict], overall: dict | None = None) -> dict:
    skill_resolved = sum(1 for action in owned if action["skill"] and action["kind"] == "Resolved")
    skill_transitioned = sum(1 for action in owned if action["skill"] and action["kind"] == "Transitioned")
    other_resolved = sum(1 for action in owned if not action["skill"] and action["kind"] == "Resolved")
    other_transitioned = sum(1 for action in owned if not action["skill"] and action["kind"] == "Transitioned")
    skill_minutes = 0.0
    other_minutes = 0.0
    manual = 0
    for action in owned:
        minutes = sum(action["minutes"])
        if action["skill"]:
            skill_minutes += minutes
        else:
            other_minutes += minutes
        manual += action["manual_seconds"]
    skill_hours = skill_minutes / 60
    other_hours = other_minutes / 60
    manual_hours = manual / 3600
    overall = overall or {}
    return {
        "team": team,
        "name": name,
        "worked": len(owned),
        "resolved": skill_resolved + other_resolved,
        "transitioned": skill_transitioned + other_transitioned,
        "skill_resolved": skill_resolved,
        "skill_transitioned": skill_transitioned,
        "skill_addressed": skill_resolved + skill_transitioned,
        "other_resolved": other_resolved,
        "other_transitioned": other_transitioned,
        "total_hours": manual_hours + skill_hours + other_hours,
        "manual_hours": manual_hours,
        "skill_hours": skill_hours,
        "other_hours": other_hours,
        "overall_tickets": int(overall.get("tickets", 0)),
        "overall_hours": float(overall.get("hours", 0)),
        "highlight": skill_resolved + skill_transitioned > SKILL_COMPLETED_ABOVE,
    }


def member_header() -> list[str]:
    return [
        "Team",
        "Member",
        "Available hours",
        "Overall tickets worked",
        "Worked",
        "Resolved",
        "Transitioned",
        "Skill resolved",
        "Skill transitioned",
        "Skill addressed",
        "Non-skill resolved",
        "Non-skill transitioned",
        "Total hours",
        "Manual hours",
        "Skill hours",
        "Non-skill hours",
        "Skill leverage",
        "Skill performance",
        "Overall effort (hours)",
    ]


def member_line(row: dict) -> list:
    worked = row["worked"]
    return [
        row["team"],
        row["name"],
        AVAILABLE_HOURS,
        row["overall_tickets"],
        worked,
        row["resolved"],
        row["transitioned"],
        row["skill_resolved"],
        row["skill_transitioned"],
        row["skill_addressed"],
        row["other_resolved"],
        row["other_transitioned"],
        plain_number(row["total_hours"]),
        plain_number(row["manual_hours"]),
        plain_number(row["skill_hours"]),
        plain_number(row["other_hours"]),
        leverage(row["skill_addressed"], worked),
        performance(row["skill_hours"] + row["other_hours"]),
        plain_number(row["overall_hours"]),
    ]


def cohort_header() -> list[str]:
    return [
        "Cohort",
        "People",
        "Skill resolved",
        "Skill addressed",
        "Worked",
        "Resolved",
        "Transitioned",
        "Total hours",
        "Manual hours",
        "Skill hours",
        "Non-skill hours",
        "Skill leverage",
        "Skill performance",
    ]


def cohort_row(label: str, rows: list[dict]) -> list:
    people = len(rows)
    skill_addressed = sum(row["skill_addressed"] for row in rows)
    worked = sum(row["worked"] for row in rows)
    skill_hours = sum(row["skill_hours"] for row in rows)
    other_hours = sum(row["other_hours"] for row in rows)
    return [
        label,
        people,
        sum(row["skill_resolved"] for row in rows),
        skill_addressed,
        worked,
        sum(row["resolved"] for row in rows),
        sum(row["transitioned"] for row in rows),
        plain_number(sum(row["total_hours"] for row in rows)),
        plain_number(sum(row["manual_hours"] for row in rows)),
        plain_number(skill_hours),
        plain_number(other_hours),
        leverage(skill_addressed, worked),
        performance((skill_hours + other_hours) / people) if people else performance(0),
    ]


def roster_index(name: str) -> tuple[int, str]:
    for index, (_, roster_name) in enumerate(ROSTER):
        if roster_name == name:
            return (index, name)
    return (len(ROSTER), name)
