import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
const distRoot = "/tmp/lane-mobile-a/site/dist";
const types = { ".css":"text/css",".html":"text/html",".js":"text/javascript",".png":"image/png",".svg":"image/svg+xml",".woff2":"font/woff2" };
const probe = `<script>
const frame = document.querySelector("iframe");
const err=(v)=>{document.documentElement.dataset.probeError=btoa(String(v));};
const go = async () => {
  const doc = frame.contentDocument, view = frame.contentWindow;
  const settle=(ms)=>new Promise(r=>view.setTimeout(r,ms));
  await settle(400);
  const app = doc.querySelector("live-dashboard");
  app.dataset.state = "channel";
  doc.querySelectorAll(".dashboard__root > [data-panel]").forEach(p=>{p.hidden = p.dataset.panel !== "channel";});
  doc.querySelectorAll("[data-channel-view]").forEach(s=>{s.hidden = s.dataset.channelView !== "feed";});
  doc.querySelector(".dashboard__channel").classList.add("dashboard__channel--roster");
  doc.querySelector("[data-header-roster]").hidden = false;
  doc.querySelector("[data-header-roster-summary]").textContent = "0 · 3 pending";
  doc.querySelector("[data-live-chip]").hidden = false;
  doc.querySelector("[data-composer]").hidden = false;
  const list = doc.querySelector("[data-feed-list]");
  list.replaceChildren(...Array.from({length:40},(_,i)=>{
    const row=doc.createElement("li"); row.className="dashboard__message";
    const a=doc.createElement("span"); a.className="dashboard__message-avatar"; a.textContent="AG";
    const b=doc.createElement("article"); b.className="dashboard__message-body";
    const m=doc.createElement("header"); m.className="dashboard__message-meta";
    const s=doc.createElement("strong"); s.textContent="Agent "+(i+1);
    const d=doc.createElement("div"); d.className="dashboard__message-markdown";
    d.textContent="Rendered transcript row "+(i+1)+" with enough copy to exercise live feed geometry.";
    m.append(s); b.append(m,d); row.append(a,b); return row;
  }));
  await doc.fonts.ready; await settle(150);
  const r=(sel)=>{const e=doc.querySelector(sel); if(!e) return "NULL"; const x=e.getBoundingClientRect(); return {top:+x.top.toFixed(1),bottom:+x.bottom.toFixed(1),left:+x.left.toFixed(1),right:+x.right.toFixed(1),h:+x.height.toFixed(1),w:+x.width.toFixed(1)};};
  const out = {
    rootFontSize: view.getComputedStyle(doc.documentElement).fontSize,
    bodyFontSize: view.getComputedStyle(doc.body).fontSize,
    appBar: r(".dashboard__rail"),
    channel: r(".dashboard__channel"),
    channelHead: r(".dashboard__channel-head"),
    rosterPill: r(".dashboard__channel-roster"),
    toolbar: r(".dashboard__feed-toolbar"),
    filters: r(".dashboard__feed-filters"),
    feedList: r(".dashboard__feed"),
    firstMessage: r(".dashboard__message"),
    firstMessageBody: r(".dashboard__message .dashboard__message-body"),
    feedPaddingTop: view.getComputedStyle(doc.querySelector(".dashboard__feed")).paddingTop,
    messagePaddingTop: view.getComputedStyle(doc.querySelector(".dashboard__message")).paddingTop,
  };
  // Now show "load older" and re-measure the gap it introduces.
  const more = doc.querySelector("[data-feed-more]");
  more.hidden = false; await settle(150);
  out.withLoadOlder = { more: r("[data-feed-more]"), feedList: r(".dashboard__feed"), firstMessage: r(".dashboard__message") };
  // Scroll the transcript and see what the floating band covers.
  const scroller = doc.querySelector(".dashboard__feed-view");
  scroller.scrollTop = 200; await settle(120);
  out.scrolled = { scrollTop: scroller.scrollTop, head: r(".dashboard__channel-head"), toolbar: r(".dashboard__feed-toolbar") };
  scroller.scrollTop = scroller.scrollHeight; await settle(120);
  out.atBottom = { scrollTop: scroller.scrollTop, lastMessage: (()=>{const e=[...doc.querySelectorAll(".dashboard__message")].at(-1).getBoundingClientRect(); return {top:+e.top.toFixed(1),bottom:+e.bottom.toFixed(1)};})(), head: r(".dashboard__channel-head") };
  document.documentElement.dataset.probe = btoa(unescape(encodeURIComponent(JSON.stringify(out))));
};
frame.addEventListener("load",()=>{go().catch(err);});
</script>`;
const server = createServer((req,res)=>{
  const url=new URL(req.url??"/","http://127.0.0.1");
  if(url.pathname==="/__probe"){const w=url.searchParams.get("width"),h=url.searchParams.get("height");
    res.writeHead(200,{"content-type":"text/html; charset=utf-8"});
    res.end(`<!doctype html><html><body style="margin:0"><iframe src="/app" style="border:0;width:${w}px;height:${h}px"></iframe>${probe}</body></html>`);return;}
  const rel=url.pathname==="/app"||url.pathname==="/app/"?"app/index.html":url.pathname.replace(/^\/+/,"");
  const fp=normalize(join(distRoot,rel));
  if(!fp.startsWith(distRoot+"/")){res.writeHead(403).end();return;}
  try{const st=statSync(fp); if(!st.isFile())throw 0;
    res.writeHead(200,{"content-length":st.size,"content-type":types[extname(fp)]??"application/octet-stream"});
    createReadStream(fp).pipe(res);}catch{res.writeHead(404).end("nf");}
});
await new Promise(r=>server.listen(0,"127.0.0.1",r));
const port=server.address().port;
const chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
for(const [w,h] of [[390,844]]){
  const {stdout}=await run(chrome,["--headless=new","--disable-gpu","--no-sandbox","--single-process","--no-zygote","--run-all-compositor-stages-before-draw","--window-size=1600,1200","--virtual-time-budget=9000","--dump-dom",`http://127.0.0.1:${port}/__probe?width=${w}&height=${h}`],{maxBuffer:20*1024*1024,timeout:30000,killSignal:"SIGKILL"});
  const enc=stdout.match(/data-probe="([^"]+)"/)?.[1]; const e=stdout.match(/data-probe-error="([^"]+)"/)?.[1];
  console.log("=====",w+"x"+h);
  if(!enc){console.log("NO RESULT err=",e?Buffer.from(e,"base64").toString():"none");continue;}
  console.log(JSON.stringify(JSON.parse(decodeURIComponent(escape(Buffer.from(enc,"base64").toString("binary")))),null,1));
}
server.close();
