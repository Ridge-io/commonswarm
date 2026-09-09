# lane/token-handoff — freeze for D-036 (round 2 post Codex review)

SHA `77fe6df4fc6417690cfae55b973a65e82631babc`, base `ba998707b272355c893995fefb9dc75534afce3a` (v0.1.66). Diff: `DIFF.patch`.

## Claim, in three sentences
The connection hand-off carries the setup JSON payload in an RFC 4648 base32 encoding with CRC-32 checksum (`CSWARMA.<base32(json)>.<base32(crc32)>`) strictly restricted to uppercase letters A-Z, digits 2-7, and dot separators, with a browser-safe codec module (`agent-connection-codec.ts`) that imports no Node builtins and eliminates bundler externalization warnings.
The decoder in `decodeAgentConnectionToken` and detector in `isAgentConnectionToken` share unified safe normalization while preserving the leading-`{` JSON guard, enforcing exact 3-part token structure (`parts.length === 3`), exact 7-symbol / 4-byte checksum, and canonical base32 re-encoding checks before any JSON parsing or envelope validation occurs.
Legacy plain JSON setup files and base32 token hand-offs remain fully interoperable and backwards-compatible across all CLI workflows and test fixtures, while setup output, error messages, and copied prompts strictly omit secrets and avoid inviting manual hand-repair.

## Files
- `src/cloud/agent-connection-codec.ts`
- `src/cloud/agent-connection-token.ts`
- `src/cloud/agent-onboarding-contract.ts`
- `src/cloud/agent-profile.ts`
- `site/src/components/connect/agent-prompt.ts`
- `site/src/components/connect/agent-prompt.observer.test.ts`
- `tests/p1-cli/agent-connection-token.test.ts`
- `tests/p1-cli/agent-onboarding.test.ts`

## Gate exit codes
- `npm run build`: 0
- `npx tsc --noEmit -p tsconfig.json`: 0
- `npm run check:tests`: 0
- `env -u FORCE_COLOR npm run test:p1-cli`: 0 (590 pass, 0 fail)
- `npm test`: 0 (869 pass, 0 fail)
- `scripts/check-commit-identity.sh origin/main..HEAD`: 0 (16 address-fields checked)
- `bash scripts/build-release.sh`: 0 (version 0.1.66 verified by running the artifact)
- `npm --prefix site run build`: 0 (12 static routes generated, 0 warnings, node:crypto externalization eliminated)
- `git diff --check origin/main...HEAD`: 0

## Mutation rows
1. **Canonical base32 check bypassed**: In `src/cloud/agent-connection-token.ts`, mutating `if (base32Encode(want) !== parts[2] || base32Encode(body) !== parts[1])` to `if (false)` causes `tests/p1-cli/agent-connection-token.test.ts` to fail:
   - `one flipped character (must fail on the checksum)` fails with `AssertionError: Missing expected exception` because final body symbol flip `U` -> `V` and final CRC symbol flip `Q` -> `R` are accepted instead of throwing `token_checksum_invalid`. Restoring the check passes all 17 tests.
2. **Structure validation weakened to allow extra parts**: In `src/cloud/agent-connection-token.ts`, mutating `parts.length !== 3` to `parts.length < 3` causes `tests/p1-cli/agent-connection-token.test.ts` to fail:
   - `token structure fails closed on extra parts throwing token_shape_invalid` fails because `${token}.EXTRA` and `${token}.foo.bar` are accepted instead of throwing `token_shape_invalid`.
3. **CRC-32 verification bypassed**: In `src/cloud/agent-connection-token.ts`, mutating `if (got !== wantN)` to `if (false && got !== wantN)` causes `a truncated token (must fail on the checksum, not on JSON)` and `one flipped character (must fail on the checksum)` to fail.
4. **Marker normalization bypassed in detection**: In `src/cloud/agent-connection-codec.ts`, changing `isAgentConnectionToken` back to searching uncleaned `trimmed.toUpperCase().includes(TOKEN_MARKER)` causes `tests/p1-cli/agent-connection-token.test.ts` to fail:
   - `detection and decoding use the same normalization for formatting inside marker` fails because `CSWA**RMA.` and `CSWA\nRMA.` return false from `isAgentConnectionToken`.

## Model-inversion review: Codex round 1 findings and resolutions
- **Finding 1 (Structure and canonical base32)**: Codex identified that extra parts (`.EXTRA`), extra checksum characters (`A`), and final-symbol flips (`U` -> `V`, `Q` -> `R`) were accepted on SHA 99fc790.
  - *Resolution*: Enforced exact 3-part structure (`parts.length === 3`), checksum length === 7, decoded checksum length === 4 (`want.length === 4`), and canonical base32 spelling verification (`base32Encode(want) === parts[2]` and `base32Encode(body) === parts[1]`). Slices delimit at the 7-symbol checksum boundary when followed by whitespace/closing delimiter, and capture extra characters/parts to fail structure validation. Added explicit controls in `tests/p1-cli/agent-connection-token.test.ts`.
- **Finding 2 (Normalization discrepancy)**: Codex showed `CSWA**RMA.` decoded when called directly but failed `isAgentConnectionToken` because detection searched raw text.
  - *Resolution*: Unified normalization across `isAgentConnectionToken` and `decodeAgentConnectionToken` using `normalizeTokenCandidate`, preceded by the leading-`{` JSON guard. Added marker formatting tests verifying `isAgentConnectionToken`, `decodeAgentConnectionToken`, and `parseAgentConnection`.
- **Finding 3 (Test discrimination & D-053)**: Credential test at line 356 used fallback to `err.message`, and checksum tests did not prove checksum failure preceded JSON parsing.
  - *Resolution*: Line 356 now asserts exact typed `err instanceof AgentCredentialInputError` with `err.code === "agent_credential_missing_agent_token"`. Truncated and flipped checksum tests now spy on `JSON.parse` and assert `jsonParseCalls === 0`, proving rejection precedes JSON parsing.
- **Finding 4 (Node-only import graph in browser entry)**: `site/src/components/connect/agent-prompt.ts` pulled in `config.ts` and `node:crypto`.
  - *Resolution*: Split browser-safe codec into `src/cloud/agent-connection-codec.ts` with zero Node imports. `agent-prompt.ts` imports directly from `agent-connection-codec`. Vite build emits 0 warnings and direct browser resolution succeeds.

## NOT established
1. The exact downstream Markdown conversion component in the operator's Codex environment is unknown and was not inspected or modified.
2. No live Claude, Codex, or production network endpoints were contacted; all tests run against HTTP fixtures and isolated mock fetchers.
3. No real production credentials were created, stored, or transmitted.
