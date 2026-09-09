// Lead's independent hostile test against the REAL decoder, not a copy of it.
const { encodeAgentConnectionToken, decodeAgentConnectionToken, isAgentConnectionToken } =
  await import(process.argv[2]);
const envelope = { version: 1, url: "https://example.com", anon_key: "a_b-c",
  workspace_id: "292be0f9-ca5d-43ed-a6f7-31354fe7fe56", principal_id: "282a2587-f3a1-48b8-b764-5b3471321f90",
  credential: { message: "Agent credential minted. It is bound to this task and run so the agent's work stays scoped and attributable.".replace(/\u2019/g,"\u2019"), status: "accepted", principal_id: "282a2587-f3a1-48b8-b764-5b3471321f90",
    token_id: "cfd363b9-4e29-46f0-b384-86382a92db1d", run_id: "550ac2ed-a37f-4ac8-855e-c36b3bc29002",
    agent_token: "swm_agt_" + "A".repeat(43), expires_at: "2026-10-09T13:41:16.612Z" } };
const token = encodeAgentConnectionToken(envelope);
const mangle = (s) => s.replace(/_/g, "\\_").replace(/(https?:\/\/[^\s"]+)/g, "[$1]($1)");
let fails = 0;
const ok = (n, f) => { try { f(); console.log("  ok   " + n); } catch (e) { fails++; console.log("  FAIL " + n + ": " + (e.code ?? e.message)); } };
const mustFail = (n, code, f) => { try { f(); fails++; console.log("  FAIL " + n + ": did not throw"); }
  catch (e) { const c = e.code ?? e.name; if (code && c !== code) { fails++; console.log(`  FAIL ${n}: threw ${c}, wanted ${code}`); } else console.log(`  ok   ${n} (${c})`); } };

console.log("token has no Markdown-sensitive character:", /^[A-Z2-7.]+$/.test(token));
console.log("mangling leaves it identical:", mangle(token) === token);
console.log("RECOVERABLE:");
ok("after the operator's exact mangling", () => decodeAgentConnectionToken(mangle(token)));
ok("wrapped with tabs and spaces", () => decodeAgentConnectionToken(token.replace(/(.{24})/g, "$1\n\t ")));
ok("lowercased", () => decodeAgentConnectionToken(token.toLowerCase()));
ok("broken fence", () => decodeAgentConnectionToken("``json\n" + token + "\n``"));
ok("fence with a label", () => decodeAgentConnectionToken("```text\n" + token + "\n```"));
ok("buried in prose", () => decodeAgentConnectionToken("Save this: " + token + " then run setup."));
ok("bold marker injected", () => decodeAgentConnectionToken(token.slice(0,12) + "**" + token.slice(12)));
console.log("MUST FAIL CLOSED:");
mustFail("truncated", null, () => decodeAgentConnectionToken(token.slice(0, token.length - 10)));
mustFail("one flipped character", null, () => { const i = 30; const c = token[i] === "A" ? "B" : "A";
  decodeAgentConnectionToken(token.slice(0,i) + c + token.slice(i+1)); });
mustFail("no marker at all", null, () => decodeAgentConnectionToken("JUSTSOMETEXT"));
console.log("DISCRIMINATION (the earlier bug):");
for (const hostile of ["https://cswarm.example.com", "https://cswarma.example.com/x", "https://CSWARMA.example.com"]) {
  const j = JSON.stringify({ ...envelope, url: hostile });
  const cls = isAgentConnectionToken(j);
  if (cls) { fails++; console.log(`  FAIL a JSON envelope with url ${hostile} was classified as a token`); }
  else console.log(`  ok   JSON envelope with url ${hostile} stays JSON`);
}
const jsonWithMarkerInKey = JSON.stringify({ ...envelope, anon_key: "CSWARMA.THISLOOKSLIKEATOKEN" });
if (isAgentConnectionToken(jsonWithMarkerInKey)) { fails++; console.log("  FAIL JSON whose anon_key contains the marker was classified as a token"); }
else console.log("  ok   JSON whose anon_key literally contains CSWARMA. stays JSON");
console.log(fails === 0 ? "\nLEAD HOSTILE SUITE: PASS" : `\nLEAD HOSTILE SUITE: ${fails} FAILURE(S)`);
