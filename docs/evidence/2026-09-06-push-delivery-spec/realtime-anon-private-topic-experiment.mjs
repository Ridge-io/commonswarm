import { createClient } from "@supabase/supabase-js";
const url = process.env.API_URL, key = process.env.ANON_KEY;
const c = createClient(url, key, { realtime: { params: { eventsPerSecond: 5 } } });
await c.realtime.setAuth(key);
const results = [];
function sub(topic, priv) {
  return new Promise((resolve) => {
    const ch = c.channel(topic, { config: { private: priv } });
    const t = setTimeout(() => resolve({ topic, priv, status: "TIMEOUT(10s)" }), 10000);
    ch.on("broadcast", { event: "wake" }, (m) => results.push({ topic, got: m.payload }));
    ch.subscribe((status, err) => { if (status !== "SUBSCRIBED" && status !== "CHANNEL_ERROR" && status !== "TIMED_OUT") return; clearTimeout(t); resolve({ topic, priv, status, err: err?.message }); });
  });
}
const a = await sub("cswarm-inbox-test:2121f81d", true);   // allowed by the local policy
const b = await sub("cswarm-inbox-other:2121f81d", true);  // not allowed: expect CHANNEL_ERROR
console.log(JSON.stringify({ a, b }));
// server-side send from SQL, then wait for arrival on the allowed topic
const t0 = Date.now();
await new Promise(r => setTimeout(r, 500));
console.log("SEND_NOW");
await new Promise(r => setTimeout(r, 4000));
console.log(JSON.stringify({ received: results, waitedMs: Date.now() - t0 }));
process.exit(0);
