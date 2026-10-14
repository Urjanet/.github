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

console.log("resolver group rules ok");
