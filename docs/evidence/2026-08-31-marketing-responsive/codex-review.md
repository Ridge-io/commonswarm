# Codex exact review — 2026-08-31

**PASS. No blocking defect found in the two changed source files.**

- Reviewed commit: `77f701bc3c8b20df4c57eb2feec42620d86f33d1`.
- Base: `820a9e32cf68fed914afd1031946f078352b0e7c`.
- Scope: `site/src/components/landing/ConsumerHero.astro` and `ConsumerStory.astro`.
- Reviewer: independent Codex agent; not the author. No source edits or commits.
- Superseded review target: `834a703727bc3c3168751e47e688ace9539ca149`. The checks below were repeated on the replacement commit. This report clears only the replacement commit.

## Source review

I read the complete two-file diff, both components, the shared page/panel CSS, spacing tokens, page composition, header/footer fragment links, applicable AGENTS files, current main resume file, and verification doctrine.

The breakpoint now changes both properties together: the rail becomes visible and the grid gains a first column. This removes the state that showed the rail in a one-column grid. The second track and message bodies can shrink; the feed remains the full chat width below the breakpoint. At the narrowest visible-rail width, the actual feed is about 403px wide.

The agent-list rule now follows the equal-specificity reset, so its indentation takes effect. The panel gap uses an existing token. The header wrap rule is scoped to this proof panel and does not change other shared panels. The two anchor IDs are unique, point at the inner section headers, and preserve the existing heading IDs and section ARIA references.

The wrapped panel note remains left-aligned below its label on phones. I viewed the 320px panel: both labels are readable and contained. I found no requirement for a right-aligned second row, so this is not a defect. The earlier extra gap after anchor jumps is removed by the final commit's inner-header targets.

## Independent runtime checks

Used a separate gstack Chromium process, with state at `/tmp/commonswarm-codex-review-834a703/browse.json`. It did not share the author's in-app browser. Target: `http://127.0.0.1:4328/`.

I verified the server process was `python -m http.server 4328 --bind 127.0.0.1 --directory site/dist`, running in `/Users/yulanbot/Developer/Ridge.io/commonswarm-responsive`. HTTP HTML bytes matched `site/dist/index.html`; final SHA-256 was `a5e67313182440478bf2cf73f76699c209460b6035540df3e5a628ab75cdb646`. The final rendered anchor nodes were `HEADER`, not the old `SECTION` nodes. The two source files still matched the reviewed commit at the end.

Each check waited for fonts and measured `innerWidth`, actual boxes, computed tracks, document width, and every visible text range inside the panel against all ancestors with horizontal clipping. This checks hidden clipping inside the panel, not only document overflow.

| Actual viewport width | Rail | Computed chat tracks | Visible text rectangles | Result |
| ---: | --- | --- | ---: | --- |
| 320 | hidden | 278px | 37 | pass |
| 360 | hidden | 318px | 35 | pass |
| 390 | hidden | 348px | 33 | pass |
| 480 | hidden | 438px | 31 | pass |
| 639 | hidden | 585.906px | 25 | pass |
| 640 | visible | 184px 402.812px | 38 | pass |
| 641 | visible | 184px 403.75px | 38 | pass |
| 768 | visible | 184px 520.562px | 34 | pass |
| 1024 | visible | 184px 646px | 34 | pass |
| 1440 | visible | 184px 646px | 34 | pass |

All 10 widths had no clipped panel text and no document overflow. At each wide width, the rail and feed shared their top edge and did not overlap. Each narrow feed filled its chat track. The panel gap was 32px and agent indentation was 12px. I also viewed panel screenshots at 320 and 640px.

All six header/mobile-menu/footer fragment links had exactly one target. Direct hash navigation was tested after the smooth scroll settled:

| Width | `#how-it-works` target top | `#install` target top | Sticky header bottom |
| ---: | ---: | ---: | ---: |
| 320 | 96.375px | 96.125px | 65px |
| 640 | 96.469px | 95.672px | 65px |
| 1440 | 95.781px | 95.609px | 65px |

The heading IDs remained `story-communicate-title` and `story-connect-title`.

## Non-author adversarial controls

I wrote and ran these controls independently. They changed only the DOM in my local browser. Both controls ran against the final build at actual width 640px. Each used the same observer as the passing page.

1. **Stacked-rail control:** set `.chat.style.gridTemplateColumns = 'minmax(0,1fr)'` while the rail stayed visible. The observer required matching rail/feed top edges and `rail.right <= feed.left + 1`. The direct browse command exited **1** with `rail is stacked or overlaps feed`. Removing the inline property restored a **0** exit and tracks `184px 402.812px`.
2. **Hidden-clipping control:** set `.chat__main.style.width = '1000px'`. The observer walked the panel's text nodes using `TreeWalker` and `Range.getClientRects()`, then compared each nonempty text rectangle with every `overflow-x: hidden|clip` ancestor. It required at least one measured text rectangle. The direct command exited **1** with `text clipped`, naming all four message bodies in `panel consumer-proof__panel`. Removing the inline width restored a **0** exit and 38 measured text rectangles.

Raw final control outcomes:

```text
CONTROL_BASELINE 0
STACK_MUTATION 1: rail is stacked or overlaps feed
STACK_RESTORED 0
CLIP_MUTATION 1: text clipped [four message bodies, panel ancestor]
CLIP_RESTORED 0
```

These controls reached the layout and clipping checks. They did not fail at a parser, missing selector, network error, or test setup step. The mutations were removed before the browser was closed.

Replay command, with the reviewed build already served at port 4328. This uses a fresh browser state and direct commands, so a failing observer has a nonzero process exit. It does not depend on files from the original `/tmp` session:

```sh
python3 - <<'PY'
import os, subprocess, tempfile
browser = '/Users/yulanbot/.claude/skills/gstack/browse/dist/browse'
state = tempfile.mkdtemp(prefix='commonswarm-review-replay-')
env = dict(os.environ, BROWSE_STATE_FILE=state + '/browse.json')
def run(*args):
    return subprocess.run([browser, *args], env=env, text=True, capture_output=True)
def expect(label, result, ok, message=''):
    print(label, result.returncode, result.stdout, result.stderr)
    assert (result.returncode == 0) == ok
    assert message in result.stdout + result.stderr
expect('open', run('goto', 'http://127.0.0.1:4328/'), True)
expect('viewport', run('viewport', '640x1000'), True)
observer = '''window.reviewLayout = async () => {
  await document.fonts.ready;
  const q = s => {
    const a = document.querySelectorAll(s);
    if (a.length !== 1) throw Error('selector count: ' + s);
    return a[0];
  };
  const rail = q('.chat__rail'), main = q('.chat__main');
  const panel = q('.consumer-proof__panel'), chat = q('.chat');
  const r = rail.getBoundingClientRect(), m = main.getBoundingClientRect();
  const c = chat.getBoundingClientRect();
  const shown = getComputedStyle(rail).display !== 'none';
  const wide = matchMedia('(min-width:40rem)').matches;
  if (shown !== wide) throw Error('rail visibility differs from viewport');
  if (wide && (Math.abs(r.top-m.top)>1 || r.right>m.left+1))
    throw Error('rail is stacked or overlaps feed');
  if (!wide && (Math.abs(c.left-m.left)>1 || Math.abs(c.right-m.right)>1))
    throw Error('narrow feed does not fill chat');
  const errors = []; let textRectCount = 0;
  const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const n = walker.currentNode;
    if (!n.textContent.trim()) continue;
    const range = document.createRange(); range.selectNodeContents(n);
    for (const tr of range.getClientRects()) {
      if (!tr.width || !tr.height) continue;
      textRectCount++;
      for (let a=n.parentElement; a; a=a.parentElement) {
        const cs=getComputedStyle(a), b=a.getBoundingClientRect();
        if (['hidden','clip'].includes(cs.overflowX) &&
            (tr.left<b.left-1 || tr.right>b.right+1)) {
          errors.push(n.textContent.trim().slice(0,45)+' in '+a.className);
          break;
        }
      }
    }
  }
  if (!textRectCount) throw Error('no visible text measured');
  if (errors.length) throw Error('text clipped: '+errors.join(';'));
  if (document.documentElement.scrollWidth>innerWidth) throw Error('document overflow');
  return {width:innerWidth, tracks:getComputedStyle(chat).gridTemplateColumns,
    shown, textRectCount};
};'''
expect('install observer', run('js', observer), True)
for width in [320,360,390,480,639,640,641,768,1024,1440]:
    expect('viewport', run('viewport', str(width)+'x1000'), True)
    expect('baseline', run('js', 'window.reviewLayout()'), True, 'textRectCount')
expect('control viewport', run('viewport', '640x1000'), True)
expect('stack mutation', run('js',
    "document.querySelector('.chat').style.gridTemplateColumns='minmax(0,1fr)';window.reviewLayout()"),
    False, 'rail is stacked or overlaps feed')
expect('stack restored', run('js',
    "document.querySelector('.chat').style.removeProperty('grid-template-columns');window.reviewLayout()"), True)
expect('clip mutation', run('js',
    "document.querySelector('.chat__main').style.width='1000px';window.reviewLayout()"),
    False, 'text clipped:')
expect('clip restored', run('js',
    "document.querySelector('.chat__main').style.removeProperty('width');window.reviewLayout()"), True)
run('stop')
PY
```

## Limits

This is a code and local Chromium review, not a production deployment check. I used the author's local build and did not independently rerun the full site or root suites. The reported suite results belong to the author. I did not establish Safari/Firefox behavior, real-device behavior, text-only zoom, translated content, or layouts below 320px. I did not review unchanged marketing claims or backend behavior. This is the exact-review arm only; the independent cross-family arm is separate.
