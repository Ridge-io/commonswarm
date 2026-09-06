import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
const distRoot = "/tmp/lane-mobile-a/site/dist";
const types = { ".css":"text/css", ".html":"text/html", ".js":"text/javascript", ".png":"image/png", ".svg":"image/svg+xml", ".woff2":"font/woff2" };

const probe = (w,h) => `<script>
const frame = document.querySelector("iframe");
const err = (v)=>{document.documentElement.dataset.probeError = btoa(String(v));};
const go = async () => {
  const doc = frame.contentDocument, view = frame.contentWindow;
  const settle = (ms)=>new Promise(r=>view.setTimeout(r,ms));
  await settle(400);
  const app = doc.querySelector("live-dashboard");
  app.dataset.state = "channel";
  doc.querySelectorAll(".dashboard__root > [data-panel]").forEach((panel)=>{ panel.hidden = panel.dataset.panel !== "channel"; });
  doc.querySelectorAll("[data-channel-view]").forEach((s)=>{ s.hidden = s.dataset.channelView !== "feed"; });
  const wsControl = doc.querySelector(".dashboard__workspace-control");
  if (wsControl) wsControl.hidden = false;
  const userRoot = doc.querySelector("[data-user-menu-root]");
  if (userRoot) userRoot.hidden = false;
  const trg = doc.querySelector("[data-workspace-menu-trigger]");
  if (trg) trg.hidden = false;
  const uTrg = doc.querySelector("[data-user-menu-trigger]");
  if (uTrg) uTrg.hidden = false;
  await settle(200);
  const label = (el)=> el ? (el.tagName + "|" + (el.dataset ? JSON.stringify(el.dataset) : "") + "|" + (el.textContent||"").trim().slice(0,30)) : "NULL";
  const vis = (el)=> el ? view.getComputedStyle(el).display : "NULL";
  const settingsItem = doc.querySelector("[data-workspace-settings-item]");
  const menu = doc.querySelector("[data-workspace-menu]");
  const items = Array.from(doc.querySelectorAll("[data-workspace-menu] [role='menuitemradio'], [data-workspace-menu] [role='menuitem']")).filter(i=>!i.hidden);
  const out = {
    viewport: { w: view.innerWidth, h: view.innerHeight },
    settingsDisplay: vis(settingsItem),
    settingsHiddenAttr: settingsItem ? settingsItem.hidden : "NULL",
    settingsClientRects: settingsItem ? settingsItem.getClientRects().length : "NULL",
    enumeratedItems: items.map(i=>({ label: label(i), display: vis(i), rects: i.getClientRects().length })),
    railOverflow: (()=>{ const r = doc.querySelector(".dashboard__rail"); if(!r) return "NULL"; const b=r.getBoundingClientRect(); return { scrollWidth: r.scrollWidth, clientWidth: r.clientWidth, right: b.right, viewportWidth: view.innerWidth }; })(),
    mobileViewDisplay: vis(doc.querySelector(".dashboard__mobile-view")),
    railTabsDisplay: vis(doc.querySelector(".dashboard__rail-tabs")),
  };
  // Keyboard: open the menu, focus the first item, then press End and ArrowDown.
  menu.hidden = false;
  const first = items[0];
  if (first) first.focus();
  out.afterFocusFirst = label(doc.activeElement);
  menu.dispatchEvent(new view.KeyboardEvent("keydown", { key: "End", bubbles: true }));
  await settle(50);
  out.afterEnd = label(doc.activeElement);
  // From the last VISIBLE item, ArrowDown should wrap to the top.
  const lastVisible = items.filter(i=>i.getClientRects().length>0).at(-1);
  if (lastVisible) lastVisible.focus();
  out.beforeArrowDown = label(doc.activeElement);
  menu.dispatchEvent(new view.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  await settle(50);
  out.afterArrowDown1 = label(doc.activeElement);
  menu.dispatchEvent(new view.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  await settle(50);
  out.afterArrowDown2 = label(doc.activeElement);
  // ArrowUp on the TRIGGER opens the menu at its LAST item.
  menu.hidden = true;
  const trigger = doc.querySelector("[data-workspace-menu-trigger]");
  trigger.focus();
  out.beforeTriggerArrowUp = label(doc.activeElement);
  trigger.dispatchEvent(new view.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
  await settle(300);
  out.menuHiddenAfterTriggerArrowUp = menu.hidden;
  out.afterTriggerArrowUp = label(doc.activeElement);
  // A second ArrowUp on the trigger: openWorkspaceMenu bails because the menu is already open.
  trigger.dispatchEvent(new view.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
  await settle(300);
  out.afterSecondTriggerArrowUp = label(doc.activeElement);
  // Control: ArrowDown on the trigger opens at the FIRST item, which is visible.
  menu.hidden = true; trigger.focus();
  trigger.dispatchEvent(new view.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  await settle(300);
  out.control_afterTriggerArrowDown = label(doc.activeElement);
  document.documentElement.dataset.probe = btoa(unescape(encodeURIComponent(JSON.stringify(out))));
};
frame.addEventListener("load", ()=>{ go().catch(err); });
</script>`;

const server = createServer((req,res)=>{
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/__probe") {
    const w = url.searchParams.get("width"), h = url.searchParams.get("height");
    res.writeHead(200,{ "content-type":"text/html; charset=utf-8" });
    res.end(`<!doctype html><html><body style="margin:0"><iframe src="/app" style="border:0;width:${w}px;height:${h}px"></iframe>${probe(w,h)}</body></html>`);
    return;
  }
  const rel = url.pathname === "/app" || url.pathname === "/app/" ? "app/index.html" : url.pathname.replace(/^\/+/,"");
  const fp = normalize(join(distRoot, rel));
  if (!fp.startsWith(distRoot+"/")) { res.writeHead(403).end(); return; }
  try { const st = statSync(fp); if(!st.isFile()) throw 0;
    res.writeHead(200,{ "content-length":st.size, "content-type": types[extname(fp)] ?? "application/octet-stream" });
    createReadStream(fp).pipe(res);
  } catch { res.writeHead(404).end("nf"); }
});
await new Promise(r=>server.listen(0,"127.0.0.1",r));
const port = server.address().port;
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
for (const [w,h] of [[1440,900],[390,844],[320,568]]) {
  const { stdout } = await run(chrome, ["--headless=new","--disable-gpu","--no-sandbox","--single-process","--no-zygote","--run-all-compositor-stages-before-draw","--window-size=1600,1200","--virtual-time-budget=9000","--dump-dom",`http://127.0.0.1:${port}/__probe?width=${w}&height=${h}`], { maxBuffer: 20*1024*1024, timeout: 30000, killSignal:"SIGKILL" });
  const enc = stdout.match(/data-probe="([^"]+)"/)?.[1];
  const e = stdout.match(/data-probe-error="([^"]+)"/)?.[1];
  console.log("=====", w+"x"+h);
  if (!enc) { console.log("NO RESULT. err=", e ? Buffer.from(e,"base64").toString() : "none"); continue; }
  console.log(JSON.stringify(JSON.parse(decodeURIComponent(escape(Buffer.from(enc,"base64").toString("binary")))), null, 1));
}
server.close();
