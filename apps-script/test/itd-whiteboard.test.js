const fs = require("fs");
const path = require("path");
const vm = require("vm");

const scriptPath = path.join(__dirname, "..", "ktlo-ticket-distribution.gs");
const source = fs.readFileSync(scriptPath, "utf8");
const context = { console: console };
vm.createContext(context);
vm.runInContext(source, context, { filename: scriptPath });

let failures = 0;
function assert(condition, message) {
  if (condition) return;
  failures += 1;
  console.error("FAIL: " + message);
}

assert(source.indexOf('const ITD_WHITEBOARD_FIELD = "customfield_11239"') !== -1, "ITD Whiteboard is customfield_11239");
assert(source.indexOf("const OVERALL_ANALYSIS_AP_COLUMN = 42") !== -1, "column AP is index 42");
assert(source.indexOf("updateItdWhiteboardFromColumnAP") !== -1, "menu function is defined");
assert(source.indexOf(".addItem('Update ITD Whiteboard from Overall-Analysis (Column AP)', 'updateItdWhiteboardFromColumnAP')") !== -1, "menu exposes the ITD Whiteboard update");

const textSchema = { type: "string", custom: "com.atlassian.jira.plugin.system.customfieldtypes:textfield" };
assert(context.itdWhiteboardFieldValue("Feasible", textSchema) === "Feasible", "text field keeps the column text");

const urlSchema = { type: "string", custom: "com.atlassian.jira.plugin.system.customfieldtypes:url" };
assert(context.itdWhiteboardFieldValue("https://example.test/board", urlSchema) === "https://example.test/board", "url field keeps the column text");

const selectSchema = { type: "option", custom: "com.atlassian.jira.plugin.system.customfieldtypes:select" };
const selectValue = context.itdWhiteboardFieldValue("Feasible", selectSchema);
assert(selectValue && selectValue.value === "Feasible", "select field sends an option value");

const textarea = context.itdWhiteboardFieldValue("Board note", { type: "string", custom: "com.atlassian.jira.plugin.system.customfieldtypes:textarea" });
assert(textarea && textarea.type === "doc" && textarea.content[0].content[0].text === "Board note", "textarea field sends Atlassian document text");

const multi = context.itdWhiteboardFieldValue("Alpha, Beta", { type: "array", custom: "com.atlassian.jira.plugin.system.customfieldtypes:multiselect" });
assert(JSON.stringify(multi) === JSON.stringify([{ value: "Alpha" }, { value: "Beta" }]), "multiselect splits column text");

assert(context.itdWhiteboardFieldValue("1,250", { type: "number", custom: "com.atlassian.jira.plugin.system.customfieldtypes:float" }) === 1250, "number field parses the column text");

assert(context.itdWhiteboardCurrentText("Feasible") === "Feasible", "plain current value");
assert(context.itdWhiteboardCurrentText({ value: "Feasible" }) === "Feasible", "option current value");
assert(context.itdWhiteboardCurrentText({ type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Board note" }] }] }) === "Board note", "document current value");
assert(context.itdWhiteboardCurrentText([{ value: "Alpha" }, { value: "Beta" }]) === "Alpha, Beta", "multiselect current value");

const collected = context.collectColumnApUpdates(
  [["EXT-1"], ["not a key"], ["FS-9"], ["EXT-1"], ["FS-10"]],
  [["Feasible"], ["skip me"], ["Not feasible"], ["later value"], [""]]
);
assert(collected.order.join(",") === "EXT-1,FS-9", "only the first non-blank column AP value is kept per ticket, got " + collected.order.join(","));
assert(collected.wanted["EXT-1"] === "Feasible" && collected.wanted["FS-9"] === "Not feasible", "column AP text is paired with the ticket key");
assert(!collected.wanted["FS-10"], "a blank column AP cell is not written");

if (failures) {
  console.error(failures + " assertion(s) failed");
  process.exit(1);
}
console.log("ITD whiteboard tests passed");
