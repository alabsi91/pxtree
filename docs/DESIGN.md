# pxtree design

## 1. Purpose

pxtree measures how a webpage actually renders and prints it as compact text for AI coding agents. The agent already has the source, so pxtree never repeats CSS or attributes. It prints the rendered facts the source cannot tell: real pixel sizes and positions (transforms applied, relative to the parent), what paints, what is clipped, covered, off center or truncated, and text contrast. One line per element, indented as a tree, with a findings summary on top. It runs one headless Chromium, does the whole measurement in one `page.evaluate`, and aims for 1-2 s on a normal page after load.

## 2. Interfaces

### 2.1 CLI

```
pxtree <target> [flags]
pxtree guide
pxtree mcp
```

`<target>` is a URL, a `localhost:3000`-style host (gets `http://`), or a file path (becomes `file://`, resolved from cwd).

`pxtree guide` prints the reading guide (section 10.1) to stdout. `pxtree mcp` runs the MCP server (section 10.2). `pxtree --help` lists the flags only and ends with `run: pxtree guide`.

| Flag                                 | Default    | Meaning                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--viewport <WxH[,WxH...]>`          | `1280x800` | One measurement per viewport. `x` or `X`. Width and height must be positive.                                                                                                                                                                                                                                                                       |
| `--scheme <light\|dark\|light,dark>` | `light`    | `prefers-color-scheme`. Both = two measurements per viewport.                                                                                                                                                                                                                                                                                      |
| `--dpr <n>`                          | `1`        | Device pixel ratio.                                                                                                                                                                                                                                                                                                                                |
| `--scroll <y\|x,y\|selector>`        | `0`        | Window scroll before measuring. A selector scrolls that element to the top of the viewport.                                                                                                                                                                                                                                                        |
| `--script <file\|code>`              | none       | Puts the page in a state before measuring. See section 3.                                                                                                                                                                                                                                                                                          |
| `--wait <ms\|selector>`              | none       | After the script: sleep ms, or wait until the selector is visible.                                                                                                                                                                                                                                                                                 |
| `--element <selector>`               | none       | Print only matching elements and their ancestor lines. Pierces open and captured closed shadow roots.                                                                                                                                                                                                                                              |
| `--no-children`                      | off        | With `--element`, drop what is inside the matches.                                                                                                                                                                                                                                                                                                 |
| `--colors`                           | off        | Print hex colors in `[renders]` and `[text]`.                                                                                                                                                                                                                                                                                                      |
| `--summary`                          | off        | Print the facts line, since last run, the summary and the across block. No tree.                                                                                                                                                                                                                                                                   |
| `--changes`                          | off        | Print only the facts line and since last run. Cannot be combined with `--summary` (exit 1).                                                                                                                                                                                                                                                        |
| `--screenshot <path>`                | none       | PNG of the viewport. With `--element` and exactly one rendered match, clipped to that element. Several runs add `-<W>x<H>-<scheme>` before the extension. The facts line of each run ends with `screenshot <path> WxH` (PNG size in device pixels), plus `(viewport, selector matched N)` when `--element` matched more or fewer than one element. |
| `--json`                             | off        | Print the `MeasureResult` JSON instead of text.                                                                                                                                                                                                                                                                                                    |
| `--out <dir>`                        | none       | Write `pxtree.txt` and `pxtree.json` there. Stdout gets only the facts lines, the summaries and the two paths.                                                                                                                                                                                                                                     |
| `--timeout <ms>`                     | `30000`    | Budget for reaching DOMContentLoaded. The `load` event and a quiet network have their own short caps (4.9), then pxtree measures anyway.                                                                                                                                                                                                           |
| `--channel <name>`                   | none       | Use an installed browser (`chrome`, `msedge`) instead of Playwright's Chromium.                                                                                                                                                                                                                                                                    |
| `--no-reveal`                        | off        | Skip the reveal scroll pass (section 4.9).                                                                                                                                                                                                                                                                                                         |
| `--no-diff`                          | off        | Do not read or write the since-last-run cache.                                                                                                                                                                                                                                                                                                     |

Cut on purpose: `--click`, `--hover` (one line of `--script` each), `--no-shadow` (no use case), `--mobile` (see section 4.14), `--depth` (`--element` does the job).

Exit codes:

| Code | Meaning                                                                                                                 |
| ---- | ----------------------------------------------------------------------------------------------------------------------- |
| 0    | Measured. Findings do not change the exit code.                                                                         |
| 1    | Bad usage (unknown flag, bad viewport string, script file missing).                                                     |
| 2    | Could not load the target after one retry, the script threw, or the `--scroll` or `--element` selector matched nothing. |
| 3    | Could not launch the browser.                                                                                           |

Stdout carries the report. Stderr carries errors only. Error lines are single lines:

```
could not load http://localhost:3000: net::ERR_CONNECTION_REFUSED
script failed: TimeoutError: locator.click: Timeout 7500ms exceeded
could not launch chromium, run: npx -y playwright@1.63.0 install chromium
no element matches .card
```

`--element` with no match still prints the report, then writes `no element matches <selector>` to stderr as the last line and exits 2. `--scroll` with no match stops before measuring with `scroll failed: no element matches <selector>`.

The version in the hint is read from pxtree's own `playwright-core` dependency at runtime, so the installed browser revision always matches.

### 2.2 Programmatic API

Exported from `pxtree` (`src/index.ts`):

```ts
export function createSession(options?: SessionOptions): Promise<Session>;
export function measure(target: string, options?: MeasureOptions): Promise<MeasureResult>; // one-shot session
export function format(result: MeasureResult, options?: FormatOptions): string;
export const readingGuideText: string; // section 10.1
export type { SessionOptions, Session, MeasureOptions, MeasureResult, RunResult, FormatOptions } from './types.ts';
```

A `Session` keeps one browser alive. Each `session.measure()` call creates one browser context (it carries the dpr), one page, and runs every viewport and scheme on that page. `measure()` is `createSession` + `measure` + `close`. An MCP server keeps one `Session` for its lifetime. Full types are in section 6.

## 3. State mechanism

Decision: `--script` runs in Node with the Playwright `page`, not inside the page.

1. Real hover, focus, keyboard and trusted clicks only exist through CDP input. In-page `element.click()` cannot produce `:hover`, and many menus ignore untrusted events.
2. Agents already know the Playwright API, and one mechanism covers dialogs, menus, forms, hover and in-page JS (`page.evaluate`).
3. It is one code path for files and inline code, easy to validate and easy to time out.

Contract:

- If the argument is a path to an existing file (`.js`, `.mjs`, `.ts`), pxtree imports it and calls its default export as `await fn(page)`.
- Otherwise the argument is inline code. It becomes the body of `async function (page) { <code> }` built with the `AsyncFunction` constructor.
- `page` is a Playwright `Page`. Its default action timeout is set to `timeout / 4`.
- The script runs once per viewport, after the reveal pass and `--scroll`, before `--wait` and the final settle. Order in section 4.9.
- If the script throws, the run ends with `script failed: <message>` and exit 2.
- The script may scroll. pxtree measures whatever scroll the page has at the end.
- In the API, `script` may also be a function `(page: Page) => Promise<void>`.

Examples:

```
pxtree localhost:5173 --script "await page.click('text=Delete')"
pxtree localhost:5173 --script "await page.hover('nav >> text=Products')" --wait 'ul.mega-menu'
pxtree localhost:5173 --script ./open-cart.mjs --viewport 390x844,1280x800
```

## 4. Measurement model

Everything in this section runs in the page, inside one synchronous `measurePage()` call, except settling (async, before it) and findings (in Node, after it).

### 4.1 Tree source: the flat tree

The walk follows the rendered flat tree, starting at `body`.

- `getFlatChildren(element)` returns: the shadow root's child nodes if the element hosts an open root or a captured closed root; else for a `<slot>` its `assignedNodes()`, or its own child nodes when nothing is assigned; else `element.childNodes`.
- A child element with `display: contents` (this includes default slots) is not a node. Its flat children are promoted into the parent, recursively.
- Text nodes are never nodes. A text node that ends up as a flat child of a node is that node's own text.
- `::before` / `::after` are never nodes. They count as ink of their element (section 4.5).
- Closed shadow roots: the bundle is installed with `context.addInitScript`, which runs before any page script. It wraps `Element.prototype.attachShadow` and stores closed roots in a module-level `WeakMap<Element, ShadowRoot>`. The walk reads that map, so closed roots made by `attachShadow` are measured and tagged `[shadow root closed]`. Declarative closed roots (`<template shadowrootmode="closed">`) cannot be reached. Their host prints as a leaf with no tag, and the limitation is documented in the reading guide.
- Top layer: an element matching `:modal`, `:popover-open` or `:fullscreen` is skipped where it sits in the tree and walked again after the main tree as its own root (`parentIndex -1`). Roots are ordered by document order. Real top-layer order is not exposed by the DOM. This matches paint order in every common case: top-layer elements paint above everything.
- Never walked into, printed as leaves: `svg`, `math`, `img`, `video`, `canvas`, `iframe`, `frame`, `object`, `embed`, `select`, `textarea`, `input`. Skipped entirely: `br`, `wbr`, and anything with no box.
- A shown element with zero width or height, no own text, no ink and no shown children is dropped. It says nothing.
- Node cap: 20000. Past it the walk stops descending, the parent gets `[children skipped N]`, and the facts line says `stopped at 20000 elements`.

### 4.2 Visibility: one function

`getVisibility(element, style, rect, clip, cumulativeOpacity)` is the only place that decides visibility. Every finding reads its result. It is called only for elements where `element.checkVisibility()` is true. When that returns false, the element has no box (display none, closed `<details>` content, inside `content-visibility: hidden`, closed dialog or popover) and is not in the tree.

Checks, first match wins:

| State                  | Condition                                                                                                                                                                                              | Children walked                                                                                                                             | Tag                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `unpainted-opacity`    | own `opacity` is 0                                                                                                                                                                                     | no                                                                                                                                          | `[not painted: opacity 0]` + `[children skipped N]`                    |
| `content-skipped`      | `content-visibility: hidden`, or `auto` and its first element child fails `checkVisibility({ contentVisibilityAuto: true })`                                                                           | no                                                                                                                                          | `[content skipped]`                                                    |
| `sr-only`              | border box at most 1x1; or content box at most 1x1 with overflow not `visible` and no background or border; or `clip` computes to `rect(0px, 0px, 0px, 0px)`; or `clip-path` is `inset(50%)` or larger | no                                                                                                                                          | `[sr-only]`                                                            |
| `clipped-out`          | the clip region (4.4) is set and the visual rect does not intersect it                                                                                                                                 | only when the node clips nothing itself (its children can overflow it into view); a node with no `shown` descendant then prints as one line | `[clipped out by X]`, or the `clipped out by X` finding (4.12) instead |
| `offscreen`            | the rect lies fully in the area scrolling can never reach: `right <= 0` or `bottom <= 0` in document coordinates (for an rtl root: `left >= documentWidth`)                                            | no                                                                                                                                          | `[offscreen]`                                                          |
| `unpainted-visibility` | `visibility` is `hidden` or `collapse`                                                                                                                                                                 | yes (a child can be `visible`)                                                                                                              | `[not painted: visibility hidden]`                                     |
| `shown`                | otherwise                                                                                                                                                                                              | yes                                                                                                                                         | none                                                                   |

A `unpainted-visibility` or walked `clipped-out` node whose subtree has no `shown` node prints as one line with `[children skipped N]`.

Only `shown` nodes take part in findings, coverage and ink. The whole unpainted, sr-only, offscreen and clipped-out subtrees are invisible to every finding, except the `clipped out` finding itself, which is about a `clipped-out` node.

### 4.3 Geometry

- Visual rect: `getBoundingClientRect()` plus `scrollX` / `scrollY`. Every rect in the JSON is in document coordinates, transform-inclusive, as an axis-aligned box. Rounded to 0.01.
- Layout size: `offsetWidth` / `offsetHeight` (the untransformed border box). For non-HTML elements it equals the visual size.
- Own transform: `new DOMMatrixReadOnly(style.transform)` composed with the individual `translate`, `rotate` and `scale` properties (computed forms: `rotate` is `none`, `<angle>` or `<x> <y> <z> <angle>`; `scale` is `none` or 1-3 numbers). Rotation is `atan2(m12, m11)` in degrees. Scale is `hypot(m11, m12)`. Reported when rotation is 0.5 degrees or more, or scale differs from 1 by 0.01 or more. `isInsideTransform` is true when any ancestor rotates or scales. When the transform neither rotates nor scales, its translation (`m41`, `m42` plus the `translate` property, a percentage taken of the layout size) is `translate` once it reaches 0.5 px on an axis.
- Motion facts: `isAnimating` is true when a running animation, an infinite one that settling paused, or a scroll-driven one targets the element itself (animations of its pseudo-elements do not count). `motionRole` is `marquee` or `carousel` when `role` or `aria-roledescription` holds that word.
- Text rects: `Range.getClientRects()` over each own text node. These are also transform-inclusive.
- Position printed (computed in Node by package B): `@x,y` is the offset of the node's visual rect from the parent's content box (parent visual rect minus border and padding). x is measured from the start edge: `parentContentLeft` when the parent is ltr, `parentContentRight - nodeRight` when rtl. Omitted when it is `0,0`.
- Frame: roots in the top layer and `position: fixed` elements whose containing block is the viewport print `@x,y` from the viewport instead, tagged `[fixed]` or `[top layer ...]`. Their descendants use the normal parent rule.
- Sticky: the rect is the current (stuck) position. To know if it is stuck, a batch after the walk sets `position: relative !important` inline on every sticky node, reads all rects, then restores every style. Sticky and relative take the same flow space, so nothing else moves. It costs one layout per sticky element, capped at 20. Stuck when the two tops or starts differ by 0.5 or more. Tag `[stuck]`.
- Direction: a node whose direction differs from its parent's gets `[rtl]` or `[ltr]`. Vertical writing modes are not handled. Positions stay physical there, and the guide says so.

### 4.4 Clip chain

Computed once per node, top-down, during the walk. Each node carries a list of clip entries `{ rect, clipperIndex, depth }` inherited from its parent plus its own.

A node adds a clip entry for its children when:

| Source                                                       | Clip rect                                            |
| ------------------------------------------------------------ | ---------------------------------------------------- |
| `overflow-x` or `overflow-y` not `visible`                   | padding box, only on the axes that are not `visible` |
| `contain` includes `paint` (also `strict`, `content`)        | padding box                                          |
| `clip-path` not `none`                                       | border box (approximation: shapes are not parsed)    |
| `clip` on an absolute element                                | the parsed rect                                      |
| `position: fixed` root with the viewport as containing block | the viewport rect at the current scroll              |

Rules:

- `overflow` on `html` / `body` propagates to the viewport. It adds a clip only on the x axis (clipper: the viewport, rect `0..viewportWidth`). On the y axis it only sets the `scroll locked` fact.
- Escaping (the CSS rule): an overflow clip applies to an absolute or fixed node only when the clipper is the node's containing block or an ancestor of it. A clipper between the node and its containing block does not clip it. So an absolute or fixed node takes exactly the child clip entries of its containing block. With no containing block, an absolute node keeps only the viewport entry and a fixed node gets the viewport rect. Containing block for absolute: nearest ancestor with `position` not `static`, or with `transform`, `translate`, `rotate`, `scale`, `perspective`, `filter`, `backdrop-filter`, `contain` paint/layout/strict/content, `container-type` not `normal`, or `will-change` naming one of those or `position`. For fixed: the same list minus the two `position` tests. A dropdown inside `li { position: relative }` under a `header { overflow: hidden }` is clipped by the header.
- A top-layer root starts with only the viewport clip.
- The effective clip of a node is the intersection of its kept entries. The JSON keeps the intersected rect and, per axis, the index of the clipper that cuts the most off the node on that axis (the innermost clipper on that axis when none cuts). Clippers that cut the same amount within 0.5 px go to the innermost one: nothing outside it can bring back what it cuts. A dialog's own `overflow: auto` around a form with `overflow: hidden` of the same size must name the form, or the cut reads as "scrolled out". The index is `null` when that clipper is the viewport (root x clip, fixed nodes, top-layer roots) or nothing clips that axis. Findings print it as `by viewport`.
- A clipper with `overflow` `auto` or `scroll` on an axis is a scroll container on that axis. Being outside it is "scrolled out", never a finding.

### 4.5 Ink

What a shown node draws itself:

| Ink        | Condition                                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| background | `background-color` alpha above 0, or `background-image` not `none`                                                                                      |
| border     | per side: width above 0, style not `none`/`hidden`, color alpha above 0                                                                                 |
| shadow     | `box-shadow` not `none`                                                                                                                                 |
| outline    | `outline-style` not `none` and width above 0                                                                                                            |
| image      | replaced: `img`, `svg`, `video`, `canvas`, `iframe`, `object`, `embed`, `math`                                                                          |
| control    | `input` (not hidden), `select`, `textarea`, `button`, `progress`, `meter`                                                                               |
| text       | own text rects                                                                                                                                          |
| pseudo     | `::before` or `::after` whose `content` is not `none`/`normal` and that has text content, background or border. Recorded as `before`, `after` or `both` |

Pseudo-element geometry is not exposed by any DOM API. Pseudo ink is placed on the element's border box. This is the one approximation in the ink model.

Ink test at a point, used by coverage: inside the border box when the node paints a background, image, control or pseudo; inside a border strip when it paints only borders; inside one of its own text rects for text. Border radius is ignored.

### 4.6 Colors and contrast

- Every computed color string (it may be `oklch()`, `color(display-p3 ...)`, `rgb()`) is normalized by filling a 1x1 `OffscreenCanvas` (`willReadFrequently`) and reading the sRGB bytes. Results are cached per string. Verified: `oklch(0.7 0.1 200)` reads back as `[64, 177, 183, 255]`.
- Background behind text, first choice (paint truth): the `elementsFromPoint` stack at the center of the text ink (taken during coverage sampling, 4.7). Walk the layers below the text node, compositing each layer's background color times its cumulative opacity, until alpha reaches 1. A layer with `background-image`, or a replaced element, makes the result `null` (image behind).
- Fallback (text outside the viewport, or not hit): the same compositing up the flat ancestor chain.
- Base color when nothing opaque is found: the computed background of a probe element with `background: Canvas`. It follows the page's `color-scheme`.
- Text color printed and used = `color` alpha times the node's cumulative opacity, blended over that background. The hex is what the browser drew.
- Contrast (computed in Node): WCAG 2.x relative luminance ratio of two opaque hex colors, one decimal.

### 4.7 Paint order and coverage

Decision: ask the browser. `document.elementsFromPoint` returns the real paint-ordered stack at a point, with stacking contexts, z-index, negative z-index, fixed, sticky and top layer already resolved. Computing stacking order ourselves would re-implement the painter and drift from it.

Measured on chromium-1243 with 6000 elements: 20000 calls take 190 ms (about 10 microseconds each). `elementFromPoint` is not enough, because we need the layers under the top one.

Method, one grid over the viewport rather than per element:

1. Before sampling, insert `*, *::before, *::after { pointer-events: auto !important }` into the document and into every walked shadow root (`adoptedStyleSheets`). Sample. Remove it. All in the same synchronous task, so no frame renders with it. Without this, `pointer-events: none` elements would be invisible to hit testing.
2. Grid step `s = max(4, ceil(sqrt(viewportWidth * viewportHeight / 15000)))`: 9 px at 1280x800, 5 px at 390x844. That is about 12000-13000 points.
3. At each point take `document.elementsFromPoint(x, y)`. For every element in that stack that hosts a walked shadow root, splice in `shadowRoot.elementsFromPoint(x, y)` entries that are inside that root, just above the host. Map each element to its node index through a `Map<Element, number>` built during the walk, climbing to the nearest walked ancestor for elements that are not nodes.
4. Candidates are shown nodes that are text (own text) or controls, in the viewport, not inert. For a candidate `E` at point `p` where `E` has ink at `p` (text: inside a text rect; control: inside its content box, so icons in the padding do not count): the coverer is the first node above `E` in the stack that is not `E` or a descendant of `E` (checked in O(1) with preorder `index` / `subtreeEnd`), has ink at `p`, and is not the `label` of that control. Ancestors do count: an ancestor that paints above `E` means `E` has a negative z-index under a painted parent, which is a real bug.
5. Top-up: every candidate with fewer than 3 grid points on its ink gets 5 extra points (center and 4 points at 25%/75%). Capped at 6000 extra points.
6. Record per candidate: `sampleCount`, `coveredSampleCount`, and per coverer `{ index, sampleCount, isTranslucent }`. At each covered sample, the fills of the stack layers from the coverer down to just above the candidate are stacked (a background image, replaced element or control counts as opaque, each times its cumulative opacity). The sample is opaque when they reach 0.9 alpha. The coverer is translucent when fewer than half of its samples are opaque. This judges what is behind the coverer's ink: a link's text on an opaque header is not translucent even though the link has no background.

Hard cap: 21000 points in total. When hit, the JSON sets `sampling.isCapped` and the facts line says `coverage sampled partly`. Expected cost: 130-600 ms depending on stack depth.

Scope: coverage only exists inside the viewport. That is also the only place the user sees it. Below the fold nothing is "covered". The agent scrolls with `--scroll` to check another region.

Top layer and inert content:

- Chromium skips inert elements in hit testing (verified: content behind a modal returns an empty stack). When a `:modal` dialog or `:fullscreen` element is open, everything outside it is inert. Those nodes get no coverage, the facts line says `modal dialog#id`, and the formatter collapses the main tree to one line (section 5).
- `inert` attribute subtrees: no coverage, no tag.

The covered amount is geometric, not sampled: Node intersects the candidate's visible rect with the coverer's visible rect. When the overlap spans the full width (or height) and touches one edge, it prints as `top 24` / `bottom 8` / `start 12` / `end 12`. Otherwise as a percentage of the candidate's visible area.

### 4.8 Text

For a node with own text:

- `fontSize`, `lineHeight` in px (`normal` becomes the height of the first text rect), `fontWeight`.
- `lineCount`: lines over `Range.selectNodeContents(element).getClientRects()`, counting only rects that reach inside the node's own clip (so a line-clamped paragraph counts its visible lines). Rects are taken top-down, and a rect whose vertical middle is above the current line's bottom joins that line. This includes inline children, so a paragraph with links counts its real lines, and a checkbox beside its label text stays on the text's line.
- `inkRect`: union of own text rects.
- `capTop` and `baseline` of the first line, in document y: `baseline = firstTextRect.top + fontBoundingBoxAscent`, `capTop = baseline - actualBoundingBoxAscent('H')`. Metrics come from a 2D canvas `measureText` with the node's computed `font`, cached per font string.
- `truncation`: `ellipsis` when `text-overflow: ellipsis` and `scrollWidth > clientWidth + 1`; `clamp` when `-webkit-line-clamp` is not `none` and `scrollHeight > clientHeight + 1`; `cut` when the node's own overflow is not visible and its text overflows it by more than 1 px. `hiddenPx` is the overflow amount.
- `color`, `background` (hex or `null`), from 4.6. `isLarge`: size at least 24 px, or at least 18.66 px with weight 700 or more.
- Inputs and textareas: own text is the value, or the placeholder when the value is empty.

Failed web fonts: `[...document.fonts].filter(font => font.status === 'error')` family names go on the facts line as `font failed: Inter`.

### 4.9 Settling and state order

Per viewport (Node drives, in-page helpers do the work):

1. `page.setViewportSize`, `page.emulateMedia({ colorScheme })` for the first scheme, `page.goto(url, { waitUntil: 'domcontentloaded', timeout })`. On error, retry once, then fail with exit 2. Then `page.waitForLoadState('load', { timeout: 2000 })`, timeout swallowed. A page whose `load` never fires (a slow asset, a long-lived request) is measured instead of reloaded.
2. `page.waitForLoadState('networkidle', { timeout: 1500 })`, timeout swallowed. Most modern sites never go quiet (analytics, long polling), so this cap is short. Then `document.fonts.ready`. A page that needs longer uses `--wait`.
3. `settlePage()`.
4. Reveal pass (skipped with `--no-reveal`, when scroll is locked, or when the page is not taller than the viewport): scroll the window by one viewport height at a time with `behavior: 'instant'`, waiting two animation frames per step, up to the page height measured at the start (infinite feeds do not run away), at most 30 steps. Then back to 0 and wait for pending images (`img` not `complete`), up to 2000 ms. This fires IntersectionObserver reveal and lazy-load patterns once, the way a user scrolling down would. Two frames per step because IntersectionObserver runs after `requestAnimationFrame` callbacks in the same frame. Cost: about 33 ms per screen.
5. `--scroll`: `scrollTo({ left, top, behavior: 'instant' })` or `element.scrollIntoView({ block: 'start', behavior: 'instant' })`. `instant` overrides `scroll-behavior: smooth`.
6. `--script`, then `--wait`.
7. `settlePage()`.
8. Measure. Screenshot if asked.
9. For each further scheme: `page.emulateMedia({ colorScheme })`, `settlePage()`, measure, screenshot. No reload: `prefers-color-scheme` is live.

A new viewport reloads the page (step 1), because pages read their width at load time. The context and the page are reused.

`settlePage({ maxWaitMs: 1000 })`, in-page:

- Collect animations from `document.getAnimations()` and `shadowRoot.getAnimations()` for every known shadow root, deduplicated.
- For each: if `animation.timeline instanceof DocumentTimeline` it is time-based. Finite iterations: `finish()`. Infinite: `pause()` and `currentTime = 0`, so repeated runs match and the diff stays quiet. Each call in try/catch. Any other timeline (`ScrollTimeline`, `ViewTimeline`, verified present on chromium-1243) is left alone, so it stays where the scroll put it.
- Wait two animation frames.
- Stability loop: signature = rounded rects of the first 3000 elements in document order. Take one per frame, re-finishing new animations each time, until two frames match or `maxWaitMs` passes. When it never stabilizes, the element whose rect changed the most is reported as `still moving <name>` on the facts line. This catches JS-driven animation and late layout.

Accepted limitation: IntersectionObserver with a nested scroll container as its root is not swept. Reveal patterns that reverse when scrolled away (not one-shot) show their state at the final scroll, which is what the user sees there.

### 4.10 Scroll containers

A node with `overflow` `auto` or `scroll` on an axis where content exceeds the box gets:

`[scroll y 568 in 300 at 120, 15 of 25 out]`

per axis: content size (`scrollHeight`), visible size (`clientHeight`), current offset when above 0; then the number of shown children with no part inside the scrollport, out of all shown children. Nested scroll boxes are measured at their current offset. Scrollbars take 0 px: Playwright runs headless Chromium with hidden scrollbars (verified: `offsetWidth - clientWidth` is 0 on a scrolling box), so the guide says pxtree measures like an overlay-scrollbar device.

`[over 100000 px]` marks a node over 100000 px on one axis.

### 4.11 Names

Built in-page, returned as `name`:

- `tag`, lowercase (custom elements keep their full tag).
- `#id` unless the id contains a character outside `[A-Za-z0-9_-]` or a run of 3 or more digits (React `:r1:`, `«r1»`, generated ids).
- Up to two classes. Drop classes with a character outside `[A-Za-z0-9_-]` (utility variants like `md:flex`, `w-[20px]`, `w-1/2`). Strip a generated suffix: the last segment after `_`, `__` or `-` when it is 5-10 chars with both a digit and a letter (`button_primary__a1B2c` → `button_primary`). Drop a class that is only a hash (`css-1x2y3z`, `sc-bdVaJa`, `svelte-xyz123`: prefix plus a segment containing a digit). From what is left, pick the two with the lowest page-wide frequency, print them in source order. Frequencies are counted once per walk. This drops utility classes (`flex` on 400 elements) without a list, and keeps `card` on a card.
- Each class is cut to 24 chars with `…`.
- Own text: whitespace collapsed, the first 4 words or 24 chars, whichever is shorter, `…` when cut. Printed in double quotes after the name.
- Nothing identifying: the bare tag. The tree position identifies it.

### 4.12 Findings

Computed in Node from the JSON (package B), so they are pure functions tested without a browser. Only `shown` nodes, except `clipped out`. A finding prints inside `[!! ...]` at the end of its line, several joined with `; `.

"Said once down a branch" means: when an ancestor already carries the same finding kind with the same clipper, coverer or side, descendants do not repeat it. "Where it begins" means: reported on a node whose parent does not have the same condition, and also on a node whose own box (for `past viewport`: box or text ink) extends past its parent's box on that side by 1 px or more. A box that grew around wide content is itself the deepest box that overflows. It carries the finding, and the content inside it says nothing because it does not extend past that box.

Sibling groups: the tops-across-siblings, wider and gaps rules compare siblings of one group. A sibling's group is its tag plus the classes of its name that at least half of its same-tag siblings in that parent carry. A class that fewer than half of them carry (`active`, `new`, `featured`) does not split the group. This is a count, not a guess. Finding texts name the group (`12 wider than li.plan`), and the summary still lists the node by its own name (`li.plan.featured`).

| Finding              | Printed                                                                                                                                                                                                      | Trigger                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Threshold                                                                                                                                                                                 | Suppressed when                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| clipped              | `clipped right 12 by div.panel`, `clipped bottom 8 by viewport`                                                                                                                                              | text or control whose visual rect extends past a non-scrolling clip (hidden, clip, paint containment, clip-path, root x clip, viewport of a fixed or top-layer node) on a side. The clipper is the one recorded for that side's axis (4.4)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 1 px                                                                                                                                                                                      | clipper scrolls on that axis; said once down a branch                                                                                                                                                                                                                                                                                                                             |
| clipped out          | `clipped out by form.modal-body` (kind `clipped`, summary groups it per clipper: `clipped out by form.modal-body ×3`)                                                                                        | `clipped-out` node (4.2, so the clip that cuts it does not scroll) that has own text, is a control, or has children that were not walked (they may hold text or controls), and whose parent is `shown` or `clipped-out`. Its line prints the finding instead of the `[clipped out by X]` tag                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | fully outside                                                                                                                                                                             | none                                                                                                                                                                                                                                                                                                                                                                              |
| overflows            | `overflows parent end 14`, `overflows parent start and end 24`                                                                                                                                               | in-flow (not absolute, not fixed) node whose visual rect extends past the parent's border box on a side, not clipped there. Two opposite sides that overhang by the same amount within 1 px print as one finding. Its own box overflows its parent, so it is always where it begins, even when the parent overflows too                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 1 px                                                                                                                                                                                      | parent is a scroll container on that axis; `past viewport` on the same side; top and bottom when the node or its parent is an inline box (`display: inline`, not replaced, not a control: it is as tall as its font, and `vertical-align` moves it off the line)                                                                                                                  |
| text overflows       | `text overflows end 30`                                                                                                                                                                                      | own text ink extends past the node's own border box and the node does not clip                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 1 px                                                                                                                                                                                      | truncation already reported                                                                                                                                                                                                                                                                                                                                                       |
| past viewport        | `past viewport end 14`                                                                                                                                                                                       | visual rect or visible own text ink extends past the layout viewport's inline end (`documentElement.clientWidth`, rtl: its start), not clipped, not inside a horizontal scroll container                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 1 px                                                                                                                                                                                      | where it begins only (a node that extends past its own parent's inline end also begins it)                                                                                                                                                                                                                                                                                        |
| covered              | `covered top 24 by header.site`, `covered 40% by div.toast (translucent)`                                                                                                                                    | coverage sampling (4.7) found a coverer on a text or control candidate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 1 sample and 1 px of overlap; controls need 10% of samples                                                                                                                                | coverer is an ancestor with pseudo ink (hit testing reports its `::before`/`::after` as the ancestor, and pseudo geometry is unknown); coverer is a descendant of another coverer of the same node (the header covers the heading, its links add nothing); said once down a branch for the same coverer                                                                           |
| overlaps             | on the later sibling in tree order: `overlaps div.badge 12x40` (size of the intersection; summary text `overlaps div.badge {n}`, amount is the smaller side)                                                 | two shown children of the same parent, each in-flow or absolute (never fixed, floated or `isInline`), each painting box ink (background, border or replaced element), whose visual rects intersect and neither contains the other                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 2 px on both axes                                                                                                                                                                         | a `covered` finding already links the pair (its node is one member or inside it, its coverer is the other or inside it); parent or ancestor rotated or scaled                                                                                                                                                                                                                     |
| off center           | `off center 3 down`, `off center 2 end` (`up`/`down` on the block axis, `start`/`end` on the inline axis)                                                                                                    | parent paints ink or is a control; its padding is symmetric on that axis; the union of the border boxes of its shown in-flow children and its text runs has free space `before` and `after` inside the content box (padding is symmetric, so it would only inflate both sides and loosen the upper bound); `d = before - after`. The eye sees ink, not margins: a child pushed down by its own margin is off center by that margin, and a card whose `h3` and `p` keep default margins prints `off center 4 down`                                                                                                                                                                                                                                                                              | `2 <= abs(d) <= 0.5 * (before + after)`                                                                                                                                                   | parent or ancestor rotated or scaled; parent is a scroll container; children overflow the parent; parent has pseudo ink (its pseudo boxes take space that is not measured)                                                                                                                                                                                                        |
| text off center      | `text off center 3 down`                                                                                                                                                                                     | node paints ink or is a control, has symmetric block padding, and holds one line of own text and no child boxes; compares `above = capTop - paddingBoxTop` with `below = paddingBoxBottom - baseline`; `d = above - below`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `3 <= abs(d) <= 0.5 * (above + below)`. Below 3 px the font's ascent and descent split alone makes it fire on every padded label; the upper bound skips one line at the top of a tall box | inside rotate or scale                                                                                                                                                                                                                                                                                                                                                            |
| tops across siblings | on the row parent: `div.stat tops 0..6 across siblings` (the members themselves, tops in the parent's content box) and `a.button tops 312..328 across siblings` (a descendant, tops relative to each member) | 2+ siblings of one sibling group side by side: tops within 1 px, or starting above the bottom of the row's first member. Members: their tops, vertical centers and bottoms all spread, so they share no top, center or bottom line. Descendants: each member has a shown descendant at the same relative path, and the same three lines all spread. A path step is the tag and its position among same-tag siblings (`ul[0]>li[2]`, `a[0]`), not the name, so a `.button-primary` in the middle card pairs with the `.button-secondary` in the others. A member line prints the group name, a descendant line the first member's descendant name. At most one member line and one descendant line per row, for the first such descendant in tree order: later descendants usually move with it | 2 px                                                                                                                                                                                      | groups over 50 siblings are checked on the first 50                                                                                                                                                                                                                                                                                                                               |
| wider                | `12 wider than li.card` (the group name)                                                                                                                                                                     | 3+ siblings of one sibling group in one row; a width shared by at least half of them; this one differs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 2 px                                                                                                                                                                                      | inside rotate or scale                                                                                                                                                                                                                                                                                                                                                            |
| gaps                 | on the parent: `gaps 16 16 24 16 between li.step` (the group name)                                                                                                                                           | 3+ gaps between a run of siblings of one sibling group along one axis; a gap differs from the most common gap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 2 px                                                                                                                                                                                      | none                                                                                                                                                                                                                                                                                                                                                                              |
| text truncated       | `text truncated ellipsis 40`, `text clamped 3 lines`, `text cut 40`                                                                                                                                          | `truncation` from 4.8                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 1 px                                                                                                                                                                                      | none                                                                                                                                                                                                                                                                                                                                                                              |
| contrast             | `contrast 2.8`                                                                                                                                                                                               | text with a known background, ratio below 4.5 (below 3 for large text)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | ratio                                                                                                                                                                                     | background unknown (prints `on image` in `[text]`); `:disabled` controls                                                                                                                                                                                                                                                                                                          |
| small target         | `small target 20x20` (summary text `small target {n}`, amount is the smaller side)                                                                                                                           | interactive node (`a[href]`, `button`, `input` not hidden, `select`, `textarea`, `summary`, role `button`/`link`/`checkbox`/`radio`/`switch`/`tab`/`menuitem`) with a visual box under 24 px on either axis                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 24 px (WCAG 2.5.8)                                                                                                                                                                        | a link inside a line of text with sibling text; a control whose label (wrapping it, or naming it with `for`, `labelIndex`) is shown and at least 24 px on both axes; spacing (WCAG 2.5.8 exception): a 24 px circle on the target's center touches no other target's rect and no other undersized target's circle (centers 24 px or more apart). Nested targets are not neighbors |
| image not loaded     | `image not loaded`                                                                                                                                                                                           | `img` with a `src`, `complete`, `naturalWidth === 0`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | none                                                                                                                                                                                      | none                                                                                                                                                                                                                                                                                                                                                                              |
| image aspect         | `image aspect 1.30 of natural`                                                                                                                                                                               | `img` or `video` with `object-fit: fill`; rendered aspect ratio over natural aspect ratio                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 2%                                                                                                                                                                                        | natural size unknown; spacer image (natural size at most 2x2)                                                                                                                                                                                                                                                                                                                     |
| image upscaled       | `image upscaled 2.1`                                                                                                                                                                                         | raster `img`; rendered width times dpr over natural width                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 1.25                                                                                                                                                                                      | svg sources (`.svg`, `data:image/svg`); spacer image (natural size at most 2x2)                                                                                                                                                                                                                                                                                                   |
| scroll range         | `scroll range y 3`                                                                                                                                                                                           | scroll container whose content exceeds the box on an axis by a small amount                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 1-8 px                                                                                                                                                                                    | none                                                                                                                                                                                                                                                                                                                                                                              |

Page facts (first line, not per node): `sideways N by X` (document scrolls sideways; X is the node with the widest `past viewport` finding, omitted when there is none), `scroll locked`, `modal X`, `still moving X`, `font failed F`, `status N`, `screenshot <path> WxH`.

Findings are measurements with a threshold, never verdicts. Every printed text says what was drawn and by how much (`covered 40% by X`), never a judgement word such as "wrong", "broken", "misaligned" or "should". The agent judges intent from the code. A suppression rule only removes a measurement that does not mean anything (an axis-aligned box inside a rotation, content a scroll container can reach, pseudo-element geometry that no API exposes), repeats a finding already printed, or follows a WCAG exception. It never guesses what the author meant: full-bleed sections, avatar stacks, open popovers and collapsed panels print their measurements like anything else. Deliberate clipping (marquees, carousels, zoomed images) is not guessed at and not suppressed. Its context prints as facts instead: `[clips 5 of 8 children]` on the clipper, `[translated x -320]` and `[animating]` on a track, `[role carousel]` or `[role marquee]` from the markup. Scroll containers produce no clipping findings, because their content is reachable.

Cut from the owner's list, one line each:

- `empty painted box`: fires on skeletons, dividers and decorative blocks.
- contrast of non-text boxes: design-dependent, noisy.
- `[stacked]`: an avatar stack prints its `overlaps` findings, which say the same.
- `overlaps` in the owner's form (ink based, any pair): replaced by the bounded sibling rule above, which stays linear.
- `[line: N inline children]`: `[gaps across]` says it.
- `[pos]` words (`fills`, `centered`, `top 14`): replaced by exact `@x,y` plus the centering findings.
- `hides 45 more elements`: the summary counts do this.
- `110 free after, none in sibling` and `free at end on every row`: weak signals. Free space is printed in `[gaps]`.
- `[shadow]` on every shadow line: the host tag is enough.
- `bar` in `[scroll]`: always 0 in headless Chromium.
- `div:nth-child(4)`: the tree position already identifies a bare tag.
- "code editors summarized once": similar-sibling folding and `[over 100000 px]` handle it without special-casing editors.

### 4.13 Folding repeated output (formatter)

- Wrapper chain: a node with exactly one printed child, no ink, no tags, no findings, and the same rect as the child (within 0.5 px) prints on the child's line as `div.a › div.b › a.link`. More than three names print as first `› … ›` last.
- Identical siblings: consecutive siblings with the same name, size, tags and recursive child signature (names, sizes, tags), and no findings anywhere inside, print once with ` ×N` at the end of the line.
- Similar siblings: a run of 3+ consecutive same-name siblings without findings. The first prints in full. Then one line at the same indent: `…×28 similar li.item 300x120..300x180`. Siblings with findings in the run always print. Folding compares full names, not sibling groups (4.12): siblings whose classes are all different (`section.hero`, `section.pricing`) form one group by tag, and folding them would hide which section is which.
- A node with findings, and its ancestor lines, are never folded away.

### 4.14 Known limits (go in the reading guide)

- Coverage exists only inside the viewport.
- Declarative closed shadow roots are opaque.
- iframes are not walked: `[frame not walked]`. Measure the frame URL on its own.
- Pseudo-element ink is placed on the element's box.
- Clip paths are treated as their border box. Border radius is ignored.
- Desktop emulation only: `(hover: hover)` and `(pointer: fine)` match. No touch emulation.
- Vertical writing modes print physical positions.
- Loading waits at most 2 s for `load` and 1.5 s for a quiet network (4.9). Slower pages need `--wait`.
- Inside a rotated or scaled box there are no overlap, centering or width findings: axis-aligned boxes do not say where rotated content is.
- Contrast is not measured over images or gradients (`on image`).

### 4.15 Since last run

- Cache directory: `$XDG_CACHE_HOME/pxtree`, else `~/.cache/pxtree`. Never inside the user's repo.
- Key: sha1 of JSON `[url, width, height, scheme, dpr, scroll, script text or file content, wait]`. One file per key: `<sha1>.json` holding a `Snapshot`. Overwritten after every run.
- `Snapshot`: per node path, `{ width, height, x, y, tags, findings }` with printed (rounded) values.
- Node path: names from `body`, joined with `>`, each with `[n]` (0-based) when the parent has 2+ children with that name. Top-layer roots start their own path.
- Diff rules: a path only in the old snapshot is gone, only in the new one is new. A path in both is changed when width, height, x or y differ by 1 px or more, the tag strings differ, or the finding strings differ. A new or gone node hides its descendants from the diff.
- Order: document order. Snapshot keys keep the walk's preorder. A gone path follows the path that came before it in the old snapshot.
- Pure moves: a changed node whose size, tags and findings are the same and whose `@x,y` changed is a pure move. Two or more pure moves with the same delta print as one line at the first one's place: `~ 5 boxes from body>main>section.pricing down moved 44 down` (`up`, `end`, `start` for the other directions, both axes when both moved). Positions are relative to the parent, so when a heading grows, only the boxes after it and after its ancestors move, and they collapse into this line. The counts on the header line still count every changed node.
- Findings: a node that only lost findings prints `findings gone: text overflows end 166; past viewport end 150`. New findings print as `[!! …] was …` as before.
- Up to 20 lines, then `… N more`.

## 5. Output format

### 5.1 Grammar

```
report     = run-block { run-block } [ across-block ]
run-block  = facts NL [ diff NL ] summary NL ( tree | same-tree )  ; diff is omitted when the cache is off (--no-diff)
                                                                ; --summary ends the block after summary, --changes after diff (and drops the across block)
facts      = W "x" H SP scheme SP "dpr" SP n SP direction SP "scroll" SP y "/" maxY
             SP "page" SP W "x" H SP "painted to" SP y { SP fact }
direction  = "ltr" | "rtl (start is right)"
fact       = "status" SP code            ; only when not 2xx
           | "sideways" SP n [ SP "by" SP short-name ]
           | "scroll locked"
           | "modal" SP name             ; also for :fullscreen
           | "still moving" SP name
           | "font failed" SP family
           | "coverage sampled partly"
           | "stopped at 20000 elements"
           | "screenshot" SP path SP W "x" H [ SP "(viewport, selector matched" SP n ")" ]   ; always last; the part in parentheses when --element matched more or fewer than one element
diff       = "since last run: first run" | "since last run: no changes"
           | "since last run:" SP counts { NL "  " ( ( "~" | "+" | "-" ) SP path SP what | "~" SP n SP "boxes from" SP path SP "down moved" SP move ) }
move       = n SP ( "down" | "up" ) [ SP n SP ( "end" | "start" ) ] | n SP ( "end" | "start" )
summary    = "summary: no findings"
           | "summary:" SP count-text { NL "  " summary-text [ SP "×" count ] [ "," SP "text" SP hex ] ":" SP short-name { "," SP short-name } [ SP "+" n ] }
short-name = [ name SP ] name          ; the ancestor in front only for a context-free name, see below
same-tree  = "tree: same as" SP scheme [ "," SP "differences:" { NL "  " line-without-indent } ]
count-text = "1 finding" | n SP "findings"      ; n is 2 or more
                                                ; "×" count only when count is 2 or more
summary-text = Finding.summaryText with "{n}" replaced by the amount range ("12" or "12..18")
tree       = line { NL line }
line       = indent name [ SP quoted-text ] SP W "x" H [ SP "@" x "," y ] [ SP brackets ] [ SP "×" n ]
brackets   = { "[" tag "]" } [ "[!!" SP finding { ";" SP finding } "]" ]   ; at least one group, written with no space between groups
indent     = two spaces per depth
across     = "across runs:" { NL "  " labels SP "only:" SP short-name SP finding [ SP "×" n ] } [ NL "  all runs:" SP count-text SP "shared" ]
```

Finding names: every finding text is plain lowercase words separated by spaces, with no hyphens and no colon, followed or preceded by its amounts and element names (`off center 3 down`, `a.button tops 312..328 across siblings`, `12 wider than li.card`). The words say what was measured, never a judgement. `Finding.kind` in the JSON is the same name in kebab case (`off-center`, `tops-across-siblings`, `image-not-loaded`).

Numbers are integer px (rounded half away from zero), except ratios (one decimal: contrast, distortion, upscale), angles (integer degrees) and scale (two decimals). Summary lines group findings by `summaryText` (contrast: by `summaryText` plus `textColor`), in order of first appearance in the tree. Each line shows the amount range, the count, at most three names, then `+N` when there are more: `clipped right 12..18 by li.plan ×4: span.a, span.b, a.more +1`, `contrast 2.6..2.8 ×2, text #9ca3af: p.meta, span.date`.

Summary names: a name is context-free when it has no id and every class in it is a utility class, one that 10 or more node names on the page carry (a bare tag has no classes, so it is context-free too). A context-free name gets the name of its nearest ancestor that has an id or a class and whose name occurs once on the page in front: `contrast 2.1 ×3, text #4a4f58: div.footer-legal li`. With no such ancestor it prints alone. The `sideways … by` fact and the across block use the same short name.

Run-block order: facts, since last run, summary, tree. With the cache off (`--no-diff`, `cacheDirectory: null`) there is no since-last-run line at all. Between run blocks there is one blank line.

Runs that differ only in scheme: a run whose viewport and scroll equal an earlier run's, with a different scheme, compares its tree with that run's. The trees match when both have the same nodes and every node has the same parent, name, text, size, `@x,y` and tags printed without colors (findings are left out). When they match, the tree is replaced by `tree: same as light, differences:` and one line per node whose finding texts differ, printed as a tree line without its indent, with this run's findings (`tree: same as light` alone when none differ). Otherwise the tree prints in full. Light and dark usually differ only in contrast, and this saves the whole second tree.

The across block only appears with more than one run, and only when at least one finding is in some runs but not all. Its lines use the short summary name, and identical lines fold into one with `×N`. The `all runs: N findings shared` line is left out when N is 0. Run labels are `390x844`, or `390x844 dark` when schemes differ.

Tag order on a line: frame (`fixed`, `stuck`, `top layer modal|popover|fullscreen`), `rtl`/`ltr`, transform, `translated`, `animating`, `role`, visibility state, `scroll`, `clips`, `pad`, `gaps`, `text`, `renders`, `shadow root` / `shadow root closed` / `slotted`, `over 100000 px`, `frame not walked`, `children skipped N`, then findings.

Tags:

| Tag                                                                      | Meaning                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[fixed]`                                                                | `@x,y` is from the viewport                                                                                                                                                                                                                                                                                                                                       |
| `[stuck]`                                                                | sticky, currently moved from its flow position                                                                                                                                                                                                                                                                                                                    |
| `[top layer modal]`                                                      | top-layer root, `@x,y` from the viewport                                                                                                                                                                                                                                                                                                                          |
| `[rotated 30° from 100x20]` / `[scaled 1.50 from 100x20]`                | visual size is the upright bounding box; `from` is the layout size                                                                                                                                                                                                                                                                                                |
| `[translated x -320]` / `[translated y 40]` / `[translated x -320 y 40]` | `translate` (4.3): the own transform only moves the node, by these px                                                                                                                                                                                                                                                                                             |
| `[animating]`                                                            | `isAnimating` (4.3)                                                                                                                                                                                                                                                                                                                                               |
| `[role carousel]` / `[role marquee]`                                     | `motionRole` (4.3)                                                                                                                                                                                                                                                                                                                                                |
| `[clips 5 of 8 children]`                                                | a node whose `overflow` or other clip does not scroll on an axis: 5 of its 8 direct children are `clipped-out` by it, or `shown`, clipped by it (their clip lies inside its padding box on that axis, so a child that escapes to an outer containing block does not count) and past its padding box by 1 px or more on a clipping axis. Only when at least one is |
| `[pad 16 8]`                                                             | padding in shorthand order, only when not all zero                                                                                                                                                                                                                                                                                                                |
| `[gaps 24]` / `[gaps across 16]` / `[gaps 24 across 16]`                 | distances between in-flow children and text runs: stacked, side by side, rows and columns; `, free 110 at end` / `at start` when 1 px or more. Several values listed when they differ (up to 6, then `…`). Never on a text flow: a node with own text whose in-flow children are all inline-level (a paragraph with links)                                        |
| `[text 16/24, 2 lines]`                                                  | font size / line height px; `, on image` when the background is unknown; with `--colors`: `, #e6edf3 on #1e2530`                                                                                                                                                                                                                                                  |
| `[renders background, border-bottom, shadow]`                            | what it paints; `image` for replaced, `control` for form controls, `::before` / `::after` for pseudo ink; with `--colors` each color follows its part: `background #1e2530, border #3a4250`                                                                                                                                                                       |
| `[shadow root]` / `[shadow root closed]` / `[slotted]`                   | host of a walked shadow tree; light-DOM child drawn through a slot                                                                                                                                                                                                                                                                                                |
| `[over 100000 px]`                                                       | the visual rect is over 100000 px on one axis                                                                                                                                                                                                                                                                                                                     |
| `[behind modal, 214 elements not printed]`                               | on `body` when a modal or fullscreen element is open                                                                                                                                                                                                                                                                                                              |

### 5.2 Example: simple page

`npx pxtree localhost:5173 --scroll '#pricing'`

```
1280x800 light dpr 1 ltr scroll 536/1450 page 1280x2250 painted to 2210
since last run: 1 changed
  ~ body>main>section#pricing>ul.plans>li.plan[0]>span.plan-note 275x20 was 261x20
summary: 3 findings
  clipped right 14 by li.plan: span.plan-note
  covered top 24 by header.site: h2.section-title
  contrast 2.8, text #9ca3af: p.meta
body 1280x2250
  header.site 1280x64 [fixed][pad 12 24][gaps across 48, free 604 at end][renders background, border-bottom]
    a.logo "Acme" 88x40 [text 20/40]
    nav 492x40 @136,0 [gaps across 32]
      a "Features" 66x40 [text 15/40]
      …×4 similar a 57x40..84x40
  main 1280x2186 @0,64
    section.hero 1280x472 [pad 96 280][gaps 24][renders background]
      h1 "Ship faster with fewer…" 720x128 [text 56/64, 2 lines]
      p.lead "Measure every layout in…" 720x56 @0,152 [text 18/28, 2 lines]
      div.actions 720x48 @0,232 [gaps across 16, free 404 at end]
        a.btn.primary "Start free" 148x48 [pad 12 24][text 16/24][renders background]
        a.btn "Book a demo" 152x48 @164,0 [pad 12 24][text 16/24][renders border]
    section#pricing 1280x812 @0,472 [pad 40 120][gaps 48]
      h2.section-title "Pricing" 1040x44 [text 36/44][!! covered top 24 by header.site]
      ul.plans 1040x640 @0,92 [gaps across 32]
        li.plan 325x640 [pad 32][gaps 16][renders background, border, shadow]
          h3 "Starter" 261x32 [text 24/32]
          p.price "$9" 261x56 @0,48 [text 48/56]
          span.plan-note "billed yearly, cancel…" 275x20 @0,120 [text 14/20][!! clipped right 14 by li.plan]
        …×2 similar li.plan 325x640
    footer 1280x96 @0,1284 [pad 24 120][renders border-top]
      p.meta "© 2026 Acme Inc." 1040x20 [text 13/20][!! contrast 2.8]
```

### 5.3 Example: rtl page, mobile, dark

`npx pxtree localhost:5173/ar --viewport 390x844 --scheme dark --dpr 2`

```
390x844 dark dpr 2 rtl (start is right) scroll 0/1210 page 390x2054 painted to 2054 sideways 14 by a.more
since last run: 1 changed, 1 new
  ~ body>main>ul.cards>li.card[1] 358x236 was 358x212
  + body>main>ul.cards>li.card[1]>a.more 372x24 [!! past viewport end 14]
summary: 2 findings
  past viewport end 14: a.more
  off center 3 down: button.menu
body 390x2054
  header.bar 390x56 [stuck][pad 8 16][gaps across 12, free 262 at end][renders background]
    button.menu 40x40 [renders background][!! off center 3 down]
      svg 24x21 @8,11 [renders image]
    a.brand "متجر" 44x40 @52,0 [text 20/40]
  main 390x1998 @0,56 [pad 16][gaps 16]
    h1 "أحدث المنتجات" 358x36 [text 28/36]
    ul.cards 358x1914 @0,52 [gaps 16]
      li.card 358x212 [pad 16][gaps 8][renders background, border]
        img 326x120 [renders image]
        h3 "سماعات لاسلكية" 326x24 @0,128 [text 18/24]
        a.more "عرض التفاصيل" 132x24 @0,160 [text 15/24]
      li.card 358x236 @0,228 [pad 16][gaps 8][renders background, border]
        img 326x120 [renders image]
        h3 "ساعة ذكية بشاشة كبيرة…" 326x48 @0,128 [text 18/24, 2 lines]
        a.more "عرض التفاصيل الكاملة" 372x24 @0,184 [text 15/24][!! past viewport end 14]
      …×6 similar li.card 358x212..358x236
```

In rtl, `@x` counts from the right edge of the parent's content box. `a.more` starts at the start (right) edge and is 372 wide in a 326 content box. It runs 46 px past the card's end and 14 px past the viewport's left edge. Only `past viewport` prints, because it suppresses `overflows` on the same side.

### 5.4 Example: modal dialog open

`npx pxtree localhost:5173/projects --script "await page.click('text=Delete')"`

```
1280x800 light dpr 1 ltr scroll 0/940 page 1280x1740 painted to 1702 scroll locked modal dialog#confirm-delete
since last run: 1 changed
  ~ dialog#confirm-delete>div.actions>button.danger 104x40 was 96x40
summary: 1 finding
  text off center 3 down: button.danger
body 1280x1740 [behind modal, 214 elements not printed]
dialog#confirm-delete 480x200 @400,300 [top layer modal][pad 24][gaps 16][renders background, border, shadow]
  div.head 432x32 [gaps across 8]
    h2 "Delete project?" 404x32 [text 24/32]
    button.close 20x20 @412,6 [renders control]
  p "This removes the project…" 432x48 @0,48 [text 16/24, 2 lines]
  div.actions 432x40 @0,112 [gaps across 12, free 220 at start]
    button.ghost "Cancel" 96x40 @220,0 [pad 8 16][text 16/24][renders border]
    button.danger "Delete" 104x40 @328,0 [pad 8 16][text 16/24][renders background][!! text off center 3 down]
```

The dialog prints as its own root after `body`, positioned from the viewport. The page behind it is inert and collapsed to one line, so there is no false "covered by dialog" anywhere. With `--element 'main'` the collapsed part prints normally. The 20x20 close button has no `small target`: no other target is near it, so the spacing exception in 4.12 applies.

### 5.5 `--element`

Every match prints under the lines of all its ancestors (ancestor lines with their tags and findings, but without their other children). `--no-children` drops the subtree of each match. Facts, since-last-run and summary stay page-wide. No match: the tree is replaced by `no element matches <selector>`, and the CLI exits 2 (2.1). Matches without a box: `<selector>: 2 matched, 1 not rendered`.

## 6. Module layout and contracts

```
package.json              C  name pxtree, bin, deps, scripts
tsconfig.json             C
scripts/build.mjs         C  esbuild: browser IIFE + node ESM bundles, tsc declarations, skills/pxtree/SKILL.md
scripts/skill.ts          C  createSkillText(): skill frontmatter and command shapes plus the reading guide
src/types.ts              frozen, written verbatim from 6.1 before packages start
src/browser/index.ts      A  bundle entry: attachShadow hook, globalThis.__pxtree = { measurePage, settlePage, revealByScrolling }
src/browser/walk.ts       A  flat tree walk, visibility, names, node records, top layer, --element matching
src/browser/geometry.ts   A  rects, transforms, sticky, clip chain, ink, colors, text metrics
src/browser/coverage.ts   A  pointer-events override, grid sampling, text backgrounds from stacks
src/browser/settle.ts     A  settlePage, revealByScrolling (in-page, async)
src/findings/layout.ts    B  relative positions, frames, gaps, free space
src/findings/findings.ts  B  analyze(): all findings and their suppression
src/format/format.ts      D  format(): facts line, tree lines, tags, folding, --element view, across block
src/format/summary.ts     D  summary block
src/format/diff.ts        D  createSnapshot(), diffSnapshots(), diff block text
src/node/session.ts       C  launch, contexts, per-run pipeline, script, screenshot, errors
src/node/cache.ts         C  snapshot read/write by key
src/guide.ts              C  readingGuideText, the one copy of the reading guide
src/index.ts              C  public API
src/cli.ts                C  argument parsing, exit codes, guide and mcp subcommands
src/mcp.ts                C  runMcpServer(): stdio MCP server with the measure and guide tools
skills/pxtree/SKILL.md    C  generated by the build, committed
test/helpers.ts           D  fixture helpers
test/fixtures/*.html      per package (section 9)
```

Code runs in: `src/browser/*` only in the page (DOM lib, no Node imports, may only `import type` from `src/types.ts`). `src/findings/*`, `src/format/*` and `src/guide.ts` are pure TypeScript with no I/O. `src/node/*`, `src/index.ts`, `src/cli.ts`, `src/mcp.ts` run in Node.

Node entries: `src/index.ts`, `src/cli.ts` and `src/mcp.ts` each build to `dist/<name>.js`. An import of another entry stays an import of its built file (an esbuild resolve plugin in `scripts/build.mjs`), so `cli.js` and `mcp.js` import `./index.js` instead of bundling the program again, and `cli.js` loads `./mcp.js` only for `pxtree mcp`.

### 6.1 `src/types.ts` (verbatim)

```ts
// ---------- in-page contract (package A produces, B/C/D consume) ----------

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Sides = [top: number, right: number, bottom: number, left: number];

export type Visibility =
  | 'shown'
  | 'unpainted-opacity'
  | 'unpainted-visibility'
  | 'content-skipped'
  | 'sr-only'
  | 'clipped-out'
  | 'offscreen';

export interface MeasurePageOptions {
  elementSelector: string | null;
  maxNodes: number; // 20000
  maxSamples: number; // 21000
}

export interface PageMeasurement {
  url: string;
  viewport: { width: number; height: number }; // documentElement.clientWidth, innerHeight
  scroll: { x: number; y: number; maxX: number; maxY: number };
  page: { width: number; height: number; paintedTo: number };
  devicePixelRatio: number;
  direction: 'ltr' | 'rtl';
  colorScheme: 'light' | 'dark';
  isScrollLocked: boolean;
  modalIndex: number | null; // open :modal or :fullscreen root
  failedFontFamilies: string[];
  isNodeCapReached: boolean;
  nodes: MeasuredNode[]; // preorder; nodes[0] is body; top-layer roots follow the body subtree
  topLayerIndexes: number[];
  element: ElementMatch | null; // set when elementSelector was given
  sampling: { gridStep: number; pointCount: number; isCapped: boolean };
}

export interface ElementMatch {
  selector: string;
  matchedIndexes: number[];
  matchedCount: number; // includes matches without a box
}

export interface MeasuredNode {
  index: number;
  parentIndex: number; // -1 for body and top-layer roots
  depth: number;
  subtreeEnd: number; // last descendant index; descendant test is index < d <= subtreeEnd
  tag: string;
  name: string; // tag#id.class1.class2, section 4.11
  text: string; // own text preview, '' when none
  visibility: Visibility;
  clippedOutByIndex: number | null; // set when visibility is 'clipped-out'
  skippedChildCount: number;
  rect: Rect; // visual, document coordinates
  layoutWidth: number;
  layoutHeight: number;
  rotateDegrees: number; // 0 when not rotated
  scale: number; // 1 when not scaled
  translate: { x: number; y: number } | null; // own transform when it only translates; null when it does not move the node or also rotates or scales
  isInsideTransform: boolean;
  isAnimating: boolean; // a running animation, an infinite one that settling paused, or a scroll-driven one targets the node
  motionRole: 'carousel' | 'marquee' | null; // from role or aria-roledescription
  position: 'static' | 'relative' | 'absolute' | 'fixed' | 'sticky';
  isViewportFrame: boolean; // fixed to the viewport, or a top-layer root
  isStuck: boolean;
  isFloat: boolean;
  isInFlow: boolean; // not absolute, fixed or float
  isInline: boolean; // outer display is inline
  display: string; // computed display, e.g. 'inline', 'inline-block', 'flex'
  direction: 'ltr' | 'rtl';
  border: Sides;
  padding: Sides;
  margin: Sides;
  clip: { rect: Rect; clipperIndexX: number | null; clipperIndexY: number | null } | null; // intersected ancestor clips that apply to this node; a clipper index is null when the viewport clips that axis
  clipsChildren: { x: 'none' | 'clip' | 'scroll'; y: 'none' | 'clip' | 'scroll' };
  scroll: ScrollInfo | null;
  ink: Ink;
  textInfo: TextInfo | null;
  textRuns: TextRun[]; // own text nodes, for gaps and centering
  image: ImageInfo | null;
  isControl: boolean;
  isInteractive: boolean;
  isDisabled: boolean;
  isInlineInText: boolean; // inline element with sibling text in the same parent
  isInert: boolean;
  topLayer: 'modal' | 'popover' | 'fullscreen' | null;
  shadow: 'open' | 'closed' | null; // this node hosts a walked shadow root
  isSlotted: boolean;
  isFrame: boolean; // iframe, frame, object, embed
  labelForIndex: number | null; // for a label: the node index of its control
  labelIndex: number | null; // for a labelable control: the node index of the label that wraps it or names it with `for`
  coverage: Coverage | null; // only for candidates in the viewport
}

export interface TextRun {
  rect: Rect;
  afterChildCount: number; // how many element children come before it
}

export interface ScrollAxis {
  axis: 'x' | 'y';
  contentSize: number;
  visibleSize: number;
  offset: number;
}

export interface ScrollInfo {
  axes: ScrollAxis[];
  childCount: number;
  childrenOutCount: number;
}

export interface Ink {
  background: string | null; // '#rrggbb' or '#rrggbbaa'
  hasBackgroundImage: boolean;
  borderSides: Array<'top' | 'right' | 'bottom' | 'left'>;
  borderColor: string | null; // first painted side
  hasShadow: boolean;
  hasOutline: boolean;
  replaced: 'img' | 'svg' | 'video' | 'canvas' | 'iframe' | 'object' | 'embed' | 'math' | null;
  pseudoInk: 'before' | 'after' | 'both' | null;
  hasText: boolean;
  opacity: number; // cumulative
}

export interface TextInfo {
  fontSize: number;
  lineHeight: number;
  fontWeight: number;
  lineCount: number;
  inkRect: Rect;
  capTop: number;
  baseline: number;
  color: string; // '#rrggbb', blended as drawn
  background: string | null; // '#rrggbb', null when an image or replaced element is behind
  isLarge: boolean;
  truncation: { kind: 'ellipsis' | 'clamp' | 'cut'; hiddenPx: number; clampLines: number } | null;
}

export interface ImageInfo {
  naturalWidth: number;
  naturalHeight: number;
  isComplete: boolean;
  hasSource: boolean;
  isVector: boolean;
  objectFit: string;
}

export interface Coverage {
  sampleCount: number;
  coveredSampleCount: number;
  coverers: Array<{ index: number; sampleCount: number; isTranslucent: boolean }>;
}

export interface SettleReport {
  stillMovingName: string | null;
}

export interface PxtreeInPage {
  measurePage(options: MeasurePageOptions): PageMeasurement;
  settlePage(options: { maxWaitMs: number }): Promise<SettleReport>;
  revealByScrolling(options: { maxSteps: number; maxImageWaitMs: number }): Promise<void>;
}

// ---------- analysis (package B produces, D consumes) ----------

export type FindingKind =
  | 'clipped'
  | 'overflows'
  | 'text-overflows'
  | 'past-viewport'
  | 'covered'
  | 'off-center'
  | 'text-off-center'
  | 'overlaps'
  | 'tops-across-siblings'
  | 'wider'
  | 'sibling-gaps'
  | 'text-truncated'
  | 'contrast'
  | 'small-target'
  | 'image-not-loaded'
  | 'image-aspect'
  | 'image-upscaled'
  | 'scroll-range';

export interface Finding {
  kind: FindingKind;
  nodeIndex: number;
  text: string; // as printed after '!! ', e.g. 'clipped right 12 by div.panel'
  summaryText: string; // text with the amount replaced by '{n}', e.g. 'clipped right {n} by div.panel'; equal to text when there is no amount
  amount: number | null; // for summary ranges
  relatedIndex: number | null; // clipper, coverer, sibling
  textColor: string | null; // contrast grouping
}

export interface Gaps {
  arrangement: 'stacked' | 'across' | 'grid';
  gaps: number[]; // stacked or across: between consecutive items; grid: row gaps
  columnGaps: number[]; // grid only
  freeStart: number;
  freeEnd: number;
}

export interface NodeLayout {
  index: number;
  x: number; // from the parent's content box start edge, or from the viewport when isViewportFrame
  y: number;
  gaps: Gaps | null;
}

export interface Analysis {
  layouts: NodeLayout[]; // same order and length as PageMeasurement.nodes
  findings: Finding[];
}

// ---------- snapshots (package D produces, C stores) ----------

export interface SnapshotNode {
  width: number;
  height: number;
  x: number;
  y: number;
  tags: string;
  findings: string[];
}

export interface Snapshot {
  version: 1;
  nodes: Record<string, SnapshotNode>; // key: node path, section 4.15
}

// ---------- public API (package C) ----------

export interface Viewport {
  width: number;
  height: number;
}

export type ColorScheme = 'light' | 'dark';

export interface SessionOptions {
  /** Installed browser channel such as 'chrome'. Default: Playwright's Chromium. */
  channel?: string;
}

export interface MeasureOptions {
  /** Default [{ width: 1280, height: 800 }]. */
  viewports?: Viewport[];
  /** Default ['light']. */
  colorSchemes?: ColorScheme[];
  /** Default 1. */
  devicePixelRatio?: number;
  /** Window scroll before measuring: coordinates or a selector. Default { x: 0, y: 0 }. */
  scroll?: { x: number; y: number } | string;
  /** Inline code (body of async (page) => {}) or a function. Runs in Node with the Playwright page. */
  script?: string | ((page: import('playwright-core').Page) => Promise<void>);
  /** Text that identifies the script for the cache key. The CLI passes the file content. Default: script if it is a string. */
  scriptCacheText?: string;
  /** Milliseconds to sleep, or a selector to wait for, after the script. */
  wait?: number | string;
  /** Print only these elements. */
  elementSelector?: string;
  /** With elementSelector: include what is inside the matches. Default true. */
  shouldIncludeChildren?: boolean;
  /** PNG path. Several runs get a -WxH-scheme suffix. */
  screenshotPath?: string;
  /** Run the reveal scroll pass. Default true. */
  shouldReveal?: boolean;
  /** Load budget in ms. Default 30000. */
  timeoutMs?: number;
  /** Snapshot directory for since-last-run. null disables it. Default ~/.cache/pxtree. */
  cacheDirectory?: string | null;
}

export interface RunResult {
  viewport: Viewport;
  colorScheme: ColorScheme;
  status: number | null; // HTTP status, null when there was no response
  settle: SettleReport;
  page: PageMeasurement;
  analysis: Analysis;
  previousSnapshot: Snapshot | null; // null on the first run or with the cache off
  isCacheEnabled: boolean;
  screenshotPath: string | null;
  shouldIncludeChildren: boolean;
}

export interface MeasureResult {
  target: string; // resolved URL
  runs: RunResult[];
  error: { kind: 'load' | 'launch' | 'script'; message: string } | null;
}

export interface FormatOptions {
  /** Print hex colors in [renders] and [text]. Default false. */
  shouldShowColors?: boolean;
  /** Drop the tree and keep the facts line, since last run, the summary and the across block. Default false. */
  isSummaryOnly?: boolean;
  /** Keep only the facts line and since last run. Wins over `isSummaryOnly`. Default false. */
  isChangesOnly?: boolean;
}

export interface Session {
  measure(target: string, options?: MeasureOptions): Promise<MeasureResult>;
  close(): Promise<void>;
}
```

### 6.2 Function contracts between packages

```ts
// The page side is reached only through globalThis.__pxtree (type PxtreeInPage).

// src/findings/findings.ts (B)
export function analyze(page: PageMeasurement): Analysis;

// src/findings/layout.ts (B)
export function getNodeLayouts(page: PageMeasurement): NodeLayout[];

// src/format/diff.ts (D)
export function createSnapshot(page: PageMeasurement, analysis: Analysis): Snapshot;
export function getNodePaths(page: PageMeasurement): string[]; // index -> path
export function formatDiff(previous: Snapshot | null, current: Snapshot, isCacheEnabled: boolean): string[];

// src/format/format.ts (D)
export function format(result: MeasureResult, options?: FormatOptions): string;

// src/node/cache.ts (C)
export function readSnapshot(directory: string, key: string): Promise<Snapshot | null>;
export function writeSnapshot(directory: string, key: string, snapshot: Snapshot): Promise<void>;
```

Settling needs the shadow roots too: `settle.ts` finds them by scanning `querySelectorAll('*')` recursively into open roots, plus the closed-root WeakMap, which lives in `walk.ts` so that `index.ts` and `settle.ts` both import it without a cycle. One query per root, fine for settling.

Browser bundle: `scripts/build.mjs` builds `src/browser/index.ts` with `esbuild --bundle --format=iife --target=chrome120` into `dist/browser.js`. The session loads it with `readFileSync(new URL('./browser.js', import.meta.url))` and installs it with `context.addInitScript({ content })`. Init scripts go through CDP and are not blocked by the page's CSP. Measurement is `page.evaluate((options) => globalThis.__pxtree.measurePage(options), options)`. The walk never writes to the DOM except the sticky probe and the pointer-events sheet, both restored in the same task.

Per-run pipeline in `session.ts`, in order: section 4.9 steps, then `analyze(page)`, then `readSnapshot`, `createSnapshot`, `writeSnapshot` (when the cache is on). `format` is called by the CLI, never inside `measure`.

## 7. Testing

- Runner: `node:test` and `node:assert/strict`. Tests are `.ts` files run directly by Node 24 type stripping. No other framework.
- `npm test` = `node scripts/build.mjs && node --test test/*.test.ts`.
- Pure tests (B's findings, D's formatter and diff) import from `src/` and use hand-built `PageMeasurement` objects. No browser.
- Browser tests import `dist/index.js` (the built package) and load fixtures by `file://`. One `Session` per test file, shared by its tests (`before` / `after`). Cache off (`cacheDirectory: null`) except in the diff test, which uses a temp dir.
- `test/helpers.ts` (D) exports:
  - `getFixtureUrl(name: string): string`
  - `measureFixture(session: Session, name: string, options?: MeasureOptions): Promise<MeasureResult>`
  - `formatFixture(session: Session, name: string, options?: MeasureOptions & FormatOptions): Promise<string[]>` (formatted lines)
  - `findLine(lines: string[], startsWith: string): string` (matches after trimming indent, throws with the full output when missing)
- Assertions check substrings of the formatted lines: the node line exists, it has a given tag or finding, and a finding is absent where it must not fire. Every fixture has at least one "must not fire" assertion.
- Fixtures are small static HTML files, no external resources, fonts set to a generic family.

| Fixture                 | Owner | Checks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `simple.html`           | D     | header, hero, cards: `@x,y`, `[pad]`, `[gaps]`, `[text]`, no findings                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `rtl.html`              | A     | `dir=rtl` page and an ltr island: `@x` from the right, `[ltr]` tag, `past viewport end`, `rtl (start is right)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `top-layer.html`        | A     | `showModal()` dialog and a `popover`: dialog as root, `[top layer modal]`, body collapsed and inert behind the dialog                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `sticky-cover.html`     | A     | sticky header at scroll 400 covering a heading: `[stuck]`, `covered top N by header`; a `pointer-events: none` overlay that is still found                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `scroll-container.html` | A     | overflow list: `[scroll y 568 in 300, 15 of 25 out]`, no clipped findings inside, `scroll range y 3` on a second box                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `transforms.html`       | A     | rotate, scale, translate, and the `rotate`/`scale` properties: `[rotated 30° from 100x20]`, no off center inside                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `shadow-dom.html`       | A     | open root with slots, closed root by `attachShadow`, declarative closed root: `[shadow root]`, `[slotted]`, `[shadow root closed]`, `--element` into a shadow tree                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `svg-iframe.html`       | A     | inline svg with 200 children printed as one leaf; iframe `[frame not walked]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `visibility.html`       | A     | display none, visibility hidden with a visible child, opacity 0 menu, off-screen parked element, sr-only, `content-visibility: auto` below the fold                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `contrast.html`         | A     | gray text on white, text on a gradient (`on image`), translucent text over dark, `--colors` hex output                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `off-center.html`       | B     | icon button with an off center icon, button with low text, a card with asymmetric padding that must not fire, and a card whose `h3` and `p` keep default margins that fires `off center N down` (ink, not margins)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `by-design.html`        | B     | css marquee (`[role marquee]`, `[animating]`, its items `clipped out` and grouped per clipper), a translated carousel track (`[translated x -320]`, the visible slide walked through a clipped-out track, hidden slides with absolute captions grouped as `×4` and no `past viewport`), a scroll-snap carousel that prints no clipping, a zoomed image clipped by its card (`[clips 1 of 2 children]`, no finding), an absolute dropdown under an `overflow: hidden` header that fires `clipped out by header`, an absolute label that escapes an `overflow: hidden` box between it and its containing block and must not fire, and a fixed-height panel cutting a paragraph and a button that fires |
| `landing-bugs.html`     | B, D  | a landing page with six planted bugs (card buttons at different heights, nowrap hero heading, nav CTA past the viewport, dark-only low contrast, sticky nav over the anchor target, dialog body cutting its form), each asserted through the formatted summary at 390x844 and 1280x800, light and dark, scrolled to `#pricing`, and with the dialog open; plus the scheme collapse, the across block, the screenshot fact and a since-last-run fix                                                                                                                                                                                                                                                   |
| `truncation.html`       | B     | ellipsis, line clamp (`2 lines` visible), cut text, text overflowing its box, clipped span in `overflow: hidden` card, full-bleed section that prints `overflows parent start and end 340`, a box that sticks out of its own wide parent past the viewport so both print `past viewport`                                                                                                                                                                                                                                                                                                                                                                                                             |
| `alignment.html`        | B     | card row whose buttons sit at different heights (one finding), one wider card with a `featured` class, unequal list gaps where the odd step has an `active` class, a stat card with an `alert` class pushed down in its row (`div.stat tops 0..6 across siblings`), a heading-paragraph stack and padded buttons that must not fire, a paragraph with an inline link that prints no `[gaps]`                                                                                                                                                                                                                                                                                                         |
| `overlaps.html`         | B     | image pulled under the next card by a negative margin (`overlaps`), an absolute badge colliding with a sibling card, an avatar stack of 5 that prints `overlaps` per avatar, a fixed element and an inline span over a box that must not fire, a pair already reported as `covered` that must not repeat                                                                                                                                                                                                                                                                                                                                                                                             |
| `images.html`           | B     | img that does not load, stretched img, upscaled img, svg img that must not fire upscaled, two adjacent 16x16 icon links (`small target`), a spaced icon link, inline link in text, and checkboxes with a big wrapping or `for` label that must not fire, a checkbox with a tiny label that fires                                                                                                                                                                                                                                                                                                                                                                                                     |
| `animations.html`       | A     | fade-in keyframes, a transition, an infinite spinner, a scroll-driven progress bar: finished values, spinner at 0, progress bar at scroll position                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `reveal.html`           | A     | IntersectionObserver fade-in sections below the fold: shown after the reveal pass, `[not painted: opacity 0]` with `--no-reveal`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `state.html`            | C     | menu opened by `--script` click, hover-only tooltip opened by `page.hover`, `--wait` selector                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `dedup.html`            | D     | 12 identical items (`×12`), 30 similar items (`…×29 similar`), wrapper chain (`›`), one item with a finding printed on its own                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

Non-fixture tests: C tests the CLI with `node dist/cli.js` via `child_process` (bad flag exit 1, zero viewport exit 1, capital `X` viewport, missing file exit 2 with `could not load`, `--element` with no match exit 2 after the report, `--screenshot` with two matches notes `(viewport, selector matched 2)`, `--json` parses, `--summary` prints no tree, `--changes` prints only the facts line and since last run, both together exit 1, `guide` prints the guide and writes nothing, `--help` ends with `run: pxtree guide`, `skills/pxtree/SKILL.md` equals `createSkillText()`) and an HTTP 404 page served by `node:http` (`status 404`). `test/mcp.test.ts` spawns `node dist/cli.js mcp` through the SDK's stdio client: a `measure` tool whose description is under 1.5 KB and points to `guide`, a `guide` tool that returns the guide, a fixture call returns the facts line and a tree line, a call with `summary` returns no tree, a bad target returns a tool error with the CLI's message. D tests the diff with two runs of a fixture whose DOM changes between runs through `--script`.

## 8. Performance

Target: a normal page (about 1500 elements, 5 screens tall) in 1-2 s after load, one viewport.

| Step                                           | Cost estimate                     | Cap                                 |
| ---------------------------------------------- | --------------------------------- | ----------------------------------- |
| Browser launch                                 | 300-600 ms, once per session      | reused across viewports and schemes |
| Context and page                               | about 20 ms per `measure` call    | one context, one page               |
| Reveal pass                                    | about 33 ms per screen            | 30 steps, 2000 ms image wait        |
| Settle                                         | 2 frames, plus the stability loop | 1000 ms                             |
| Walk: style, rects, text ranges, pseudo styles | about 20-40 microseconds per node | 20000 nodes                         |
| Sticky probe                                   | one layout per sticky element     | 20 elements                         |
| Coverage                                       | 10-30 microseconds per point      | 15000 grid + 6000 top-up points     |
| JSON transfer                                  | about 1 MB for 3000 nodes         | numbers rounded to 0.01             |
| Findings and format in Node                    | linear, under 50 ms               | see below                           |

O(n²) risks and how they are removed:

- Cover between all pairs: replaced by one viewport grid. Cost is points times stack depth, independent of node count squared.
- Sibling overlap: per parent, sort eligible children by start edge (a sweep line). Compare each child only with earlier children whose end edge is still past its start, and drop a child from the active list once a start passes its end. Linear in children for normal layouts. The active list is capped at 50, so a pathological pile of boxes on one spot stays bounded.
- Descendant checks inside coverage: O(1) with `index` / `subtreeEnd`.
- Element-to-node lookup: one `Map<Element, number>`.
- Cousin alignment: per group of same-name siblings, a path map of each member's subtree, capped at 50 members and 200 descendants per member.
- Sibling width and gap rules: linear per parent.
- Small-target spacing: targets go into a 64 px grid by the cells their rects touch. Each undersized target checks only the cells within 24 px of its center.
- Class frequency: one count pass over walked nodes.
- The walk only reads layout. The two writes (sticky probe, pointer-events sheet) are batched so layout is not thrashed: all sticky probes run after the walk in one batch (write all, read all, restore all).

## 9. Work packages

Step 0, before any package starts (the orchestrator does it): create `/home/plant/code/pxtree/src/types.ts` verbatim from 6.1. After that it is frozen. A package that needs a type change stops and reports it instead of editing.

Assumptions every package can rely on (package C makes them true):

- `package.json`: `"type": "module"`, Node `>=20` at runtime, Node 24 for tests.
- Source imports use explicit `.ts` extensions (`import { analyze } from './findings/findings.ts'`). Type-only imports use `import type`.
- Only erasable TypeScript syntax: no `enum`, no `namespace`, no parameter properties (`erasableSyntaxOnly: true`).
- `npm run build` produces `dist/browser.js`, `dist/index.js`, `dist/cli.js`, `dist/mcp.js`, `dist/types/*.d.ts` and `skills/pxtree/SKILL.md`. Until C lands, A can build the browser bundle with `npx esbuild src/browser/index.ts --bundle --format=iife --target=chrome120 --outfile=dist/browser.js`.
- `npm test` runs `node scripts/build.mjs && node --test test/*.test.ts`.
- `npm run typecheck` runs `tsc --noEmit`. `tsconfig.json` uses `strict`, `module`/`moduleResolution` `nodenext`, `erasableSyntaxOnly`, `verbatimModuleSyntax`, `lib: ["ESNext", "DOM", "DOM.Iterable"]`, `types: ["node"]`, and `paths` mapping `pxtree` to `./src/index.ts`, so tests that import `pxtree` typecheck against the source on a clean checkout, before any build. playwright-core's declarations need `ESNext` (`Symbol.asyncDispose`) and `@types/node` (`Buffer`).
- devDependencies: `typescript`, `esbuild`, `@types/node`. dependency: `playwright-core` pinned to exactly `1.63.0`.

Each package runs its own tests before reporting. Integration tests that need other packages are written now and must pass once all packages land.

### Package A: browser measurement core

Files: `src/browser/index.ts`, `src/browser/walk.ts`, `src/browser/geometry.ts`, `src/browser/coverage.ts`, `src/browser/settle.ts`.
Fixtures and tests: `rtl.html`, `top-layer.html`, `sticky-cover.html`, `scroll-container.html`, `transforms.html`, `shadow-dom.html`, `svg-iframe.html`, `visibility.html`, `contrast.html`, `animations.html`, `reveal.html`, and `test/browser.test.ts`.

Builds sections 4.1-4.11 except the Node-side order in 4.9 (package C drives that). `index.ts` installs the attachShadow hook at top level and sets `globalThis.__pxtree` (type `PxtreeInPage`).

`test/browser.test.ts` loads `dist/browser.js` directly with `playwright-core` (`context.addInitScript`, `page.goto(file://...)`, `page.evaluate(measurePage)`) and asserts on `PageMeasurement` fields, so A does not wait for C's session.

Acceptance:

- Every fixture above produces the fields its row in section 7 depends on (visibility states, `isStuck`, `coverage.coverers`, `topLayer`, `shadow`, `isSlotted`, `rotateDegrees`, `scroll`, `textInfo.background === null` over the gradient, etc).
- `animations.html`: finished end values, the infinite spinner at time 0, the scroll-driven bar untouched. `reveal.html`: sections shown after `revealByScrolling`, `unpainted-opacity` without it.
- `measurePage` on a generated page with 3000 elements at 1280x800 finishes under 400 ms, measured in the test.
- `measurePage` leaves the DOM as it found it: the test compares `document.documentElement.outerHTML` and `adoptedStyleSheets.length` before and after.
- No Node imports in `src/browser/*`.

### Package B: layout and findings

Files: `src/findings/layout.ts`, `src/findings/findings.ts`.
Fixtures and tests: `off-center.html`, `truncation.html`, `alignment.html`, `overlaps.html`, `images.html`, `test/findings.test.ts` (pure, hand-built `PageMeasurement` objects), `test/findings-fixtures.test.ts` (end to end through `dist/index.js` and `test/helpers.ts`).

Builds section 4.12 and the layout parts of 4.3 (`@x,y`, frames, rtl mapping), `[gaps]` and free space. Findings on `Finding.text` use exactly the printed forms in the 4.12 table. Contrast is computed here from `TextInfo.color` and `TextInfo.background`.

Acceptance:

- Each finding kind has at least one pure test that fires and one that must not fire, including every "suppressed when" condition in 4.12.
- `overlaps` has pure tests for: the basic pair, each exclusion (fixed, float, inline, no box ink, containment, under 2 px on one axis), the covered-pair suppression, a stack of equal overlaps that fires on each member, and inside a rotated parent.
- `analyze()` on a 20000-node synthetic page runs under 200 ms, including a parent with 5000 children for the overlap sweep.
- The fixture tests pass once A, C and D land.

### Package C: node driver, CLI, packaging

Files: `package.json`, `tsconfig.json`, `scripts/build.mjs`, `scripts/skill.ts`, `src/node/session.ts`, `src/node/cache.ts`, `src/guide.ts`, `src/index.ts`, `src/cli.ts`, `src/mcp.ts`, `README.md` (agent setup: MCP, skill, `pxtree guide`; one example).
Fixtures and tests: `state.html`, `test/driver.test.ts`, `test/cli.test.ts`, `test/mcp.test.ts`.

Builds sections 2, 3, the Node-side order of 4.9, 4.15 storage, 10. Argument parsing uses `node:util` `parseArgs`. No CLI library.

Acceptance:

- `npx pxtree test/fixtures/simple.html` works from a clean checkout after `npm install && npm run build`, with no postinstall step.
- Missing browser prints the one-line hint and exits 3 (tested by pointing `PLAYWRIGHT_BROWSERS_PATH` at an empty temp dir).
- Two viewports and two schemes use one browser, one context and one page, verified by counting `browser.contexts()` and `context.pages()` inside the test.
- The state fixture passes its section 7 row. The animation and reveal fixtures pass end to end through `measure()` once A lands.
- `pxtree guide` prints the guide and touches no file. `pxtree mcp` serves `measure` and exits when stdin ends.

### Package D: formatter, summary, diff, test harness

Files: `src/format/format.ts`, `src/format/summary.ts`, `src/format/diff.ts`, `test/helpers.ts`.
Fixtures and tests: `simple.html`, `dedup.html`, `test/format.test.ts` (pure), `test/diff.test.ts`, `test/fixtures.test.ts` (end to end for `simple.html` and `dedup.html`).

Builds section 5 exactly (grammar, tag order, rounding, folding from 4.13, `--element` view, behind-modal collapse, across block) and 4.15 snapshots and diff.

Acceptance:

- Pure tests reproduce the three examples in 5.2-5.4 line for line from hand-built `PageMeasurement` plus `Analysis` objects.
- Folding, `--element` with and without children, first run / no changes / 20-line cap, across block with 1 and 2 runs, all covered by pure tests.
- `test/helpers.ts` is ready for A, B and C to import on day one.

## 10. Install and distribution

- npm name `pxtree`. `bin: { "pxtree": "dist/cli.js" }`, `exports: { ".": { "types": "./dist/types/index.d.ts", "default": "./dist/index.js" } }`, `files: ["dist", "skills", "README.md", "LICENSE", "server.json"]`. License MIT.
- `npx -y pxtree <url>` works with zero config. Every documented `npx` command carries `-y`, because an MCP client or agent shell has no one to answer npx's install prompt.
- Dependency `playwright-core` (exact `1.63.0`) has no install script, so nothing downloads on install. Chromium comes from the user's Playwright cache (`~/.cache/ms-playwright`, `chromium_headless_shell-1243` for headless) or from `--channel chrome`.
- Missing browser: the launch error that contains `Executable doesn't exist` becomes `could not launch chromium, run: npx -y playwright@1.63.0 install chromium` (version read from the installed `playwright-core/package.json`), exit 3. Any other launch error prints `could not launch chromium: <first line of the error>`, exit 3.
- `--channel chrome` passes `channel` to `chromium.launch`. Its own missing-browser error is printed as is.

pxtree never edits the user's files. An agent learns the tool in one of three ways, none of which writes into the project.

### 10.1 Reading guide

`src/guide.ts` exports `readingGuideText`, the only copy of the guide: what the tool is for, every flag with one example, the output grammar, every tag and finding in one line each, and the limits from 4.14. Under 120 lines. It reaches agents verbatim through:

- `pxtree guide`, printed to stdout, for agents that only have a shell.
- The `guide` tool in `pxtree mcp`.
- `skills/pxtree/SKILL.md`, in the [Agent Skills](https://agentskills.io) format: frontmatter `name: pxtree`, a `description` that triggers on building, editing, styling or debugging a page, layout, CSS or a component's rendering and on reaching for a screenshot or DOM snapshot, and `license`. The body is, in order: that findings are measurements to judge against the code and never to list back to the user; "Use it when" and "Do not bother when", at most 12 lines together, each line grounded in a `bench/RESULTS.md` row with its numbers; a "Long sessions" block of at most 6 lines (start with `--summary`, drill with `--element`, verify a fix with `--changes`, one screenshot at the end, never paste the output to the user); the command shapes (dev server, file, viewports, dark, scroll, `--element`, `--script` for a state, `--screenshot` only when text is not enough), and that tags in the tree can be bugs too, then the guide. The guide says near its top, once, that every `[!!]` is a measurement and whether it is a bug is the agent's call. `scripts/skill.ts` composes it, the build writes it, and a test fails when the committed file is stale. The user installs it with `npx -y skills add alabsi91/pxtree`, which finds `skills/pxtree/SKILL.md` with no index file, or symlinks the directory into `~/.agents/skills/` (most agents) or `~/.claude/skills/` (Claude Code). The npm package ships `skills/`.

Guide changes are made in `src/guide.ts` and rebuilt. No other file holds guide text.

### 10.2 MCP server

`pxtree mcp` loads `dist/mcp.js` and serves MCP over stdio with `@modelcontextprotocol/sdk` (exact `1.30.0`) and `zod` (exact `4.6.5`) for the input schema. It holds one `Session` for its lifetime, so the browser stays warm across calls, and closes it when stdin ends.

Two tools. Every connected session loads their descriptions, so they stay short.

`guide` takes no input and returns `readingGuideText` as one text item.

`measure` has a description under 1.5 KB: what it measures, that findings are measurements with a threshold and never verdicts, the parameter names, the one-line tree grammar, and to call `guide` once before the first `measure`. Input: `target` (required), `viewports` (`{ width, height }[]`), `schemes` (`light`/`dark`), `scroll` (`{ x, y }` or a selector), `element`, `children`, `colors`, `wait` (ms or selector), `script` (inline code only), `screenshot` (boolean: a PNG per run under a fresh `os.tmpdir()/pxtree-*` directory), `timeout`, `diff` (boolean, default true: `false` skips the since-last-run cache, like `--no-diff`), `summary` (boolean, like `--summary`), `changes` (boolean, like `--changes`, wins over `summary`).

Result: one text item with `format(result)`, plus a second text item `screenshot: <path>` per run when asked. A load, launch or script failure returns `isError: true` with the same single line the CLI prints on stderr.

### 10.3 Registry and plugin files

- MCP Registry: `package.json` `mcpName` is `io.github.alabsi91/pxtree`. Root `server.json` has the same name, an npm package with `packageArguments: [{ "type": "positional", "value": "mcp" }]` so installers run `pxtree mcp`. Its two `version` fields equal the npm version, and so does `.claude-plugin/plugin.json`. `test/versions.test.ts` fails when any of them differ, so a release never ships mismatched numbers.
- Publishing is by hand: `npm test`, `npm publish`, then `mcp-publisher login github` and `mcp-publisher publish`.
- Claude Code plugin: `.claude-plugin/marketplace.json` and `.claude-plugin/plugin.json` (skill path `./skills/pxtree`) plus the root `.mcp.json` install the MCP server and the skill in one step. The root `.mcp.json` is also the project MCP config for this repo.
- The README install table lists Codex, Claude Code, Cursor, VS Code and OpenCode up front and every other client inside a `<details>` block. A client whose config path is not documented says to check the client's docs.
