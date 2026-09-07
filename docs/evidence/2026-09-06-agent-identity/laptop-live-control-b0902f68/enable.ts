// Lives at docs/evidence/2026-09-06-agent-identity/laptop-live-control-b0902f68/enable.ts; imports resolve from here to the repo root. Run from the worktree root: node --import tsx <this file> enable|recover <api> <anon> <jwt> <workspace> <principal>
// Human enable/recover via the same client class the CLI uses; JWT from the local auth stack.
import { cloudTarget } from "../../../../src/cloud/config.js";
import { AgentSessionClient } from "../../../../src/cloud/session-client.js";
async function main() {
const [action, api, anon, jwt, ws, principal] = process.argv.slice(2);
const client = new AgentSessionClient({ target: cloudTarget(api!, anon!) });
const req = { credential: jwt!, workspaceId: ws!, principalId: principal! };
if (action === "enable") await client.enable(req);
else if (action === "recover") await client.recover(req);
else throw new Error("action must be enable or recover");
console.log(JSON.stringify({ action, principal, ok: true }));
}
main().catch((error) => { console.log(JSON.stringify({ ok: false, code: error?.code ?? null, status: error?.status ?? null, message: String(error?.message ?? error) })); process.exitCode = 1; });
