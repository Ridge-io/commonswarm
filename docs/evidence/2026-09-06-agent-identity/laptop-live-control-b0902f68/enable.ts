// Human enable/recover via the same client class the CLI uses; JWT from the local auth stack.
import { cloudTarget } from "/Users/tom/Developer/Ridge.io/commonswarm/scratchpad/wt-identity-server/src/cloud/config.js";
import { AgentSessionClient } from "/Users/tom/Developer/Ridge.io/commonswarm/scratchpad/wt-identity-server/src/cloud/session-client.js";
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
