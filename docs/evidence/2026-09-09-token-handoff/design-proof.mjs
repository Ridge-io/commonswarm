// Does a base32 payload survive the EXACT transformation the operator reproduced?
// The transformation, applied to whatever passes through: escape underscores, linkify bare URLs.
const mangle = (s) => s.replace(/_/g, "\\_").replace(/(https?:\/\/[^\s"]+)/g, "[$1]($1)");

const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function b32(bytes) {
  let bits = 0, value = 0, out = "";
  for (const b of bytes) { value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += A[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += A[(value << (5 - bits)) & 31];
  return out;
}
function unb32(s) {
  let bits = 0, value = 0; const out = [];
  for (const c of s) { const i = A.indexOf(c); if (i < 0) continue;
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Uint8Array.from(out);
}
const crc32 = (b) => { let c = ~0; for (const x of b) { c ^= x;
  for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return (~c) >>> 0; };

const payload = JSON.stringify({ test_key: "alpha_beta", url: "https://example.com" });
const bytes = new TextEncoder().encode(payload);
const crcBytes = Uint8Array.from([24,16,8,0].map(s => (crc32(bytes) >>> s) & 255));
const token = `CSWARMA.${b32(bytes)}.${b32(crcBytes)}`;

const decode = (raw) => {
  const cleaned = raw.toUpperCase().replace(/[^A-Z2-7.]/g, "");
  // Locate the token by its marker. Cleaning keeps letters, so a fence label or any surrounding
  // prose would otherwise be glued to the front and break the prefix check.
  const at = cleaned.indexOf("CSWARMA.");
  if (at < 0) throw new Error("shape");
  const parts = cleaned.slice(at).split(".").filter(Boolean);
  if (parts.length < 3 || parts[0] !== "CSWARMA") throw new Error("shape");
  const body = unb32(parts[1]);
  const want = unb32(parts[2]);
  const got = crc32(body);
  const wantN = (want[0]<<24 | want[1]<<16 | want[2]<<8 | want[3]) >>> 0;
  if (got !== wantN) throw new Error("checksum");
  return JSON.parse(new TextDecoder().decode(body));
};

const show = (name, fn) => { try { const v = fn(); console.log(`  ok   ${name}: ${JSON.stringify(v)}`); return true; }
  catch (e) { console.log(`  FAIL ${name}: ${e.message}`); return false; } };

console.log("RAW JSON through the transformation:");
console.log(`  mangled -> ${mangle(payload).slice(0, 72)}...`);
show("parse raw JSON after mangling", () => JSON.parse(mangle(payload)));

console.log("\nBASE32 TOKEN through the SAME transformation:");
console.log(`  token   -> ${token.slice(0, 60)}...`);
console.log(`  mangled identical to token: ${mangle(token) === token}`);
show("decode after mangling", () => decode(mangle(token)));
show("decode after line wrapping + tabs", () => decode(token.replace(/(.{20})/g, "$1\n\t ")));
show("decode lowercased", () => decode(token.toLowerCase()));
show("decode inside a broken code fence", () => decode("``json\n" + token + "\n``"));
console.log("\nMUST FAIL:");
show("truncated token", () => decode(token.slice(0, token.length - 8)));
show("one flipped character", () => decode(token.slice(0, 20) + (token[20] === "A" ? "B" : "A") + token.slice(21)));
console.log("\nEXTRA:");
show("token buried in prose", () => decode("Save this: " + token + " then run setup."));
show("token inside a well-formed fence with a label", () => decode("```text\n" + token + "\n```"));
show("token with a Markdown bold marker injected", () => decode(token.slice(0,10) + "**" + token.slice(10)));
