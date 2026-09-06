import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
const distRoot = "/tmp/lane-mobile-a/site/dist";
const types = { ".css":"text/css", ".html":"text/html", ".js":"text/javascript", ".png":"image/png", ".svg":"image/svg+xml", ".woff2":"font/woff2" };
const probe = `<script>
const frame = document.querySelector("iframe");
const err = (v)=>{document.documentElement.dataset.probeError = btoa(String(v));};
const go = async () => {
  const doc = frame.contentDocument, view = frame.contentWindow;
  const settle = (ms)=>new Promise(r=>view.setTimeout(r,ms));
  await settle(500);
  const app = doc.querySelector("live-dashboard");
  const out = { state: app.dataset.state, hasVV: !!view.visualViewport };
  // Make the NON-channel page tall enough to scroll, the way a long empty/choice panel would.
  const spacer = doc.createElement("div");
  spacer.style.cssText = "height:2000px";
  doc.body.appendChild(spacer);
  await settle(120);
  out.rootOverflow = view.getComputedStyle(doc.querySelector(".dashboard__root")).overflow;
  out.scrollableHeight = doc.documentElement.scrollHeight;
  // CONTROL A: scroll, do nothing, confirm the scroll sticks.
  view.scrollTo(0, 300);
  out.controlA_immediate = view.scrollY;
  out.controlA_docEl = doc.documentElement.scrollTop;
  doc.documentElement.scrollTop = 300;
  out.controlA_afterDocElSet = doc.documentElement.scrollTop;
  out.bodyScrollTop = doc.body.scrollTop;
  out.docElClientH = doc.documentElement.clientHeight;
  out.docElScrollH = doc.documentElement.scrollHeight;
  out.bodyOverflow = view.getComputedStyle(doc.body).overflow;
  out.htmlOverflow = view.getComputedStyle(doc.documentElement).overflow;
  await settle(120);
  out.controlA_afterScrollNoEvent = view.scrollY;
  // TEST: scroll, then fire the visualViewport event a URL-bar collapse fires.
  view.scrollTo(0, 300);
  await settle(50);
  out.beforeEvent = view.scrollY;
  view.visualViewport.dispatchEvent(new view.Event("resize"));
  await settle(200);
  out.afterVisualViewportResize = view.scrollY;
  view.scrollTo(0, 300);
  await settle(50);
  view.visualViewport.dispatchEvent(new view.Event("scroll"));
  await settle(200);
  out.afterVisualViewportScroll = view.scrollY;
  // NEGATIVE CONTROL: in the channel state the page cannot scroll at all.
  app.dataset.state = "channel";
  await settle(150);
  out.channel_rootOverflow = view.getComputedStyle(doc.querySelector(".dashboard__root")).overflow;
  view.scrollTo(0, 300);
  await settle(80);
  out.channel_afterScroll = view.scrollY;
  document.documentElement.dataset.probe = btoa(unescape(encodeURIComponent(JSON.stringify(out))));
};
frame.addEventListener("load", ()=>{ go().catch(err); });
</script>`;
const server = createServer((req,res)=>{
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/__probe") {
    const w = url.searchParams.get("width"), h = url.searchParams.get("height");
    res.writeHead(200,{ "content-type":"text/html; charset=utf-8" });
    res.end(`<!doctype html><html><body style="margin:0"><iframe src="/app" style="border:0;width:${w}px;height:${h}px"></iframe>${probe}</body></html>`);
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
for (const [w,h] of [[390,844]]) {
  const { stdout } = await run(chrome, ["--headless=new","--disable-gpu","--no-sandbox","--single-process","--no-zygote","--run-all-compositor-stages-before-draw","--window-size=1600,1200","--virtual-time-budget=9000","--dump-dom",`http://127.0.0.1:${port}/__probe?width=${w}&height=${h}`], { maxBuffer: 20*1024*1024, timeout: 30000, killSignal:"SIGKILL" });
  const enc = stdout.match(/data-probe="([^"]+)"/)?.[1];
  const e = stdout.match(/data-probe-error="([^"]+)"/)?.[1];
  console.log("=====", w+"x"+h);
  if (!enc) { console.log("NO RESULT. err=", e ? Buffer.from(e,"base64").toString() : "none"); continue; }
  console.log(JSON.stringify(JSON.parse(decodeURIComponent(escape(Buffer.from(enc,"base64").toString("binary")))), null, 1));
}
server.close();
