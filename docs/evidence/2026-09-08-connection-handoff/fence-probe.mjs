// Independent probe of the fence rule: the fence must be longer than any backtick run inside.
const codeBlock = (language, text) => {
  const fence = "`".repeat(Math.max(3, ...Array.from(text.matchAll(/`+/g), m => m[0].length + 1)));
  return `${fence}${language}\n${text}\n${fence}`;
};
const cases = {
  "no backticks": '{"a":1}',
  "one backtick": '{"a":"`"}',
  "exactly three": '{"a":"```"}',
  "four": '{"a":"````"}',
  "run at start": '```{"a":1}',
  "run at end": '{"a":1}```',
  "ten": "`".repeat(10),
  "mixed runs": 'a`b```c`````d',
};
let bad = 0;
for (const [name, text] of Object.entries(cases)) {
  const out = codeBlock("json", text);
  const fence = out.slice(0, out.indexOf("json"));
  const longestInside = Math.max(0, ...Array.from(text.matchAll(/`+/g), m => m[0].length));
  const encloses = fence.length > longestInside && fence.length >= 3;
  // the closing fence must not be swallowed: no line inside equals or exceeds the fence
  const innerLines = text.split("\n");
  const collide = innerLines.some(l => /^\s*`{3,}/.test(l) && (l.match(/^\s*(`+)/)?.[1].length ?? 0) >= fence.length);
  if (!encloses || collide) { bad++; console.log(`FAIL ${name}: fence=${fence.length} longestInside=${longestInside} collide=${collide}`); }
  else console.log(`ok   ${name}: fence=${fence.length} > longestInside=${longestInside}`);
}
console.log(bad === 0 ? "PROBE PASS" : `PROBE FAIL (${bad})`);
