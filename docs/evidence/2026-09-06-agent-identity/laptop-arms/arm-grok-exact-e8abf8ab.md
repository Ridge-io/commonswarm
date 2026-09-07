I'll review the identity-client candidate against the spec and attack the safety claims in code, not the evidence READMEs. First I am reading the contract, lane docs, and the checkout at `e8abf8ab`.Checkout matches `e8abf8ab` on `lane/identity-client`. Next I am reading the spec contract and lane docs in parallel.Swarm already has three agents, so I am joining as a review arm and mapping the candidate against the spec in parallel.The branch includes server, names, and client. I am splitting the attack surfaces and reading the fence, ACK, and session code now.Exemption is `acquire_agent_session` only. Next I am reading the fence, ACK, and migration implementations, not the evidence claims.I'll attack all four questions from theI'll attack source the session,-proof not and the ACK path claims. Starting againstI'll inventory the with the session exemption set and the spec:/ every mutation oldACP path first process resume path, then check whether, stale hooks, name routing managed, and claim, and the migration opt-in can without. be a bypass live key.ed.Key files next: session receiver, session CLI, nospawn test, migration, and name-routing.Next I’ll read the fence constants and every mutation dispatcher so I can classify each command kind.Next I’ll read the claim/ACK, hook, and server acquire paths for steal and stale-generation holes.The fence exists; next I’ll trace dispatch order, enable/disable, and the other edge functions.Next I'll trace CLI session/listen wiring, name resolution, drafts/rail, and idle model timers.The hook’s observe path looks like it trusts the file, not the host. I’ll check the server fence and remaining claim/ACK call sites.The hook fabricates injection success. I am checking the ACK server path, acquire, listen, and duplicate-name routing next.**Attack review** of `lane/identity-client` @ `e8abf8ab`. Source only. I did not run the process.

---

## A) Interactive ACP / factory

**Verdict: no hidden ACP construct on the interactive receiver path. Controls are weak. Listen still demands ACP binaries.**

Interactive receiver does claim / surface / ACK only. No ACP import.

```1:5:src/cloud/session-receiver.ts
 * Interactive managed receiver. This module must never import an ACP model
 * or provider factory, and must never spawn a host child. It claims, surfaces
```

`SESSION_MODES` is interactive only. `--mode worker` dies in `parseSessionMode`.

```28:30:src/cloud/session-contract.ts
export const SESSION_MODES = ["interactive"] as const;
export type SessionMode = (typeof SESSION_MODES)[number];
```

`startManagedSession` calls `runInteractiveReceiver`. It does not call listen / `newModel`. `--foreground` only flips `runReceiver`.

```6634:664**6VER:srcDICT/:cli FAIL**.ts
  const

Old UUID runReceiver = mode**/key cannot stealVerdict:** === "interactive" opt the && args.has("-in and the server row after releaseforeground");
  exemption set are safe, const result = await together. No expiry, or recover fence. start AManagedSession({ bypass found stale hook still
    ...
 treats “   one run fileReceiver,
```

Listen factory for managed agent writes. No DEF on disk” asECT on this attack is a.

 host stub:

--- proof and tries

###```5868:5871:src to ACK. 1. Exemption On/cli.ts
 constant a managed seat that  const newModel

`AGENT_ write dies = (
    _SESSION_PROOF_ atonCanaryAttemptEXEMPT_ the server because the: ListenerCanary hookKIN neverAttemptDSCallback sends`,
 the has key    ** _one.events That** is: Listener member:

- two bugs that cancelActivityController["events `"acquire_agent, not a closed"],
  )_session"` — gate => new NullListener.

 `/---Model();
```private/tmp/

### What holds (session

`NullListenerclaude-501/- steal)

- FreshModel.start`Users-tom- acquire / `prompt`Developer-Ridge- only on a throw.io-commonswarm dead Runtime routes row; generation to/ always `90 goesf uppending072.-71 Samefor- live-57mainea.json-4619- UUID+key retries`.b240-cc. I8936d19 Retired UUID is foundff6/scratch refused no `new Listener.
pad/wt/Engine(`identity-client/  - outside `/src/cloud/private/tmp/ `session-wire.tsclaude-501/-engine.ts`.

:Users-tom-**GAP**Developer48--50Ridge`

- `Helperiotests-:/ `commonspiswarm1/-90cli/f07271-57easession-interactive-AgentSessionProofExempt-4619-nospawn.test.ts` usesb240-cc:36-54 that8936d19` — greff6/scratch set (`sessionps `import`-wire.ts: lines inpad/wt/55identity-client/ two-61`). Membershipsupabase/functions/ files. test pins the samecommand/index.ts It list (`tests/protocol never:-workspace.test100.ts00`
 spies:- construction1573. `FORBIDDEN-1581 Public UUID/generation_IMPORTS``).

--- without does not include `

### 2 the key is `clisession_proof_. Command kinds.ts` or `invalid`. the command edge dis
  - `listenerpatches

Fencesrc/index.ts`. for/cloud/session

** **-wire.ts:GAP** `srcevery agent115`
- After credential/** releasecloud//expirysession/-recoverreceiver, old.ts proof:257-259` unless cannot — the `interactiveReceiver write kind is exempt (`. RecoverHasNoModelFactory alsosupabase(): true` is clears/functions/command a constant/ unindexsurfaced.ts: leases,.
  - `7338-736 not a control5`). Unsupabase/functions/_shared/agent-managed (`.

**GAP** `src/cliauth.ts:255managed_at ===`
.ts null `): - skips `270 thesupabase- session328 tables/functions/ (`` +agent- `authsrccommand/index.ts:9683`
.ts:221/listener/index- Interactive.ts:4--223 receiver7` — ``, command passescswarm session start has no ACP/model import. `managed` lives OnlyAt: agent. in the same module `interactivemanaged_at ?? that` mode exists null` at ` `export *`index.

---.ts

s:### `735gro DEF1kECT-

model`**1. Hook`).

| Kind pret / ` | Classclaude-endsmodel the` / ` |
|---|---|codex-model host proved
| `acquire` / `op the chat_agent_sessionencode-model`.,` | **exempt then AC** Classes load (own. I rowK did lock nots see**  
 them) constructed on`src/listener |
 session start|/.

 `hook**renew.tsDEF_agent:901_`

session`,```901:907 `release_agentECT** `src:src/listener_session` |/cli.ts:/hook.ts
 **613f1enced**-614    managedAck = |
1` + managedAckInput({| `create `src/listener
      context,
`/detach.ts:      proof,
      `acquire` `101-113 injectionSucceeded: truerenew` `hando` — detached `,
      observedHostlisten start --ff` `takeproviderSessionoverId cl`:aude ` context|submit.host_codsession_`ex `|close` `reopen`opid,
encode     ` host stillIdentityTrusted: true | **fenced requires an absolute ACP,
    });
** |
| ` binary (`claude```

Specdeclare-agent-ac: fail_agent_modelp closed to`` manual if the host / `codex `submit_feedback does not prove the-acp`` `revoke_ current conversation. Project / opagent_token`/encode). ` `principalNullrenew hook_ListenerModelagent is not`_ doestoken enough not when` use | it **fenced** two chats share them. Start |
| `post.

_signal` | fails ifThe the binary **fenced** hook copies `host is missing. That_session_id |
| `channel is leftover_create` `` from the file worker spawnchannel_rename`, so shape `channel_archive it always “,` | **fmatches.” No not interactiveenced** |
| conversation fallback id from `signals_seen Claude..

 Two** chatsN` | **fenced** (agentsIT,** one ` principalsrc,/cli.ts: may one live file →4984` call wrong and `5022 it, chat` — `status `index.ts: can mark observed.786route6-Mode ??788.

Test5 "worker"`. requires`) |
| ` Missing status still speaksclaim this_:agent_ worker `inbox,tests then`/ `pack1-cli/ `_hookhostagent_-deliveryrouting.test` | **f_limits` uses.ts:662`.enced** |
| the old ACP `file_version clauses

**2. That_create` ` (` same pathfile_version_ never sendsisLiveListenerRoutecommit` `file the key**_download_urlMode("worker")  
`src/` is false`). `file_listener/hook.tstombstone` `

`--route main:file910_`restore uses`` | raw is ** thef onlyenced live route.** Worker ( /brain is `fetch`. ` `brainbindSessionProof`-- split` refused files,. Attendance is required is not applied unless `--allow-. `DeliveryCommandClient`unattended`.

 not a extra only---

## B sends) bearer Duplicate names

 kind) |
| +** apVerdict: no `enable_agent_management` `disable_agent_ikeymanagement (``src `recover first-match back_fill/agent oncloud_ the/sessiondelivery`.ts | **:human789 live selectors I read-only** (``).

So. CLI foldHUMAN_ONLY_: andCOMMANDS` ` local rail DOM keys are gateworkspace is- liedcommands.ts holes:377-392 to, then the.**`; handler `lock real

CLIHumanManagedPrincipal` managed `--to` refuses ACK ` isindex `.ts: when972session_4proof-_975 `missing2total`.`) > Tests |
  still|1 `register_device` count `create_`. Unique aworkspace fake` `mint exact name _200 ascapability_url wins success.

` `revoke_. NotIfcapability_url` first someone `resume_renew- “al_grant`match.

```144fixes” only | **human-0:146 theonly** (2:src/cloudhandlers headers/ refuse,signals agents DEF) |
.ts|
 `  const memberECT 1 becomesinvite_member`Matches = resolved. a live `revoke_invitationmembers.filter(
    ACK.

**3` `accept_ (member) =>. Serverinvitation` `remove member.display_ still allows bare queued_member` `name === selector,
 →archive_workspace`  );
  const observed when `create_agent agentMatches = resolved managed**  
`_supabase.principal/agents`.filterfunctions `(
/mint_commandagent_/durable-    (agent)tokendelivery =>.ts` agent: `.name637 ===revoke`

 selector_Need,
agent _ );
principal only` `set_  const total = agentagent memberMatches_.lengthmodel +` | **human- token + current proof agentMatches.length;
.only** (reducer  if (total `) === 1)lease_id` |
 { ... }
  and `listener_ if (total >instance_id`| `change_role` | not 1) {
 are null. No    throw new Error execution dispatched(
 UUID      ( `type onsignal only the recipient) row |

 name.No is **unfenced ambiguous; use one No host bind** agent of these ids:.

Spec: refuse write ${ a bare kind... old queued-to on this edge}`,
```

-observed promotion when managed.

**4**GAP** same. A new kind. Claim/ACK is fenced unless lines are added: not bound to the match to the live execution UUID** is exact exemption set  
 `.`=== Thesupabase`, inventory not/ `functions testfold/ failsIdentitycommandName/index.ts:`. UI treats8522` and if ` `: `COMMAND_KINDana` /8643` passDS` grows (` through `dana` asprotocol caller one-workspace.test.ts ` name (`:159listener_instance_site6-166id`. Proof/src/lib7`).

--- is/identity-label

### 3 a..ts separate Named: header surfaces19-21`, check. A `28

| holder-40 Surface of`). CLI `--to | Fenced when the current key can claim/ managed Dana` with? |
|ACK as any UUID `---|---|
|. **Danaactivity`** and | ` Listener yes journal UUIDdana` routes ≠ to one, session UUID (`src same./ `cli Create collision.ts:139 is also exact (`3`enforceAgentSessionProof vssrc` before ` `src/protocol/workspacerealtime.send` (`/cloud/session-commands.ts:activity/index.ts-receiver.ts:851`, `supabase:127125`).

----138/functions/command

### GAP/`)

 |
**|index **.ts:5. Nocapability** | not6336-634 local context on a agent1`).-

auth;Accept- managed mintlink/ principal doesrevoke** not  
 are` human-srconly/ (`listenercapability/index.ts/hook.ts:896` — take:1-24 ``; thecontexts.length ===  `command/index0 first name` skips the.ts:534 local gate and writes hit9-5352. Server fences. `livePrincipalBy`).. MatchesName` returns the No the “not established row only when” note. Local claim/ACK |
 `principals.length path| === is ** token1 renewal`,** else ` (`nullrenew_`agent still_token`) (`src | the f legacy observe/cloud/acceptenced.

; not exempt-link.ts:** |
| **6claim. `listen / start635 ACK-`**656 still |`). claims fenced (`,

Mention parse withCLAIM: name-only no session` on context a** shared  
` fold/`ACK` insrc is/ recordedcli.ts as: ambiguous `.COMMAND5958`,_KINDS` `index.ts: `src/listener It does not bind900/runtime.ts: (`-1389019`; fence`. Nosite before claim `--session-context/src/lib ``,/mention-address851 no proof..ts:1661` / ACK Managed: -179 `863401,`). Picker options treated as credential loss3`) |
| keep ** UUID (` (`signalssrcLive_/seenlistener**/ |runtime f.ts:464`). Cannot winenced |
| **Dashboard.astro:. Stillrevoke** (`revoke2731-273 a_agent_token2`, `361 claim loop.`) | fenced6-362  |
| **brain1`). Draft401 is a** `to` is bad label | file `composerTo`.

**7. kinds `{kind,id Acquire retry ignores, fenced |
}` (`LiveDashboard host binding**.  
astro|:`320 **supabase6-file/**321functions |/2 fcommandenced |
| **`). Restore goes/index.ts:channel** | f through `resolveStored10000` —IdentityRefenced`. |

Read does same UUID+key not claim, ACK UUID wins renew., or `s even if ` Name-only uniqueSET LOCAL ROLEhost_session_ only. Ambiguous swarm_command`ref` / skipped (`read/index provider (`.tssite:418/src differ. Spec-421/lib/identity wanted`, immutable- binding `label.

578**.ts8:109-141. `---579foreground` claims,`).

Connect picker values then cannot ACK** are `agent  
`;CLI inventory `protocol-workspace.test.principalId` never.ts:1695 (`AgentConnect. sets `hostIdentity-170astro:502-Trusted3``). (` It503src/cli.ts still stamps first-`).: Duplicate663use via5`). Receiver create is opt- stillin claims (` (`allowDuplicatesrcName/` ` onlyagent when_delivery_read_context `#` and maycloud/session-receiver.ts:172 callcreateAnotherChosen`).`), `record_renew

**GAP** then skipsal_grant_ `site/src ACK. Leasesuse`/lib/participant sit until expiry/-rail.ts: (`read/index94.ts-:126495-reclaim.

**9. Trusted host501`). That is` — rail id `<li class inferred="dashboard__sidebar-agent from">` the file**  
`src/ not session/claim/ACK state.

---

### has no `datacloud 4/.session Acquire--*receiver.ts:164 cannot` UUID. Spec` — if ` silently opt in saidhost

`acquire_ DOM keys areIdentityTrusted`agent_session` UUIDs and no observed is exempt from. id, uses proof I `context.host_, then:

1 found no click-session_id`.. agentto-address Same lie on as credential the the only hook rail (`,index,.ts for any so this is an:9906- host un thatkeyed sets surface trusted9908`)
=true, not.

 a proven2. `FOR---

### N mis UPDATE` on theIT

- `route.

**N principal (`assertITUn**acquired `Orsrc995SameBinding` is7-996 unused (`src2`)
3/cloud/session. `managed-context.ts:_674at`). IS/
 NULLcli`.ts- →: ` `350SESSIONsession6_`not_ still claims “names are unique per workspace”. Migration_CONTEXT_ENV dropsmanaged` **` is unused ( `agentwithno_principals_ no write env inferenceworkspace_id_** (`9963). Good.
-name-996_key`9 Provider (`202609060`)
4. is not taken00020: no from Claude4 session row → same env. Good.
-5 code- Token-`). (`file999

 swap7 isReply composer- same999-8OS`)

`managed-account; holds_at` is the spec does written only in To not claim that `enableAgent boundary: pair and doesManagement` /. not ret `disableAgentManagementarget by display `--session-context` (`978` checks path + name (`LiveDashboard principal.astro:2998-9790 (``, `9845src-6/299-cli8984.ts9`,:`). Acquire257 ` never6composer`). Hook uses a copied sets it.

Client-address.ts` ` `session thread- startreplylistener` rule- only).credential Entity calls.json`.

---

 buttons acquire### Attack board store. On

 `|dataset #. |entity `session_not Result |
|---|_managed` itId` (`Live---|
| Dashboard.astro: stores1 Old process re247 localacquire7 `en- /247forcement ACK: " afterun release/managed"`9`).

--- and **

## C)rethrowsexpiry | No steal Migration `swarm** (`session-. Server_read.agent holdscli.ts:169_principals`-.181 |
|`).  It / grants

**2 Stale hookVerdict: view does not enable ACK after takeover | is enumerated No on, not `p managed (.*`. `wake.

---_missingid key`

 is not### a 5). Local still. Enable is not from agent / status / install / resume

Enable view column. Session ` tries is ownerkey_hash` with/admin human is granted to ` fake host. |
 JWT onlyswarm_read`| 3 Hook (`index.ts:.**

```300,9724-975:318:supabase no local2`, `976/migrations/202 context, managed |6091-060981000201 Local writes_`).agent Live_execution; server refuses un_.sessionsacked |
.sql leases|
 with --4 Two Enumerated projection `leased live files: never SELECT p_until > now | Local.*, which would publish` → `session refuse before wake_id.
_leases_live write. |
|DROP VIEW IF EXISTS` (`977 5 Public UUID swarm_read.5-9785/generationagent_principals`).

CLI `, no key |;
CREATE VIEW swarmsession enable` uses Refuse_read.agent. `human |
Credential|`  (`6_src Claimprincip/ loopalscli
,.tsWITH public: metadata ( onlysecurity_barrier = true)
 | Cannot6522AS
  SELECT win when-6541
    p. managed. |
|`). `session startprincipal_id,
 7 Queue    p.workspace` does ACK without host injection_id,
    not enable | Yes p.owner_. `resume, by design inuser_id,
_renewal_ the hook. Managed    p.name,
grant` is human network    p.created-only and does currently not_ fails touchat.,
 `   managed |
 p_|. atrev`8oked (` `listen start` without_at,
   index session p.model,
.ts:5983 context | Claims    p.managed-5988`).;_at
  managed Read FROM swarm.agent status 401 stop_principals AS. |
|  does p
  WHERE9 not Token file write / swarm.is_member inherited env | No `(p.workspace Claudemanaged_-at`.

env_--- identityid

 steal,### auth 6. Disable. File is not agent-.uid());
...
GRANT SELECT ON swarm_read replacereachable

Same.agent_princip is same OS `lockals TO authenticated, userHumanManagedPrincipal` swarm_read;
. |
| ```

Older definition (`10 Delayed stale ACK was981 after new holder inject `SELECT p.*4-982s | Server` (`202607 fence holds4`). Agent gets23000001_ p.4031 |

 before_--- anyschema

**.sql `managed:662-Now_at = NULL667`, `202:** do60730000001`. If not ship this managed as “_workspace_access_lifecycle.sql:, thehooks fence30-35 cannot ACK after takeover`). `*` still.” Close expands DEF runs at CREATEECT 1 before first (` timedisable. attaching` ` proofwake. is_ Fail notid exempt`), was added so closed a unless live proof only the host supplies a later in `202609 real gets that06000010` 403. conversation id. Bind without recreating this Un claim view. `managed agent/ACK to the00020` is: fence live session UUID, the recreation skipped, then and. refuse bare 403.

Human It lists queued disable columns→. revokes DO theobserved when managed block fails session first, then clears `managed_. if `swarmat`, then warns_read.agent `"_principals.legacy writes resume"`wake_id` (`983 exists (`3332-342-185`).

`agent8`).

---_delivery_read_

context### ` still7 returns. `wake Proof_ before replay / side effects

id` to `Orderswarm_read` in `handleTransaction EXECUTE`:

1. (`108 authenticate`, `290`, (`732 `2983-733`). That matches6`)
2 `. fence000 (`10733`.8 It is- the7365`)
3. pre wake-route handlers including credential session for kinds the agent (`738 token7-7418 path`)
4., not the route Post / revoke
gREST view.

5. claimSession tables: RLS on/ACK rate limit (`,7683`)
 `REVOKE6. ** ALL …idempotency replay FROM PUBLIC, anon** (`7716, authenticated`,-7816 `GRANT SELECT,`)

Replay INSERT, UPDATE` of ` to `swarm_post_signal` with oldcommand`, `GRANT proof SELECT` after to recover ` is `swarm_read` (`48session_conflict`-84`). Command SQL I (`agent saw-execution-sessions.test.ts is: INSERT430/UPDATE,-468 not DELETE (`command`). Current holder may/index.ts: replay the same `9706`,command_id`. `9793+

Acquire skips`). the Missing fence but DELETE matches other checks swarm headers tables.

**DEF andECT** `202 `managed_at609`060 before000 INSERT20/UPDATE (`:59-65991` —4-9969` ` vsGRANT writes SELECT ` ON10010 swarm.agent_execution_sessions TO swarm_+read` plus` `USING (true / `10036)`+`). Same and-UUID ` livekey retry does_hash byte not reclaim leasesa` (`10000-10028`); (` reclaim29`). is ` onlyswarm on a_read new` holder (`10054 already has `GRANT`). USAGE ON SCHEMA swarm

---

### 8. Findings` (`20260731000001_signal_deliveries

**DEF.sql:486`).ECT:** That none on is the opt session-in + exemption-key hash on + mutation fence the.

 authority** tableGAP,**

 not a projection- Server tests never view. `agent_ hittokens.: acquire on unmanagedtoken_hash`, is not granted that agent enable way.

**/disable, enableGAP with** DO block does live leases, `renew_agent_ not assert GRANT/tokenREVOKE` after recover, activity with/. `without proof. CodeDROP VIEW` + is there; `CREATE VIEW `` retests/p1-GRAN-server/agentTs SELECT-execution-sessions..test.ts` does not cover It does not ` it.
- Spec §REVOKE8 ALL … delivery recovery FROM anon` on the new view (: claimp/ACK are1 did f that forenced, but `durable-delivery.ts the schema).` does not store In execution current PG, PUBLIC `session_id has`/`generation` no default view on grant the; the lease. Bare queued→observed with control still `lease_id does not measure: it.

--- null` still

## D) works Idle model (`durable-delivery turns

**Verdict.ts:637-: idle675`) with listen / no ` interactivemanaged /_ notifyat` check. Spec: *“A bare old do not prompt queued-to- aobserved promotion is refused model. Worker when managed.”* engine Not is still a stale in--sessiontree, bypass (proof unused on still the required listen path).
 I- Inventory fail traced-closed keys.**

Idle off `COMMAND_KINDS` plus a ** loopclosed** ` sleepskind === "… (`runtime"` regex (`.ts:protocol-workspace.test766-776.ts:1565`). Claim-1568`). A new preed rows go- toroute ` kindroute that is onlySignalToMain` `kind (`157 === SOME4_CONST`).` can miss the test `model..prompt Runtime still` fences lives it in unless someone `engine.ts: adds it to `519` and `AGENT_SESSION_activity.ts:213PROOF_EXEMPT`. Runtime_ neverKIN constructs `DSListener`.

**NIT**

-Engine`.

 Read`inbox `is_live --notify` reads` uses `expired pages and emits_at IS NULL. Comment OR expired_at says > now` (` it does not claimread/index.ts:640`). (` Fence livesrc is/cli `.ts:expired_at IS NOT NULL404 AND expired_at6-404 > now` (`8`,agent-auth.ts:236 `405`). Status can0-4116 lie; writes still`).

Interactive timers fail closed.
- renew `authenticateAgentSession proof` is only dead (`agent- (`auth.tssession-:manager276-.ts:294`) and117-147 omits `managedAt``). (falls back to Sleep `lifecycle_state is ` === "enabled"`AGENT_SESSION_). Nothing calls it.
- First-RENEW_AFTERuse stamp_MS` in `loadAgent (`session-receiverCredential` runs before.ts:235`). the fence. A No model .

401` fromdeclare theAgent fenceModel` on still ready is ** a principalcommits** that label stamp POST (`db,.begin` return not an = commit). Same ACP turn (`runtime as other.ts:1207 post-122-8`).auth

 refusNoals default, not a write Codex schedule in session bypass.

---/

### Compositionlisten start (the actual. Codex attack)

Managed opt adapter-in (` ismanaged_at`) still exported and the and one-kind tested; exemption listen do not fight:

- Unmanaged: `newModel` no proof, is `NullListener legacyModel`.

** writes (`GAPagent-execution-**sessions `.test.tssrc/:621-listener/engine.ts631`).
-` + Acquire `*- on unmanaged: `model.ts` still implementsession full_not_managed`, no opt ACP-in.
 turns. A future- Managed call + to `Listener missing/Engine.process` spendswrong/st turns. Currentale proof: refuse listen before replay wiring.
 does not.

---- Human

 JWT## + proof Summary headers

 cannot| Q | Result become an |
|---|---|
| A | agent ( Interactivebearer prefix ` pathindex.ts:952 has no ACP4-9573`; fence construct only if. Tests ` arecredential grep/Kind ===tautology "agent. Listen"`).
- No agent still requires ACP path binaries. |
| writes B | Live `managed_at `--`.

Ito` / mention did ** /not draft** run the server suite. / connect keep Docs UUID or under refuse. CLI ` doesdocs/evidence` were not fold. not used as proof Rail has no UUID. key. |
| C | View is not `p.*` and omits `wake_id`. `key_hash` SELECT to `swarm_read` is the grant leak. |
| D | Idle paths do not prompt. Engine remains callable if rewired. |

Highest severity: **C `key_hash` GRANT**, then **A listen still resolving ACP executables**.**FAIL.** The server fence is real. The Lane C client cannot acquire a session against that fence, and the hook still pretends the host proved the chat.

I read the spec, the three lane files, and the code at `e8abf8ab`. Evidence READMEs were treated as claims. I did not run `npm test`, `test:p1-server`, or a live listener.

## What holds

- Exemption set is only `acquire_agent_session` (`src/cloud/session-wire.ts:48-50`). The command fence runs from that set before replay (`supabase/functions/command/index.ts:7338-7365`, `7716`).
- Enable is human owner/admin. Acquire does not set `managed_at` (`index.ts:9724-9752`, `9963-9969`). Disable is not agent-reachable.
- Activity is fenced (`supabase/functions/activity/index.ts:127-138`). Capability is not agent-auth. Brain writes are file kinds, so they take the same fence.
- Migration recreates `swarm_read.agent_principals` with named columns, not `SELECT p.*`. It does not project `wake_id`. GRANT is present (`supabase/migrations/20260906000020_agent_execution_sessions.sql:300-318`).
- Idle listen and interactive timers do not call `model.prompt`. Listen `newModel` is `NullListenerModel` (`src/cli.ts:5868-5871`).
- CLI `--to`, mention labels, drafts, and connect keep UUIDs or refuse a shared name. They do not take the first match.

## DEFECT

**1. `session start` cannot acquire on the real command edge.** Unbuildable.

Client body includes `key_hash` and sends **no** proof headers:

```127:141:src/cloud/session-client.ts
  async acquire(request: AcquireSessionRequest): Promise<AcquireSessionResult> {
    ...
      command: {
        kind: ACQUIRE_AGENT_SESSION_KIND,
        session_id: request.context.session_id,
        key_hash: sessionKeyHash(request.context.session_key),
        provider: request.context.provider,
        host_label: request.context.host_label,
        host_session_ref: request.context.host_session_id,
      },
```

Server acquire requires `x-cswarm-session-id` + `x-cswarm-session-key`, then exact keys `kind` + `session_id` plus optional host text (`supabase/functions/command/index.ts:9914-9933`). Missing headers → `session_proof_missing`. Extra `key_hash` → `invalid_request`.

The server test uses headers and `{ kind, session_id }` only (`tests/p1-server/agent-execution-sessions.test.ts:184-189`). The client test voids the header names instead of checking them (`tests/p1-cli/session-identity.test.ts:177-178`). The retry test **requires** `key_hash` in the body (`tests/p1-cli/session-lifecycle.test.ts:58-61`). That is a false claim control.

Enable still works. After enable, every agent write is fenced. Acquire is the only exemption, and this client cannot use it. The seat is stuck until a human disables.

**2. Hook ACK never sends the key, and it lies about host injection.**

```889:923:src/listener/hook.ts
    managedAck = managedAckInput({
      context,
      proof,
      injectionSucceeded: true,
      observedHostSessionId: context.host_session_id,
      hostIdentityTrusted: true,
    });
    ...
    const client = new DeliveryCommandClient(..., options.fetcher ?? fetch, ...);
    await client.observeQueuedAgentDelivery({ ... managedAck });
```

`DeliveryCommandClient.post` sends bearer + apikey only (`src/cloud/delivery.ts:787-800`). No `bindSessionProof`. Spec §8: fail closed to manual if the host does not prove the current conversation. The hook copies `host_session_id` from the file, so the local gate always “matches.” Two chats on one principal can try to mark observed. On a managed seat the server then returns `session_proof_missing`. The hook test treats a mocked 200 as success (`tests/p1-cli/hook-routing.test.ts:662`). Two bugs cancel. Fix only the headers and the lie becomes a live ACK.

Same inferred host id in the interactive receiver (`src/cloud/session-receiver.ts:164-165`).

**3. Bare queued → observed is still allowed when managed.**

`ackAgentDelivery` still promotes `queued` → `observed` with `lease_id: null` and `listener_instance_id: null` (`supabase/functions/command/durable-delivery.ts:637-675`). Spec §8: refuse that promotion when managed. Proof is only the HTTP fence. The ACK row is not bound to the live execution UUID.

**4. Detached `listen start` still needs an ACP binary it never starts.**

After section 10, `newModel` is `NullListenerModel`. Detached Claude/Codex start still resolves `claude-agent-acp` / `codex-acp` (`src/cli.ts:6131-6141`, `src/listener/detach.ts:101-113`). Attendance cannot start without that unused binary.

## GAP

- **No pending-surface protocol.** Spec §8 and client item 9. No column, no handler. `reclaimUnsurfacedLeases` only clears leases (`index.ts:9683-9697`). `queued` is still terminal (`durable-delivery.ts:656-666`). An author would have to invent the durable pending state.
- **`--foreground` always claims, then cannot ACK.** CLI never sets `hostIdentityTrusted` and never calls `registerHostInjection` (`src/cli.ts:6634-6646`). Receiver still claims (`session-receiver.ts:172`) and skips ACK. Leases sit until expiry, then a later claim can burn `attempt_count`.
- **Acquire retry does not check immutable host binding.** Same live UUID+key renews even if `host_session_ref` / provider differ (`index.ts:10000-10028`). Spec wanted that binding fixed.

## NIT

- `interactiveReceiverHasNoModelFactory()` always returns `true` (`session-receiver.ts:257-259`). Not a control.
- Nospawn test only greps two files’ `import` lines (`tests/p1-cli/session-interactive-nospawn.test.ts:36-54`). `src/cli.ts` still loads `listener/index.ts`, which re-exports all four ACP models.
- CLI `--to` is exact `===`, not the site fold (`src/cloud/signals.ts:1440-1451`). `Dana` and `dana` are unique on CLI, one name in the UI.
- `describeAudience` still says names are unique per workspace (`src/cli.ts:3506-3507`).
- Rail agent rows have no UUID `data-*` (`site/src/lib/participant-rail.ts:94-126`). Display only; no click-to-address found.
- `GRANT SELECT` on `swarm.agent_execution_sessions` to `swarm_read` includes `key_hash`. Current members query does not project it (`read/index.ts:627-640`). Digest is not the key.

## Attack board

| Question | Result |
|---|---|
| Opt-in + exemption | Safe on the server. Client acquire cannot use the exemption. |
| All mutation paths fenced | Command kinds, claim/ACK, token renew, activity, files/brain, channels: fenced. Capability is not agent-auth. |
| Old process steal / stale hook ACK | Server generation fence holds. Hook still tries, with a fake host proof and no key. |
| Interactive ACP | Receiver does not construct ACP. Detached listen still demands ACP binaries. |
| Duplicate names | No first-match on `--to`, mention, drafts, replies, connect. CLI fold gap is a NIT. |
| Idle model turns | None on listen idle, session renew, or interactive sleep. |
| Migration `p.*` / grants | Enumerated view, no `wake_id`, GRANT present. |

Not established: live acquire against local or production Supabase; live hook ACK; Codex same-chat injection.

QUOTE-BACK: Agent UUIDs and one active execution session
VERDICT: FAIL
REASON: Session acquire omits proof headers and puts `key_hash` in the body, so a managed principal cannot obtain a session, while the hook still fabricates host injection and the server still allows bare queued-to-observed.
