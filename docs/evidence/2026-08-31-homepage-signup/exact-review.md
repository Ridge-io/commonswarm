# Codex exact review — homepage sign-up — 2026-08-31

**PASS on `59c190bbd77ed352baf902cb50bf5e88eeda00f1`. No unresolved blocker found in this diff.**

Base: `e6cb5d768a41c42c91b0b87e3f3f6b3d34860103`. Scope: the eight changed site files. Independent non-author review. No source edits, commits, real auth requests, or email sends.

The first reviewed commit, `f962c867d8492c8b01c4588a0db8960200bc3ded`, is superseded. I found a no-script header overlap at 481 and 520px. The author fixed the collapse threshold in the final commit. The relevant runtime checks and fault control were repeated on that final commit.

## Source and claim review

- Header, hero, closing section, and footer now offer plain Sign up / Log in links to `/app`. The repository links no longer compete with auth in the header or hero; the footer retains access to the repository.
- Both labels intentionally use one existing form. This does not add separate account modes or replace the auth flow. `LiveDashboard.astro:40` explains that the form creates an account or logs in. Its changed lines are copy only; email submission, session routing, workspace creation, and signed-in behavior are unchanged.
- I checked the claim against `site/src/lib/commonswarm.ts:193`, not only the copy tests. `signInWithEmail` calls `signInWithOtp` with the email and `emailRedirectTo`, without disabling account creation. The installed `@supabase/auth-js/src/GoTrueClient.ts:2284` sends `create_user: options?.shouldCreateUser ?? true` to `/otp`.
- I also ran the installed Supabase client with an injected local mock fetch. The exact call shape used by the app produced `POST /auth/v1/otp`, `create_user:true`, and the `/app` return URL. A second call with `shouldCreateUser:false` produced `create_user:false`. The mock rejects every other request path. No request reached a server. This supports the shared form's intended signup/login behavior; it does not establish real email delivery or production auth settings.
- `SiteHeader.astro:74` preserves Open workspace for its explicit signed-in prop and omits Log in in that branch. `/app` still uses `bareHeader` and `bareFooter`; the marketing shell does not replace the live app shell. The existing lack of a shared marketing-shell session is unchanged.
- The new header button uses the existing `Button.astro` link primitive. Its cross-component styles correctly use `:global(.hdr__login)`. The mobile menu uses a real link, covered by the existing generic close-on-link handler. No event handler or dialog behavior changed.
- The hero uses flex wrapping with the existing 30rem full-width button rule. The panel's 40rem two-column rule, indentation, spacing, header wrapping, and restored fragment IDs remain intact. The final no-script threshold change at `SiteHeader.astro:516` applies only to the inline marketing links when `data-menu-ready` is absent.
- The changed copy observers remain in the paths reached by `site/package.json`'s test script. I did not treat their string checks as proof of the auth claim.

## Runtime target and results

I used an independent gstack Chromium process, separate from the author's in-app browser. The server at `http://127.0.0.1:4329/` was verified as `python -m http.server 4329 --bind 127.0.0.1 --directory site/dist`, with working directory `/Users/yulanbot/Developer/Ridge.io/commonswarm-signup`.

The served HTML matched `site/dist/index.html` byte for byte. Its final SHA-256 was `1be2ac17fc6f55367066d266e981b1288043123f4fbc860d634fb6af050ade53`.

**Scripts enabled:** all 14 actual viewport widths passed: 320, 352, 353, 390, 480, 481, 639, 640, 641, 831, 832, 833, 1024, 1440.

I waited for fonts and measured each visible header link/button box against every other box and the viewport. There were no overlaps or off-screen controls. Document width equaled viewport width. The hero links were both `/app`, stacked through 480px and side by side from 481px. The proof rail stayed hidden through 639px and beside the feed from 640px. At 831px the header showed Sign up and Menu; at 832px it showed the normal links plus Log in and Sign up.

**Scripts absent:** I loaded a copy of the final built HTML with all script elements removed and a local base URL for assets. This is a script-free page fixture, not a browser-wide JavaScript-disable test. Each result verified `document.scripts.length === 0` and no `data-menu-ready` attribute. The measurement script then read the static fallback layout.

All 16 widths passed: 320, 352, 353, 390, 480, 481, 520, 600, 639, 640, 641, 700, 831, 832, 1024, 1440. The fallback keeps only the brand and Sign up through 352px; adds How it works from 353 through 640px; restores all three inline nav links at 641px. Log in appears in the desktop header at 832px. Hero and footer links remain in the static HTML.

**Menu and destination:** at 390px, real keyboard Escape closed the menu, set `aria-expanded` to false, removed the root scroll lock, and returned focus to `hdr__burger`. This passed twice on the first commit and again on the final commit. The author's in-app Escape failure did not reproduce here. Keyboard traversal reached Close menu, the three nav links, Log in, and Sign up; after the browser's focus boundary it returned to Close menu. No background page control received focus. The mobile Log in link opened the visible signed-out email form. On the final build, the hero Sign up link also opened the visible form headed “Sign up or log in.” No form was submitted.

## Independent defect and fault control

The first commit's script-free header showed an overlap between Install and Sign up at 481 and 520px, even though `scrollWidth === innerWidth`. The old base was already affected: at 481px, restoring the old Open workspace label in the otherwise equivalent narrow header made both See the prompt and Install overlap that wider CTA. Source comparison confirmed the base hid its repository icon here and used the same 30rem nav threshold. Thus this was a pre-existing defect in the touched header, not a newly caused regression.

The final commit moves that one threshold to 40rem. After it passed at 520px, I forced the old failure by setting the three inline nav links to `display:block`. The same pairwise-box observer exited **1** with:

```text
header overlaps: [["Install","Sign up"]]
```

Removing the inline display properties restored exit **0**, with CommonSwarm, How it works, and Sign up visible. This control reaches the actual overlap that the document-width check missed. The controls were written and run by this non-author reviewer.

Replay from the worktree root, with the reviewed build served at port 4329:

```sh
python3 - <<'PY'
import os, pathlib, re, subprocess, tempfile
b = '/Users/yulanbot/.claude/skills/gstack/browse/dist/browse'
t = pathlib.Path(tempfile.mkdtemp(prefix='signup-review-', dir='/tmp'))
env = dict(os.environ, BROWSE_STATE_FILE=str(t/'browse.json'))
def run(*args):
    return subprocess.run([b,*args], env=env, text=True, capture_output=True)
html = pathlib.Path('site/dist/index.html').read_text()
html = re.sub(r'<script\b[^>]*>.*?</script\s*>', '', html, flags=re.S|re.I)
html = html.replace('<head>', '<head><base href="http://127.0.0.1:4329/">', 1)
(t/'index.html').write_text(html)
assert run('load-html', str(t/'index.html')).returncode == 0
assert run('viewport', '520x1000').returncode == 0
check = '''window.checkHeader = async () => {
  await document.fonts.ready;
  const h=document.querySelector('.hdr');
  if (!h || h.hasAttribute('data-menu-ready') || document.scripts.length)
    throw Error('wrong fixture');
  const a=[...h.querySelectorAll('a,button')].filter(e=>e.getClientRects().length);
  if(a.length<2)throw Error('no visible controls');
  for(let i=0;i<a.length;i++)for(let j=i+1;j<a.length;j++){
    const x=a[i].getBoundingClientRect(),y=a[j].getBoundingClientRect();
    if(Math.min(x.right,y.right)-Math.max(x.left,y.left)>1 &&
       Math.min(x.bottom,y.bottom)-Math.max(x.top,y.top)>1)
      throw Error('header overlaps: '+a[i].textContent.trim()+' / '+a[j].textContent.trim());
  }
  return {width:innerWidth,labels:a.map(e=>e.textContent.trim())};
};'''
assert run('js', check).returncode == 0
baseline=run('js','window.checkHeader()')
print('BASELINE',baseline.returncode,baseline.stdout); assert baseline.returncode==0
fault=run('js',"document.querySelectorAll('.hdr__link').forEach(e=>e.style.display='block');window.checkHeader()")
print('FAULT',fault.returncode,fault.stderr)
assert fault.returncode!=0 and 'header overlaps:' in fault.stderr
restored=run('js',"document.querySelectorAll('.hdr__link').forEach(e=>e.style.removeProperty('display'));window.checkHeader()")
print('RESTORED',restored.returncode,restored.stdout); assert restored.returncode==0
run('stop')
PY
```

## Limits

This clears the exact code-review arm only; the cross-family arm is separate. I did not deploy, send email, create accounts, authenticate against production, or test a real signed-in identity. I did not independently rerun the complete site/root suites; those results belong to the author. The browser checks used local Chromium and the author's build, not Safari, Firefox, or physical phones. Auth claim verification covered the actual client request and existing app wiring, not production mail delivery or server configuration.
