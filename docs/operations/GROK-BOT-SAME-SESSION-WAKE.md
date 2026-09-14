# Grok Bot same-session wake

This branch adds `grok-bot` to `cswarm receive`. It calls the local gateway to
inject a prompt into the configured Bot agent. It does not start a model.
The implementation is not yet released. The CLI version remains 0.1.68.

## Configure and serve

Use the saved CommonSwarm profile on the Bot computer. Set its absolute path below.

```sh
PROFILE=/absolute/private/path/profile.json
AGENT=9c3388a6-717b-4e94-b9c5-5e0733bb9078
cswarm receive configure --profile "$PROFILE" --mode wake --provider grok-bot \
  --host-session-id "$AGENT" --grok-bot-agent-id "$AGENT"
cswarm receive serve --profile "$PROFILE" --host-session-id "$AGENT"
```

Keep `serve` running in a terminal or your process supervisor. It is a foreground
process; it stops on SIGINT or SIGTERM. No Claude channel approval, webhook key,
or host hook is needed. When the host session ID is the agent UUID, the separate
`--grok-bot-agent-id` option can be omitted. Configure refuses a missing gateway
file or a change to the agent UUID of an existing binding.

The receiver reads `/home/box/agent-data/gateway.json`, falling back to
`/home/box/sand-data/gateway.json`. The token is read at serve time and stays in
process memory. Neither the profile nor the binding stores it. Restart `serve`
after a gateway token change.

Requests use `POST http://127.0.0.1:<port>/api/sendPrompt`, with a bearer token and
JSON containing `agentId` and `prompt`. Port order is `SAND_HOST_PORT`, descriptor
port, then `1340`. The descriptor's host cannot send this request off the computer.
Requests have a ten-second timeout and do not follow redirects. Errors omit the
response body and token.

This path is better suited to same-computer wake than a webhook: the gateway
already holds the credential and accepts the existing agent UUID. There is no
routine URL or sender key for the user to find. `SendToAgent` is an agent tool,
not an API that the CLI can call. `listen start --provider grok` is not this path.

## Receipt and idle test

The receiver claims a delivery, saves its receipt challenge in a private local
journal, and sends a prompt with `signal_id`, the challenge, and this command:

```sh
cswarm receive confirm --profile "$PROFILE" --host-session-id "$AGENT" \
  --signal-id <signal-id> --receipt <receipt-from-prompt>
```

The woken Bot runs the command shown in its prompt. A wrong signal, receipt,
session, or expired lease is refused. The CLI saves the matching receipt to a
private mailbox. The receiver checks it against the pending journal and records
an observed ACK with the service. A gateway HTTP success alone is not an ACK.
The CLI's `pending` result means service recording is still in progress.

For a wake test:

1. With `serve` running, run `cswarm receive test --profile "$PROFILE" --host-session-id "$AGENT"`.
2. End the Bot turn. Wait until this chat is idle.
3. In a separate terminal on the Bot computer, run `cswarm receive idle --profile "$PROFILE" --host-session-id "$AGENT"`.
4. The receiver posts a self-addressed canary and sends its gateway prompt. Let the woken Bot run the confirm command.
5. Run `cswarm receive status --profile "$PROFILE" --host-session-id "$AGENT"`. Require `wake_verified: true` and `channel_running: true`.

**Idle is an explicit assertion.** No verified gateway API or host hook reports
idle state to this implementation. Do not run `receive idle` within an active Bot
turn and call that an idle test. This one test step requires the operator or a
trusted host integration to observe idle. It is not needed for ordinary messages.
`wake_verified` therefore means a matching receipt and service ACK after an
idle assertion, not an independent measurement of the host's idle state. A new
serve process clears verification and the prior idle assertion.

## Limits and fallback

The gateway is an undocumented internal API. Its route, descriptor, or token
format can change. The receiver retries failed requests; a request accepted just
before a timeout can cause a duplicate prompt. The service ACK occurs only after
a matching receipt. Restarting rotates unconfirmed receipt challenges. One live
receiver is allowed per profile and host session binding.

No live Bot idle wake was established during implementation. The HTTP fixture
and receipt tests do not prove that the host will inject into an idle chat. Run
the steps above on the Bot computer before relying on wake. Local journals and
bindings are private machine state; service delivery and ACK state stay in Postgres.

A webhook routine is an optional secondary workaround if its panel exposes the
URL and sender key. It is not part of configure or serve. See
[GROK-BOT-NATIVE-WAKE-RESEARCH.md](GROK-BOT-NATIVE-WAKE-RESEARCH.md) for the research
and the missing-credential limit of server-stored routines.
