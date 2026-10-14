const fs = require("fs");
const vm = require("vm");

const context = { console, Math, Object, String, JSON, parseInt, Date, Array };
vm.createContext(context);
vm.runInContext(fs.readFileSync(__dirname + "/KTLOTicketDistribution.gs", "utf8"), context);

function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(label + "\n  actual: " + a + "\n  expected: " + e);
  }
}

const group = context.indexGroupMembers([
  { accountId: "acct-in", displayName: "Asha Rao" },
  { accountId: "acct-other", displayName: "Ben Cole" }
]);

const source = fs.readFileSync(__dirname + "/KTLOTicketDistribution.gs", "utf8");
assertEqual(source.indexOf('const RESOLVER_GROUP = "ops_dev_extraction";') !== -1, true, "resolver group name");

assertEqual(
  context.pickResolversInGroup({ accountId: "acct-in", displayName: "Asha Rao" }, group),
  "Asha Rao",
  "resolver in the group is kept"
);

assertEqual(
  context.pickResolversInGroup({ accountId: "acct-out", displayName: "Asha Rao" }, group),
  "",
  "same display name with a different account is rejected"
);

assertEqual(
  context.pickResolversInGroup({ accountId: "acct-out", displayName: "Nia Shah" }, group),
  "",
  "resolver outside the group is left blank"
);

assertEqual(
  context.pickResolversInGroup("Asha Rao", group),
  "Asha Rao",
  "a name-only resolver matches the group display name"
);

assertEqual(
  context.pickResolversInGroup("nia shah", group),
  "",
  "a name-only resolver outside the group is left blank"
);

assertEqual(
  context.pickResolversInGroup([
    { accountId: "acct-out", displayName: "Nia Shah" },
    { accountId: "acct-in", displayName: "Asha Rao" },
    { accountId: "acct-in", displayName: "Asha Rao" }
  ], group),
  "Asha Rao",
  "only group members are kept from a multi-user field"
);

assertEqual(
  context.pickResolversInGroup({ accountId: "acct-in" }, group),
  "Asha Rao",
  "a matching account with no display name uses the group name"
);

assertEqual(context.pickResolversInGroup(null, group), "", "empty resolver stays blank");
assertEqual(context.pickResolversInGroup("", group), "", "blank resolver stays blank");

const extractionThenOther = [
  { created: "2026-10-02T10:00:00.000+0000", items: [{ fieldId: "customfield_11178", to: "acct-out", toString: "Nia Shah" }] },
  { created: "2026-10-01T10:00:00.000+0000", items: [{ fieldId: "customfield_11178", to: "acct-in", toString: "Asha Rao" }] }
];
assertEqual(
  context.firstResolverInGroup({ accountId: "acct-out", displayName: "Nia Shah" }, extractionThenOther, group),
  "Asha Rao",
  "earliest extraction resolver is kept when a later team resolves the ticket"
);

assertEqual(
  context.firstResolverInGroup(
    { accountId: "acct-out", displayName: "Nia Shah" },
    [{ created: "2026-10-01T10:00:00.000+0000", items: [{ fieldId: "customfield_11178", to: "acct-out", toString: "Nia Shah" }] }],
    group
  ),
  "",
  "a changelog with only another team stays blank"
);

assertEqual(
  context.firstResolverInGroup({ accountId: "acct-in", displayName: "Asha Rao" }, [], group),
  "Asha Rao",
  "current resolver is used when the changelog has no resolver changes"
);

assertEqual(
  context.firstResolverInGroup(
    { accountId: "acct-other", displayName: "Ben Cole" },
    [
      { created: "2026-10-03T10:00:00.000+0000", items: [{ fieldId: "customfield_11178", to: "acct-other", toString: "Ben Cole" }] },
      { created: "2026-10-01T10:00:00.000+0000", items: [{ fieldId: "customfield_11178", to: "acct-in", toString: "Asha Rao" }] }
    ],
    group
  ),
  "Asha Rao",
  "the first extraction member wins when two group members resolved the ticket"
);

assertEqual(
  context.firstResolverInGroup(
    null,
    [{ created: "2026-10-01T10:00:00.000+0000", items: [{ fieldId: "status", to: "1", toString: "Resolved" }] }],
    group
  ),
  "",
  "status changes are not resolvers"
);

assertEqual(
  context.firstResolverInGroup(
    null,
    [{ created: "2026-10-01T10:00:00.000+0000", items: [{ field: "Resolver", toString: "Asha Rao" }] }],
    group
  ),
  "Asha Rao",
  "a changelog name with no account id matches the group"
);

assertEqual(
  context.firstResolverInGroup(
    null,
    [{ created: "2026-10-01T00:00:00.000Z", items: [{ fieldId: "customfield_11178", to: "acct-out", toString: "Asha Rao" }] }],
    group
  ),
  "",
  "changelog account id outside the group is rejected"
);

assertEqual(
  context.firstResolverInGroup(null, [
    { created: 1492071429, items: [{ fieldId: "customfield_11178", to: "acct-out", toString: "Nia Shah" }] },
    { created: 1492070429, items: [{ fieldId: "customfield_11178", to: "acct-in", toString: "Asha Rao" }] }
  ], group),
  "Asha Rao",
  "numeric changelog timestamps are ordered oldest first"
);

const pages = [
  { issueChangeLogs: [{ issueId: "101", changeHistories: [{ created: "2026-10-02T00:00:00.000Z", items: [{ fieldId: "customfield_11178", to: "acct-out", toString: "Nia Shah" }] }] }] },
  { issueChangeLogs: [{ issueId: "101", changeHistories: [{ created: "2026-10-01T00:00:00.000Z", items: [{ fieldId: "customfield_11178", to: "acct-in", toString: "Asha Rao" }] }] }] }
];
const byKey = context.collectChangelogHistories(pages, { "101": "EXT-1" });
assertEqual(
  context.firstResolverInGroup({ accountId: "acct-out", displayName: "Nia Shah" }, byKey["EXT-1"], group),
  "Asha Rao",
  "changelog pages for one issue are combined before choosing the earliest group resolver"
);

console.log("resolver group rules ok");
