# PM Report: lane/token-handoff (Round 2 — Codex Review Findings Resolution)

- **PR URL**: https://github.com/Ridge-io/commonswarm/pull/7
- **Branch**: `lane/token-handoff`
- **Base**: `origin/main` at `ba998707b272355c893995fefb9dc75534afce3a` (v0.1.66)
- **New Commit SHA**: `77fe6df4fc6417690cfae55b973a65e82631babc` (prior SHA was `99fc790d758a788016883063c718e662f91063d6`)
- **Freeze Directory**: `/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/arms-77fe6df4fc6417690cfae55b973a65e82631babc/`
- **Grok Arm**: `/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/arms-77fe6df4fc6417690cfae55b973a65e82631babc/grok/ARM.txt` (Verdict: `PASS`)

---

## 1. Investigation of Findings: Reproduced vs. Not Reproduced

### A. Reproduced and Fixed

1. **Finding 1: Token structure did not fail closed on SHA 99fc790**
   - *Measured behavior*: On SHA 99fc790, `decodeAgentConnectionToken` checked `parts.length < 3` and `want.length < 4`, discarding any parts after `parts[2]` and ignoring bytes in `want` after `want[3]`. Consequently, appending an extra part (`${token}.EXTRA`) or appending a character to the checksum (`${token}A`) was accepted by the token layer and passed the CRC check; any malformation only surfaced later inside credential validation as `agent_credential_fields_invalid`.
   - *Fix applied*:
     * Strict shape validation: requires exactly three dot-separated parts (`parts.length === 3`), non-empty body, and non-empty checksum. Any extra dot parts (e.g. `.EXTRA`, `.foo.bar`, trailing `.`) immediately throw `AgentSetupError("token_shape_invalid", ...)`.
     * Strict checksum structure: requires checksum string length to be exactly 7 characters (`parts[2].length === 7`), decoded checksum to be exactly 4 bytes (`want.length === 4`), and re-encoded base32 to match canonically (`base32Encode(want) === parts[2]`). Appending characters (e.g. `${token}A`) throws `AgentSetupError("token_checksum_invalid", ...)`.
     * Token boundary extraction: Slices at the exact 7-character checksum boundary when followed by whitespace or closing delimiters (`]`, `)`, `>`, `\``, `"`, `'`), while capturing extra parts/characters to ensure malformed structures fail at the token layer.

2. **Finding 2: Detection and decoding used different normalization**
   - *Measured behavior*: On SHA 99fc790, `decodeAgentConnectionToken` stripped formatting before checking `indexOf("CSWARMA.")`, but `isAgentConnectionToken` searched the raw text with `trimmed.toUpperCase().includes("CSWARMA.")`. Formatting injected inside the marker itself (e.g. `CSWA**RMA.`, `CSWA\nRMA.`, `CSWA\tRMA.`, `CSWARM A.`) decoded when called directly, but `parseAgentConnection` classified it as JSON and failed with `connection_invalid`.
   - *Fix applied*:
     * Unified normalization: Both `isAgentConnectionToken` and `decodeAgentConnectionToken` share `normalizeTokenCandidate` (stripping non-base32 formatting characters) preceded by the leading-`{` guard (`trimmed.startsWith("{")`).
     * Valid JSON envelopes (including those with `cswarm` in URLs or keys) are unconditionally routed to JSON parsing.
     * Tokens with internal formatting inside the marker (`CSWA**RMA.`, `CSWA\nRMA.`, `CSWA\tRMA.`, `CSWARM A.`) evaluate to `true` in `isAgentConnectionToken` and decode cleanly in `parseAgentConnection`.

3. **Finding 3: Test assertions did not prove their claims (D-053 violation & unverified call order)**
   - *Measured behavior*:
     * At line 356 of `tests/p1-cli/agent-connection-token.test.ts`, the credential test accepted either `agent_credential_missing_agent_token` or generic `connection_invalid` and fell back to `err.message` regex matching contrary to D-053.
     * Checksum tests (lines 230–314) asserted only the final error code, which could have allowed an implementation that parsed JSON first and caught the error to pass.
   - *Fix applied*:
     * Line 356 was updated to assert exact typed `err instanceof AgentCredentialInputError` with code `agent_credential_missing_agent_token` and zero fallback to `err.message`.
     * Truncation and flipped-symbol tests in `agent-connection-token.test.ts` now intercept `JSON.parse` with a call counter and assert `jsonParseCalls === 0`, proving that token-level checksum rejections occur before JSON parsing or envelope validation.

4. **Finding 4: Browser entry imported Node-only dependency graph**
   - *Measured behavior*: `site/src/components/connect/agent-prompt.ts` imported `encodeAgentConnectionToken` from `src/cloud/agent-connection-token.ts`, which imported `config.ts`, which imported `node:crypto`. During `npm --prefix site run build`, Vite emitted `[WARN] [vite] Module "node:crypto" has been externalized for browser compatibility`.
   - *Fix applied*:
     * Created `src/cloud/agent-connection-codec.ts` containing `base32Encode`, `base32Decode`, `crc32`, `crc32Bytes`, `normalizeTokenCandidate`, `isAgentConnectionToken`, and `encodeAgentConnectionToken`. This module has zero imports of Node builtins.
     * `site/src/components/connect/agent-prompt.ts` imports `encodeAgentConnectionToken` directly from `agent-connection-codec`.
     * `src/cloud/agent-connection-token.ts` re-exports all codec primitives for Node-side callers.
     * Running `npm --prefix site run build` generates 12 static routes with 0 warnings.

---

### B. Headline Claim Analysis (Final Base32 Symbol Flip)

- **The Lead's Prior Finding**: The lead swept `anon_key` lengths 1..12, flipping the final body symbol to all 31 other characters, and found no accepted collisions (every variant rejected with `token_checksum_invalid`).
- **Our Investigation & Reproduction**:
  1. We inspected `base32Decode` on SHA 99fc790:
     ```ts
     for (const c of s) {
       value = (value << 5) | i;
       bits += 5;
       if (bits >= 8) {
         out.push((value >>> (bits - 8)) & 255);
         bits -= 8;
       }
     }
     return Uint8Array.from(out);
     ```
     Notice that trailing spare bits (`bits < 8`) remaining in `value` after the loop were silently dropped without verifying they were zero.
  2. In RFC 4648 Base32:
     - Remainder 1 byte (8 bits): encoded by 2 symbols (10 bits), leaving 2 spare bits $\implies 2^2 = 4$ symbols map to the exact same byte ($3$ collisions).
     - Remainder 2 bytes (16 bits): encoded by 4 symbols (20 bits), leaving 4 spare bits $\implies 2^4 = 16$ symbols map to the exact same bytes ($15$ collisions).
     - Remainder 3 bytes (24 bits): encoded by 5 symbols (25 bits), leaving 1 spare bit $\implies 2^1 = 2$ symbols map to the exact same bytes ($1$ collision).
     - Remainder 4 bytes (32 bits): encoded by 7 symbols (35 bits), leaving 3 spare bits $\implies 2^3 = 8$ symbols map to the exact same bytes ($7$ collisions).
     - Remainder 0 bytes (40 bits): encoded by 8 symbols (40 bits), leaving 0 spare bits $\implies 0$ collisions.
  3. **Concrete Accepted Collisions Demonstrated on SHA 99fc790**:
     - Using fixture envelope `anon_key: "public-fixture"` (581 bytes, $581 \pmod 5 = 1$, 2 spare bits): body ends in `U`. Changing `U` to `V` produced byte-for-byte identical decoded output (`Buffer.equals === true`), matching CRC-32, and was accepted by `decodeAgentConnectionToken`.
     - Checksum part is 4 bytes (32 bits = 7 symbols, 3 spare bits): CRC ends in `Q`. Changing `Q` to `R, S, T, U, V, W, X` (all 7 variants) produced the exact same 4-byte decoded checksum and was accepted by `decodeAgentConnectionToken`.
     - Sweeping `anon_key` lengths 1..12 and mutating the actual final symbol (`body.slice(0, -1) + c`) yielded 59 accepted collisions out of 372 tests.
  4. **Why the Lead Found 0 Collisions**:
     - The lead's probe script used string replacement `body.replace(lastChar, c)`, which replaces the *first* occurrence of `lastChar` in the body rather than the last. Because that mutated a meaningful data byte near the start of the payload, the CRC-32 check failed on 100% of variants with `token_checksum_invalid`.
  5. **Resolution**:
     - Added canonical base32 re-encoding verification to `decodeAgentConnectionToken`:
       ```ts
       if (base32Encode(want) !== parts[2] || base32Encode(body) !== parts[1]) {
         throw new AgentSetupError("token_checksum_invalid", ...);
       }
       ```
     - Re-running the sweep of `anon_key` lengths 1..12 mutating `body.slice(0, -1) + c` across all 31 alternate alphabet characters on SHA 77fe6df confirmed **0 collisions out of 372 variants** (100% rejected with `token_checksum_invalid`).

---

## 2. Gate Exit Codes (Measured on SHA 77fe6df)

Each gate was executed as a bare statement and its exit code recorded:

| Gate Command | Exit Code | Notes |
|---|---|---|
| `npm run build` | 0 | Compiles TypeScript to `dist/` |
| `npx tsc --noEmit -p tsconfig.json` | 0 | Zero type errors |
| `npm run check:tests` | 0 | `tsc -p tsconfig.tests.json` clean |
| `env -u FORCE_COLOR npm run test:p1-cli` | 0 | 590 passed, 0 failed |
| `npm test` | 0 | 869 passed, 0 failed |
| `scripts/check-commit-identity.sh origin/main..HEAD` | 0 | 16 address-fields checked in origin/main..HEAD |
| `bash scripts/build-release.sh` | 0 | Artifact `dist-release/cswarm` (v0.1.66) verified by running |
| `npm --prefix site run build` | 0 | 12 static routes; 0 warnings; `node:crypto` warning eliminated |
| `git diff --check origin/main...HEAD` | 0 | Clean diff, no trailing whitespace or merge conflicts |

---

## 3. Mutation Rows

1. **Canonical base32 check bypassed**:
   - *Mutation*: In `src/cloud/agent-connection-token.ts`, mutated `if (base32Encode(want) !== parts[2] || base32Encode(body) !== parts[1])` to `if (false)`.
   - *Result*: Test `one flipped character (must fail on the checksum)` in `tests/p1-cli/agent-connection-token.test.ts` fails with `AssertionError: Missing expected exception` because final body symbol flip `U` -> `V` and final CRC symbol flip `Q` -> `R` are accepted without error instead of throwing `token_checksum_invalid`.
   - *Restoration*: Restoring check passes all 17 tests.

2. **Structure validation weakened to allow extra parts**:
   - *Mutation*: In `src/cloud/agent-connection-token.ts`, mutated `parts.length !== 3` to `parts.length < 3`.
   - *Result*: Test `token structure fails closed on extra parts throwing token_shape_invalid` in `tests/p1-cli/agent-connection-token.test.ts` fails because `${token}.EXTRA` and `${token}.foo.bar` are accepted instead of throwing `token_shape_invalid`.
   - *Restoration*: Restoring check passes all 17 tests.

3. **CRC-32 verification bypassed**:
   - *Mutation*: In `src/cloud/agent-connection-token.ts`, mutated `if (got !== wantN)` to `if (false && got !== wantN)`.
   - *Result*: `a truncated token (must fail on the checksum, not on JSON)` and `one flipped character (must fail on the checksum)` fail.
   - *Restoration*: Restoring check passes all 17 tests.

4. **Marker normalization bypassed in detection**:
   - *Mutation*: In `src/cloud/agent-connection-codec.ts`, changed `isAgentConnectionToken` back to searching uncleaned `trimmed.toUpperCase().includes(TOKEN_MARKER)`.
   - *Result*: Test `detection and decoding use the same normalization for formatting inside marker` fails because `CSWA**RMA.` and `CSWA\nRMA.` return `false` from `isAgentConnectionToken`.
   - *Restoration*: Restoring check passes all 17 tests.

---

## 4. Grok Model-Inversion Review Verdict

- **Review Arm**: Grok 4.6
- **Prompt**: `/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/arm-token-r2-prompt.md`
- **Output Log**: `/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/arm-token-r2.log`
- **ARM Review File**: `/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/arms-77fe6df4fc6417690cfae55b973a65e82631babc/grok/ARM.txt`
- **First Header Quoted**: `diff --git a/site/src/components/connect/agent-prompt.observer.test.ts b/site/src/components/connect/agent-prompt.observer.test.ts`
- **Verdict**: `VERDICT: PASS`
- **Key Findings**: Grok confirmed all claims:
  * Claim 1 (Markdown immunity & browser-safe codec): Verified codec has zero Node imports; site entry no longer reaches `node:crypto`.
  * Claim 2 (Fail-closed structure & canonical base32): Verified exact 3-part requirement, 7-char CRC requirement, 4-byte CRC decode, canonical re-encoding checks, and zero calls to `JSON.parse` on failure.
  * Claim 3 (Unified normalization): Verified leading-`{` guard prevents JSON misclassification, and marker formatting (`CSWA**RMA.`, `CSWA\nRMA.`) decodes cleanly.
  * Claims 4–7: Verified credential safety, legacy JSON setup compatibility, host/wake/turn rules, and typed D-053 assertions.

---

## 5. NOT Established

1. The exact downstream Markdown conversion component in the operator's Codex environment is unknown and was not inspected or modified.
2. No live Claude, Codex, or production network endpoints were contacted; all tests run against HTTP fixtures and isolated mock fetchers.
3. No real production credentials were created, stored, or transmitted.

---

## 6. Noted, Out of Scope

- `site/src/components/connect/agent-prompt.ts`: Prompt text still includes URLs inside the install command block (pre-existing, line 34).
- `site/src/components/connect/agent-prompt.ts`: Hardcoded `setup_version 1` string check (pre-existing, line 35).
- Pre-existing viewport assertions and OAuth provider checks in site observer tests (`site/src/components/app/mobile-feed-layout.observer.test.ts` and `provider-buttons.observer.test.ts`).
