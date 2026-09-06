### Inversion Analysis on the Pending-Surface Contract

1. **Delivery rows bound to session+generation at claim**
   - *Opposite argument*: Do not bind session or generation at claim; leave rows bound only to `lease_id`/listener instance and bind session proof only at ACK.
   - *Predicted failure*: A zombie or resumed receiver process whose lease expired can cross-ACK or steal messages across generation increments, violating execution fencing and allowing split-brain signal handling.
   - *Beat the spec?*: **No.** Binding at claim ensures stale execution generations cannot touch or ACK claimed deliveries.

2. **ACK gated on `surfaced=true` plus current proof with `queued` nonterminal**
   - *Opposite argument*: Treat `queued` as terminal in PostgreSQL upon receipt, or allow promoting `queued` to `observed` without explicit `surfaced: true`.
   - *Predicted failure*: If a receiver process crashes or disconnects after writing to a local queue file before injecting the prompt into the host thread, PostgreSQL considers the delivery complete; the signal is permanently lost.
   - *Beat the spec?*: **No.** Gating `observed` on `surfaced: true` and keeping `queued` nonterminal in Postgres guarantees crash recovery can reopen lost in-flight signals.

3. **Recovery reclaiming unsurfaced rows without counting attempts**
   - *Opposite argument*: Increment `attempt_count` whenever recovery reclaims and reopens unsurfaced `queued` rows.
   - *Predicted failure*: Rapid session flaps or host restarts during injection burn through the 10-attempt ceiling (`DELIVERY_MAX_ATTEMPTS`), permanently dropping valid signals as poison failures before the model ever inspects them.
   - *Beat the spec?*: **No.** Queue-only recovery must preserve `attempt_count` because receiver restarts are infrastructure failures, not signal poisoning; TTL bounds stale retention.

4. **`key_hash` hidden from `swarm_read` by column grant**
   - *Opposite argument*: Grant table-level SELECT to `swarm_read` and rely solely on application conventions or ordinary non-projecting queries.
   - *Predicted failure*: A compromised or rogue read token (`swm_agt_`) can directly query `key_hash`, allowing offline pre-computation or verification of stolen/guessed session keys.
   - *Beat the spec?*: **No.** Defense-in-depth via PostgreSQL column-level `REVOKE`/`GRANT` and the barrier view prevents credential leakage even under application-level query regressions.

---

### Unverifiable Evidence Claims (from Pasted Text)

The pasted text contains only the diff and markdown claims; it cannot verify:
- **Client implementation (Lane C)**: Sending `x-cswarm-session-*` headers, passing `surfaced: true` after host injection, managing local queue caches, and ensuring interactive mode contains no ACP/model factory imports.
- **UI / Member selection (Lane B)**: Disambiguation pickers and UUID-backed mention addressing on duplicate display names.
- **Runtime test execution**: Actual execution output of `npm test`, `test:p1-server`, and `test:p1-local`.
- **Database deployment**: Migration execution (`20260906000030_managed_delivery_session.sql`) against live Supabase environments.

---

QUOTE-BACK: ## 8. Concrete contract and review resolutions
VERDICT: PASS
REASON: The server implementation strictly enforces the pending-surface contract with verified proof bindings, nonterminal recovery, and column-level protection without introducing any defect or gap.
