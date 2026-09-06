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
  doc.querySelector("[data-composer]").hidden = false;
  await settle(200);
  const input = doc.querySelector("[data-composer-input]");
  const out = { found: !!input };
  const other = doc.querySelector("[data-composer-send]");
  // CASE 1 — a draft was loaded into the box programmatically (what restoreComposerDraft does),
  // then focus arrives with NO pointer in the text (Tab, or focusComposerOnEntry on desktop).
  input.blur(); other && other.focus();
  input.value = "hello world";
  out.case1_caretAfterValueSet = [input.selectionStart, input.selectionEnd];
  input.focus();
  await settle(120);
  out.case1_caretAfterKeyboardFocus = [input.selectionStart, input.selectionEnd];
  // CONTROL — same focus, but a pointerdown lands in the text first. The code says the tap wins.
  input.blur(); other && other.focus();
  input.value = "hello world";
  input.dispatchEvent(new view.PointerEvent("pointerdown", { bubbles: true }));
  input.focus();
  await settle(120);
  out.control_caretAfterPointerFocus = [input.selectionStart, input.selectionEnd];
  // CASE 2 — the user typed, blurred, and came back with no pointer. The caret should be restored.
  input.blur(); other && other.focus();
  input.value = "hello world";
  input.focus();
  input.setSelectionRange(5,5);
  input.dispatchEvent(new view.Event("select", { bubbles: true }));
  await settle(60);
  input.blur(); other && other.focus();
  await settle(60);
  input.focus();
  await settle(120);
  out.case2_caretRestored = [input.selectionStart, input.selectionEnd];
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
for(const [w,h] of [[1440,900],[390,844]]){
  const {stdout}=await run(chrome,["--headless=new","--disable-gpu","--no-sandbox","--single-process","--no-zygote","--run-all-compositor-stages-before-draw","--window-size=1600,1200","--virtual-time-budget=9000","--dump-dom",`http://127.0.0.1:${port}/__probe?width=${w}&height=${h}`],{maxBuffer:20*1024*1024,timeout:30000,killSignal:"SIGKILL"});
  const enc=stdout.match(/data-probe="([^"]+)"/)?.[1]; const e=stdout.match(/data-probe-error="([^"]+)"/)?.[1];
  console.log("=====",w+"x"+h);
  if(!enc){console.log("NO RESULT err=",e?Buffer.from(e,"base64").toString():"none");continue;}
  console.log(JSON.stringify(JSON.parse(decodeURIComponent(escape(Buffer.from(enc,"base64").toString("binary"))))));
}
server.close();
