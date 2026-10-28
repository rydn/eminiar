// One table for every reader of "does this file ask for enforcement": enforceIntent
// (swarm-core.test.ts) and the no-node shim (swarm-shim.test.ts) both run all of it.
export const ENFORCE_FORMS: Array<{ name: string; text: string; intent: boolean }> = (() => {
  const body = "swarms:\n  s:\n    description: d\n    agents:\n      a:\n        description: x\n";
  const f = (name: string, head: string, intent: boolean) => ({
    name,
    text: `version: 1\n${head}${body}`,
    intent,
  });
  return [
    f("true", "enforce: true\n", true),
    f("True", "enforce: True\n", true),
    f("TRUE", "enforce: TRUE\n", true),
    f("double-quoted key", '"enforce": true\n', true),
    f("single-quoted key", "'enforce': true\n", true),
    f("space before colon", "enforce : true\n", true),
    f("trailing comment", "enforce: true # on\n", true),
    f("CRLF", "enforce: true\r\n", true),
    {
      name: "BOM",
      text: `\uFEFFenforce: true\nversion: 1\n${body}`,
      intent: true,
    },
    f("trueish", "enforce: trueish\n", false),
    f("quoted value", 'enforce: "true"\n', false),
    f("false", "enforce: false\n", false),
    f("hash glued to value", "enforce: true#x\n", false),
    f("enabled false", "enforce: true\nenabled: false\n", false),
    f("enabled False + comment", "enforce: true\nenabled: False # off\n", false),
    f("enabled FALSE + CR", "enforce: true\r\nenabled: FALSE\r\n", false),
    f("enabled true", "enforce: true\nenabled: true\n", true),
    f("no key", "", false),
  ];
})();
