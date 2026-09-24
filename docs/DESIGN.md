# pxtree design

## 1. Purpose

pxtree measures how a webpage actually renders and prints it as compact text for AI coding agents. The agent already has the source, so pxtree never repeats CSS or attributes. It prints the rendered facts the source cannot tell: real pixel sizes and positions (transforms applied, relative to the parent), what paints, what is clipped, covered, off center or truncated, and text contrast. One line per element, indented as a tree, with a findings summary on top. It runs one headless Chromium, does the whole measurement in one `page.evaluate`, and aims for 1-2 s on a normal page after load. Findings are measurements with a threshold, never verdicts, and pxtree never guesses intent.

## 2. Interfaces

Flags: `pxtree --help` and `pxtree guide` (the guide lives in `src/guide.ts`). API types: `src/types.ts`, exported from `src/index.ts`. MCP server: `src/mcp.ts`. Exit codes:

- 0 measured (findings never change the exit code); 1 bad usage; 3 could not launch the browser.
- 2 could not load the target after one retry, the script threw, the measurement timed out, or the `--scroll` or `--element` selector matched nothing.
- Stdout carries the report, stderr one error line (`could not load <url>: <reason>`, `script failed: <name>: <message>`, `measurement timed out after N ms`, `no element matches <selector>`).

## 3. State mechanism

`--script` runs in Node with the Playwright `page`, not inside the page. Only CDP input gives real hover, focus, keyboard and trusted clicks, and agents already know the Playwright API.

- A path to an existing `.js`, `.mjs` or `.ts` file is imported and its default export called as `await fn(page)`. Anything else is inline code, the body of `async function (page) { <code> }` built with the `AsyncFunction` constructor. The API also takes a function.
- The page's default action timeout is `timeout / 4`. The script runs once per viewport, after the reveal pass and `--scroll`, before `--wait` and the final settle (4.9). It may scroll: pxtree measures whatever scroll the page has at the end.
- A throw ends the run with `script failed: <message>`, exit 2.
- A script that changed nothing is a fact, not an error. Before the script, and again after `--wait` and the final settle, the page reads its state as one string (`getPageStateText`): the DOM with every shadow root (`getHTML({ shadowRoots })`) and the attributes of `html`, the value (and `checked`) of every `input`, `textarea` and `select`, the top-layer elements, and the scroll offsets of the window and of every element. Equal strings print `page unchanged by script` on the facts line, so a click that failed to open a menu does not pass for a real state. A CSS `:hover` or `:focus` state leaves the string as it is, and the guide says so.

## 4. Measurement model

Everything in this section runs in the page inside one synchronous `measurePage()` call, except settling (async, before it) and findings (in Node, after it).

### 4.1 Tree source: the flat tree

The walk follows the rendered flat tree, starting at `body`.

- `getFlatChildren(element)`: the shadow root's child nodes if the element hosts an open or a captured closed root; else for a `<slot>` its `assignedNodes()`, or its own child nodes when nothing is assigned; else `element.childNodes`.
- A child with `display: contents` (default slots included) is not a node. Its flat children are promoted into the parent, recursively.
- Text nodes and `::before` / `::after` are never nodes. Text is its parent's own text, pseudo-elements are its ink (4.5).
- Closed shadow roots made by `attachShadow` are caught by a wrapper that the init script installs before any page script, and tagged `[shadow root closed]`. Declarative closed roots cannot be reached.
- Top layer: an element matching `:modal`, `:popover-open` or `:fullscreen` is skipped where it sits and walked again after the main tree as its own root (`parentIndex -1`), in document order.
- Printed as leaves, never walked into: `svg`, `math`, `img`, `video`, `canvas`, `iframe`, `frame`, `object`, `embed`, `select`, `textarea`, `input`. Skipped entirely: `br`, `wbr`, and anything with no box.
- A shown element with zero width or height, no own text, no ink and no shown children is dropped.
- Node cap 20000. Past it the walk stops descending, the parent gets `[children skipped N]`, and the facts line says `stopped at 20000 elements`.

### 4.2 Visibility

`getVisibility` is the only place that decides visibility, and every finding reads its result. It runs only where `element.checkVisibility()` is true. When that is false the element has no box (display none, closed `<details>` content, inside `content-visibility: hidden`, a closed dialog or popover) and is not in the tree.

First match wins:

| State | Condition | Children walked | Tag |
| --- | --- | --- | --- |
| `unpainted-opacity` | own `opacity` is 0 | no | `[not painted: opacity 0]` + `[children skipped N]` |
| `content-skipped` | `content-visibility: hidden`, or `auto` and its first element child fails `checkVisibility({ contentVisibilityAuto: true })` | no | `[content skipped]` |
| `sr-only` | border box at most 1x1; or overflow not `visible`, no background or border, and a content box at most 1x1, or above 0 and at most 1 px on either axis (a 1x44 nav label; a 0 px axis alone is a collapsed box); or `clip` computes to `rect(0px, 0px, 0px, 0px)`; or `clip-path` is `inset(50%)` or larger | no | `[sr-only]` |
| `unpainted-visibility` | `visibility` is `hidden` or `collapse` | yes (a child can be `visible`) | `[not painted: visibility hidden]` |
| `clipped-out` | the rect does not intersect the clip region (4.4), counting only the reachable entries | only when the node clips nothing itself (its children can overflow it into view) | `[clipped out by X]`, or the `clipped out by X` finding (4.12) instead |
| `offscreen` | the rect lies fully where scrolling can never reach: `right <= 0` or `bottom <= 0` in document coordinates (rtl root: `left >= documentWidth`) | no | `[offscreen]` |
| `shown` | otherwise | yes | none |

A hidden box paints nothing wherever it sits, so `unpainted-visibility` comes before the clip checks: a collapsed panel parked outside a clip (`visibility: hidden; translate: -72px`) prints `[not painted: visibility hidden]`, never `clipped out`. An unpainted node (`unpainted-opacity`, `unpainted-visibility`) prints no `[renders]` tag. An `unpainted-visibility` or walked `clipped-out` node whose subtree has no `shown` node prints as one line with `[children skipped N]`.

Only `shown` nodes take part in findings, coverage and ink. Unpainted, sr-only, offscreen and clipped-out subtrees are invisible to every finding, except the `clipped out` finding itself. sr-only text is never an ancestor's text, and the line count (4.8) skips sr-only inline children.

### 4.3 Geometry

- Visual rect: `getBoundingClientRect()` plus the window scroll, document coordinates, transform-inclusive, rounded to 0.01. Layout size: `offsetWidth` / `offsetHeight`.
- Own transform: `style.transform` composed with `translate`, `rotate` and `scale`. Rotation `atan2(m12, m11)` from 0.5 degrees, scale `hypot(m11, m12)` from 0.01 off 1. `isInsideTransform` when an ancestor rotates or scales. A pure translation reports `translate` from 0.5 px.
- Motion: `isAnimating` when a running, paused infinite or scroll-driven animation targets the element itself. `motionRole` is `marquee` or `carousel` from `role` or `aria-roledescription`.
- `@x,y` (in Node): the offset from the parent's content box, x from the start edge (the right in rtl), omitted at `0,0`. Border and padding of a scaled box count at their drawn size.
- Top-layer roots and `position: fixed` elements with the viewport as containing block print `@x,y` from the viewport (`[fixed]`, `[top layer ...]`).
- Sticky: one batch after the walk sets `position: static !important` on up to 20 sticky nodes, reads, and restores. Stuck when the tops or starts differ by 0.5: `[stuck]`.
- Direction is read per element. A node whose direction differs from its parent's gets `[rtl]` or `[ltr]` and measures its children's `@x` from its own start edge.

### 4.4 Clip chain

Each node carries the clip entries `{ rect, xKind, yKind, clipperIndex }` it inherits plus its own, computed top-down during the walk.

| Source | Clip rect |
| --- | --- |
| `overflow-x` or `overflow-y` not `visible` | padding box, only on the axes that are not `visible` |
| `contain` with `paint` (also `strict`, `content`) | padding box |
| `clip-path` not `none` | border box (shapes are not parsed) |
| `clip` on an absolute element | the parsed rect |
| `position: fixed` root with the viewport as containing block | the viewport rect at the current scroll |

- `overflow` on `html` / `body` propagates to the viewport. It clips only x (clipper: the viewport). On y it only sets the `scroll locked` fact.
- Escaping: an overflow clip applies to an absolute or fixed node only when the clipper is its containing block or an ancestor of it, so the node takes exactly the child clip entries of its containing block. Without one, an absolute node keeps only the viewport entry and a fixed node gets the viewport rect. Containing block for absolute: the nearest ancestor with `position` not `static`, or with `transform`, `translate`, `rotate`, `scale`, `perspective`, `filter`, `backdrop-filter`, `contain` paint/layout/strict/content, `container-type` not `normal`, or `will-change` naming one of those or `position`. For fixed: the same minus the two `position` tests. A top-layer root starts with only the viewport clip.
- A clipper with `overflow` `auto` or `scroll` on an axis is a scroll container on that axis. Being outside it is "scrolled out", never a finding.
- Reachable entries: on each axis, the entries outside the innermost scroll container on that axis are dropped before visibility (4.2) and the per-axis clipper are decided. Scrolling brings content into that scroller's box, so a non-scrolling clipper above it cannot decide what the content reaches. A side panel with `overflow: auto` inside `main { overflow: hidden }` of the same height, or a dialog's scroller inside a clipping frame, leaves its content below the fold `shown`, with the scroller as its clipper on y.
- The JSON keeps the intersection of all entries as `clip.rect` (what is visible now) and, per axis, the reachable clipper that cuts the most off the node, or the innermost reachable one when none cuts. Clippers that cut the same amount within 0.5 px go to the innermost: nothing outside it can bring back what it cuts. The index is `null` for the viewport or when nothing clips that axis, printed `by viewport`.

### 4.5 Ink

What a shown node draws itself:

| Ink | Condition |
| --- | --- |
| background | `background-color` alpha above 0, or `background-image` not `none` |
| border | per side: width above 0, style not `none`/`hidden`, color alpha above 0 |
| shadow | `box-shadow` not `none` |
| outline | `outline-style` not `none` and width above 0 |
| image | replaced: `img`, `svg`, `video`, `canvas`, `iframe`, `object`, `embed`, `math` |
| control | `input` (not hidden), `select`, `textarea`, `button`, `progress`, `meter` |
| text | own text rects |
| pseudo | `::before` or `::after` whose `content` is not `none`/`normal` and that has text, background or border: `before`, `after` or `both` |

No DOM API exposes pseudo-element geometry, so pseudo ink sits on the element's border box. Ink test at a point, for coverage: inside the border box for a background, image, control or pseudo; inside a border strip for borders only; inside an own text rect for text. Border radius is ignored.

### 4.6 Colors and contrast

- Every computed color string (`oklch()`, `color(display-p3 ...)`, `rgb()`) is normalized by filling a 1x1 `OffscreenCanvas` and reading the sRGB bytes, cached per string.
- Background behind text: the `elementsFromPoint` stack at the center of the text ink (taken during coverage sampling, 4.7). Layers below the text are composited, each background times its cumulative opacity, until alpha reaches 1. A `background-image` or a replaced element makes it `null` (`on image`). Outside the viewport, or when not hit, the same compositing runs up the flat ancestor chain. With nothing opaque, the base is the computed background of a probe with `background: Canvas`.
- Text color = the computed `-webkit-text-fill-color` with its alpha times the cumulative opacity, blended over that background. A fill with alpha 0 (gradient text, `color: transparent`) makes it `null` (`fill transparent`): there is no one color to measure.
- Contrast (in Node): WCAG 2.x relative luminance ratio. The threshold is checked on the unrounded ratio, which prints rounded down to one decimal, so 4.46 fires and prints `contrast 4.4`. With `--colors`, `[text]` carries the ratio whether it passes or not (`contrast 5.2`).

### 4.7 Paint order and coverage

pxtree asks the browser: `document.elementsFromPoint` returns the real paint-ordered stack, with stacking contexts, z-index, fixed, sticky and top layer resolved.

1. A `*, *::before, *::after { pointer-events: auto !important }` sheet goes into the document and every shadow root for the sampling and comes out in the same task, so `pointer-events: none` elements are hit too.
2. Grid step `max(4, ceil(sqrt(viewportWidth * viewportHeight / 15000)))`, 9 px at 1280x800. Shadow roots' `elementsFromPoint` entries are spliced in above their hosts, and each element maps to its nearest walked node.
3. Candidates are shown, not inert text or controls in the viewport. Where a candidate has ink (a control: its content box), the coverer is the first node above it that is not it or its descendant, has ink there, and is not its `label`. An ancestor above it counts: a negative z-index under a painted parent.
4. A candidate with fewer than 3 grid points gets 5 more, at most 6000 in total, 21000 points overall (`coverage sampled partly` past it).
5. Per candidate: `sampleCount`, `coveredSampleCount`, and per coverer `{ index, sampleCount, isTranslucent }`. A covered sample is opaque when the fills from the coverer down to the candidate stack to 0.9 alpha. A coverer is translucent when fewer than half of its samples are opaque.

Chromium skips inert elements in hit testing. While a `:modal` dialog or `:fullscreen` element is open, everything outside it is inert: those nodes get no coverage and no findings (4.12), the facts line lists `top layer: dialog#id modal`, and the tree collapses the page behind to one `body` line. `inert` attribute subtrees get no coverage either.

The covered amount is geometric: the candidate's visible rect intersected with the coverer's. An overlap that spans the full width (or height) and touches one edge prints as `top 24` / `bottom 8` / `start 12` / `end 12`, anything else as a percentage of the candidate's visible area.

### 4.8 Text

For a node with own text:

- `fontSize`, `lineHeight` in px (`normal` becomes the first text rect's height), `fontWeight`; `isLarge` at 24 px, or 18.66 px with weight 700.
- `lineCount`: lines over `Range.selectNodeContents(element).getClientRects()`, counting only rects inside the node's own clip (a line-clamped paragraph counts its visible lines) and skipping sr-only inline children. A rect whose vertical middle is above the current line's bottom joins that line.
- `inkRect`: union of own text rects. `capTop` and `baseline` of the first line from canvas `measureText` with the computed `font`: `baseline = firstTextRect.top + fontBoundingBoxAscent`, `capTop = baseline - actualBoundingBoxAscent('H')`.
- `truncation`: `ellipsis` when `text-overflow: ellipsis` and `scrollWidth > clientWidth + 1`; `clamp` when `-webkit-line-clamp` is set and `scrollHeight > clientHeight + 1`; `cut` when the node clips and its text overflows by more than 1 px. `hiddenPx` is the overflow.
- `color`, `background` from 4.6. Inputs and textareas: own text is the value, or the placeholder when it is empty.

Fonts: failed web fonts (`document.fonts` with status `error`) print `font failed Inter`. For fonts that drew, the page picks one text element per distinct `font-family` stack (at most 20). The requested family is the stack's first family, skipping `-apple-system` and `BlinkMacSystemFont`. Only a family that a `FontFace` of the page carries counts: local families are swapped for look-alikes on Linux and would say nothing about the page. For those, CDP `CSS.getPlatformFontsForNode` names the platform font that drew most glyphs. A different family (and not a loaded web font of that family) prints `font "Inter" not used, drew DejaVu Sans`, once per pair, and `font failed` leaves out the families such an item names.

### 4.9 Settling and state order

Per viewport:

1. `setViewportSize`, `emulateMedia({ colorScheme })` for the first scheme, `goto(url, { waitUntil: 'domcontentloaded', timeout })`, one retry, then exit 2. Then `waitForLoadState('load', { timeout: 2000 })`, timeout swallowed. When `page.url()` differs from the target (trailing slashes and default ports aside), the facts line says `redirected to <url>`.
2. `waitForLoadState('networkidle', { timeout: 1500 })`, swallowed, skipped for `file:` targets. Then `document.fonts.ready`.
3. `settlePage()`.
4. Reveal pass (not with `--no-reveal`, a locked scroll, or a page no taller than the viewport): scroll one viewport height at a time, two frames per step, at most 30 steps, then back to 0 and up to 2000 ms for pending images. It fires reveal-on-scroll and lazy loads once.
5. `--scroll`: `scrollTo` or `scrollIntoView({ block: 'start' })`, both `instant`, which reaches a target inside an app shell's `main`.
6. Page state read (3), `--script`, `--wait`.
7. `settlePage()`, page state compared (3).
8. Measure, unless nothing needs it (`--report none`, cache off, no `--element`), racing what is left of `--timeout`: `measurement timed out after N ms`, exit 2. Then the font check, printable page text (5.1), screenshot, and aria snapshot (default mode, per `--element` match with its `checkVisibility` state).
9. Each further scheme: `emulateMedia`, `settlePage()`, measure, screenshot, aria. No reload.

A new viewport reloads the page on the same context and page.

`settlePage({ maxWaitMs: 1000 })` finishes time-based finite animations, pauses infinite ones at `currentTime = 0`, and leaves scroll-driven ones alone. Then a stability loop compares rounded rects of the first 3000 elements per frame until two frames match. When it never settles, the element that moved most is `still moving <name>`.

### 4.10 Scroll containers

A node with `overflow` `auto` or `scroll` on an axis where content exceeds the box prints `[scroll y 568 in 300 at 120, 15 of 25 out]`: per axis the content size, visible size and offset when above 0, then the shown children with no part inside the scrollport out of all shown children. Headless Chromium scrollbars take 0 px (overlay-scrollbar device). `[over 100000 px]` marks a node over 100000 px on one axis.

### 4.11 Names

- `tag`, lowercase (custom elements keep their tag).
- `#id` unless it has a character outside `[A-Za-z0-9_-]` or a run of 3 or more digits (generated ids).
- Up to two classes. Dropped: classes with a character outside `[A-Za-z0-9_-]` (`md:flex`, `w-[20px]`), and hash-only classes (`css-1x2y3z`, `sc-bdVaJa`). A generated suffix is stripped: the last segment after `_`, `__` or `-` when it is 5-10 chars with a digit and a letter. Of what is left, the two with the lowest page-wide frequency print, in source order, each cut to 24 chars. Utility classes on 400 elements drop out without a list.
- Own text: whitespace collapsed, the first 4 words or 24 chars, `…` when cut, in double quotes after the name.

### 4.12 Findings

Pure functions in Node over the JSON. Only `shown` nodes, except `clipped out`. A finding prints inside `[!! ...]` at the end of its line, several joined with `; `.

"Said once down a branch": when an ancestor already carries the same finding kind with the same clipper, coverer or side, descendants do not repeat it. "Where it begins": reported on a node whose parent does not have the same condition, and on a node whose own box (for `past viewport`: box or text ink) extends past its parent's box on that side by 1 px or more.

Sibling groups (tops, starts, wider, taller, shorter, gaps): a sibling's group is its tag plus the classes of its name that at least half of its same-tag siblings carry, so `active` or `featured` does not split it. Texts name the group (`12 wider than li.plan`), the summary lists the node's own name.

Behind a modal: while a modal is open, a node that is inert and outside the modal's subtree has no findings. `analyze` drops them, counts them in `Analysis.behindModalFindingCount`, and the summary ends with `N findings behind the modal not listed`. A node inside an `--element` match keeps its findings: the explicit request wins.

| Finding | Printed | Trigger | Threshold | Suppressed when |
| --- | --- | --- | --- | --- |
| clipped | `clipped right 12 by div.panel`, `clipped bottom 8 by viewport` | text or control whose visual rect extends past a non-scrolling clip on a side; the clipper is the one recorded for that axis (4.4) | 1 px | clipper scrolls on that axis; said once down a branch |
| clipped out | `clipped out by form.modal-body` (kind `clipped`, grouped per clipper in the summary) | `clipped-out` node (4.2) with own text, a control, or unwalked children, whose parent is `shown` or `clipped-out`. Its line prints the finding instead of the tag | fully outside | none |
| overflows | `overflows parent end 14`, `overflows parent start and end 24` | in-flow node whose visual rect extends past the parent's border box on a side, not clipped there; equal opposite overhangs within 1 px print as one. Always where it begins | 1 px | parent scrolls on that axis; `past viewport` on the same side; top and bottom when the node or its parent is an inline box (`display: inline`, not replaced, not a control) |
| text overflows | `text overflows end 30` | own text ink extends past the node's border box and the node does not clip | 1 px | truncation already reported |
| past viewport | `past viewport end 14` | visual rect or visible own text ink extends past the layout viewport's inline end (`documentElement.clientWidth`, rtl: its start), not clipped, not inside a horizontal scroll container | 1 px | where it begins only |
| covered | `covered top 24 by header.site`, `covered 40% by div.toast (translucent)` | coverage (4.7) found a coverer on a text or control candidate | 1 sample and 1 px of overlap; controls need 10% of samples | coverer is an ancestor with pseudo ink (hit testing reports its pseudo-elements as the ancestor); coverer inside another coverer of the same node; said once down a branch per coverer |
| overlaps | on the later sibling: `overlaps div.badge 12x40` (intersection size; summary `overlaps div.badge {n}`, the smaller side) | two shown children of one parent, in-flow or absolute (never fixed, floated or inline), each painting box ink (background, border or replaced), whose rects intersect and neither contains the other | 2 px on both axes | a `covered` finding links the pair; parent or ancestor rotated or scaled |
| off center | `off center 3 down`, `off center 2 end` | parent paints ink or is a control, has symmetric padding on that axis; the union of its shown in-flow children's border boxes and its text runs leaves `before` and `after` in the content box; `d = before - after`. Margins count, because the eye sees ink | `2 <= abs(d) <= 0.5 * (before + after)` | parent or ancestor rotated or scaled; parent scrolls; children overflow the parent; parent has pseudo ink |
| text off center | `text off center 3 down` | node paints ink or is a control, has symmetric block padding, one line of own text and no child boxes; `d = (capTop - paddingTop) - (paddingBottom - baseline)` | `3 <= abs(d) <= 0.5 * (above + below)` | inside rotate or scale |
| tops across siblings | on the row parent: `div.stat tops 0..6 across siblings` (members), `a.button tops 312..328 across siblings` (a descendant); the range is the printed `@y` | 2+ siblings of one group side by side. Members: tops, centers and bottoms in the parent's content box all spread. Descendants: the first relative path, in tree order, where every member has a shown descendant whose three lines spread both from each member's top (a pushed down card does not repeat on its content) and in the parent's content box (centered members of different heights stay quiet). A path step is the tag at a child position (`ul[1]>li[2]`), so `.button-primary` pairs with `.button-secondary` and never with a divider | 2 px | groups over 50 are checked on the first 50 |
| starts across siblings | `input.field starts 0..3 across siblings`, `input starts 100..105 across siblings`; the range is the printed `@x` | the inline twin for a stacked column, from the start edge, so right-aligned and centered columns stay quiet. Descendants only when every member has the same relative paths; inline boxes that are not replaced or controls are skipped | 2 px | groups over 50 are checked on the first 50 |
| wider | `12 wider than li.card` | 3+ siblings of one group in one row; a width shared by at least half of them within 1 px; this one differs | 2 px | inside rotate or scale |
| taller, shorter | `16 taller than li.card`, `10 shorter than li.card` | the height twin of wider | 2 px | inside rotate or scale |
| gaps | on the parent: `gaps 16 16 24 16 between li.step` | 3+ gaps between a run of siblings of one group along one axis; one differs from the most common gap | 2 px | none |
| text truncated | `text truncated ellipsis 40`, `text clamped 3 lines`, `text cut 40` | `truncation` (4.8) | 1 px | none |
| contrast | `contrast 2.8` | text with a known background and color, unrounded ratio below 4.5 (3 for large text) | ratio | background unknown (`on image`); transparent fill; `:disabled` controls |
| small target | `small target 20x20` (summary `small target {n}`, the smaller side) | interactive node (`a[href]`, `button`, `input` not hidden, `select`, `textarea`, `summary`, role `button`/`link`/`checkbox`/`radio`/`switch`/`tab`/`menuitem`) under 24 px on either axis | 24 px (WCAG 2.5.8) | a link inside a line of text; a control whose shown label is 24 px or more on both axes; spacing: a 24 px circle on its center touches no other target's rect and no other undersized target's circle. Nested targets are not neighbors. Nor is a neighbor that nothing can hit: `pointer-events: none`, covered on every coverage sample, or inert while the target is not (an inert target behind a modal still compares with its own neighbors, for `--element`) |
| image not loaded | `image not loaded` | `img` with a `src`, `complete`, `naturalWidth === 0` | none | none |
| image aspect | `image aspect 1.30 of natural` | `img` or `video` with `object-fit: fill`; rendered over natural aspect ratio | 2% | natural size unknown; spacer image (at most 2x2) |
| image upscaled | `image upscaled 2.1` | raster `img`; rendered width times dpr over natural width | 1.25 | svg sources; spacer image |
| scroll range | `scroll range y 3` | scroll container whose content exceeds the box by a little | 1-8 px | none |

Page facts (first line): `status N`, `redirected to <url>` (4.9), `page unchanged by script` (3), `sideways N by X` (the document scrolls sideways; X has the widest `past viewport`), `scroll locked`, `window does not scroll, X scrolls y 2400 in 800` (the window's vertical range is under 1 px and a shown node scrolls vertically; X is the largest by area, an app shell), `top layer: X modal, Y popover` (every top-layer root with its kind; a `dialog.show()` dialog is not in the top layer and prints where it sits), `still moving X`, `font "F" not used, drew G`, `font failed F`, `coverage sampled partly`, `stopped at 20000 elements`, `screenshot <path> WxH`.

Finding texts are lowercase words with their amounts and names, never a judgement word. `Finding.kind` is the kebab-case name. A suppression only removes a measurement that means nothing, repeats one already printed, or follows a WCAG exception. It never guesses intent: full-bleed sections, avatar stacks, open popovers and deliberate clipping print their measurements, with their context as facts (`[clips 5 of 8 children]`, `[translated x -320]`, `[role carousel]`).

### 4.13 Folding repeated output

- Wrapper chain: a node with exactly one printed child, no ink, no tags, no findings and the child's rect (within 0.5 px) prints on the child's line: `div.a › div.b › a.link`. Over three names print as first `› … ›` last.
- Same findings (checked first): a run of 3+ consecutive siblings of one group whose subtrees carry the same finding texts once every number is taken out (a standalone number or a `WxH` size) prints the first in full, then `…×29 similar with the same findings` at the same indent. The summary still counts every finding. An `--element` match is never folded.
- Identical siblings: consecutive siblings with the same name, size, tags and recursive child signature, and no findings inside, print once with ` ×N`.
- Similar siblings: 3+ consecutive same-name siblings without findings print the first in full, then `…×28 similar li.item 300x120..300x180`. Folding compares full names, not groups, so `section.hero` and `section.pricing` stay apart.
- A node with findings and its ancestor lines are never folded away, except into a same-findings run whose first line prints those findings.

### 4.14 Known limits

The guide lists them: coverage only in the viewport, no declarative closed roots or iframes, pseudo ink on the box, clip paths as border boxes, no border radius, desktop emulation only, physical positions in vertical writing, capped load waits, no geometry findings inside rotation or scale, no contrast over images, only web fonts checked.

### 4.15 Since last run

- Cache: `$XDG_CACHE_HOME/pxtree`, else `~/.cache/pxtree`, never inside the user's repo. One `<sha1>.json` `Snapshot` per key, overwritten after every run.
- Key: sha1 of JSON `[url, width, height, scheme, dpr, scroll, script text or file content, wait]`, or `[url, width, height, scheme, dpr, scroll, diff key]` with `--diff-key` (`diffKey`). The diff key names a state: a fix prototyped with `--script "await page.addStyleTag(…)" --diff-key base` compares with a plain run made with `--diff-key base`.
- `Snapshot`: per node path, `{ width, height, x, y, tags, findings }` with printed values. Node path: names from `body` joined with `>`, each with `[n]` when the parent has 2+ children of that name. Top-layer roots start their own path.
- A path only in the old snapshot is gone, only in the new one is new, and hides its descendants. A path in both is changed when width, height, x or y differ by 1 px, or the tag or finding strings differ. Document order, a gone path after the path before it in the old snapshot.
- Pure moves: changed nodes whose only change is `@x,y`, two or more with the same delta, print as one line: `~ 5 boxes from body>main>section.pricing down moved 44 down`. The header counts still count every node.
- A node that only lost findings prints `findings gone: text overflows end 166`. Up to 20 lines, then `… N more`.

## 5. Output format

### 5.1 Grammar

```
report     = run-block { NL run-block }
run-block  = facts NL [ diff NL ] summary NL ( tree | findings-tree | same-tree ) [ NL aria ]
             ; diff only with the cache on; --report findings prints findings-tree; summary ends the block,
             ; changes ends after diff, none after facts; aria follows in every case
facts      = W "x" H SP scheme SP "dpr" SP n SP ( measured | "not measured" ) { SP fact }
measured   = direction SP "scroll" SP y "/" maxY SP "page" SP W "x" H SP "painted to" SP y
direction  = "ltr" | "rtl (start is right)"
fact       = "status" SP code                     ; only when not 2xx
           | "redirected to" SP url
           | "page unchanged by script"
           | "sideways" SP n [ SP "by" SP short-name ]
           | "scroll locked"
           | "window does not scroll," SP short-name SP "scrolls y" SP n SP "in" SP n
           | "top layer:" SP name SP kind { "," SP name SP kind }   ; kind = modal | popover | fullscreen
           | "still moving" SP name
           | "font" SP DQUOTE family DQUOTE SP "not used, drew" SP family
           | "font failed" SP family { "," SP family }
           | "coverage sampled partly"
           | "stopped at 20000 elements"
           | "screenshot" SP path SP W "x" H [ SP "(viewport, selector matched" SP n ")" ]   ; always last
diff       = "since last run: first run" | "since last run: no changes"
           | "since last run:" SP counts { NL "  " ( ( "~" | "+" | "-" ) SP path SP what | "~" SP n SP "boxes from" SP path SP "down moved" SP move ) }
move       = n SP ( "down" | "up" ) [ SP n SP ( "end" | "start" ) ] | n SP ( "end" | "start" )
summary    = ( "summary: no findings" | "summary:" SP count-text { NL "  " summary-line } )
             [ NL "  " count-text SP "behind the modal not listed" ]
           | "summary: same as" SP scheme         ; an earlier run at the same viewport and scroll printed the same lines
summary-line = summary-text [ SP "×" count ] [ "," SP "text" SP hex ] ":" SP short-name { "," SP short-name } [ SP "+" n ]
summary-text = Finding.summaryText with "{n}" replaced by the amount range ("12" or "12..18")
count-text = "1 finding" | n SP "findings"
short-name = [ name SP ] name                     ; an ancestor in front only for a context-free name
same-tree  = "tree: same as" SP scheme [ "," SP "differences:" { NL "  " line-without-indent } ]
tree       = ( line | similar ) { NL ( line | similar ) }
line       = indent name [ SP quoted-text ] SP W "x" H [ SP "@" x "," y ] [ SP brackets ] [ SP "×" n ]
similar    = indent "…×" n SP "similar" SP ( name SP size-range | "with the same findings" )
brackets   = { "[" tag "]" } [ "[!!" SP finding { ";" SP finding } "]" ]   ; no space between groups
indent     = two spaces per depth
findings-tree = the lines that carry a finding, under the name lines of their ancestors
name-line  = indent name [ SP "[behind modal," SP n SP "elements not printed]" ]
aria       = "aria:" ( NL yaml | SP "none" [ SP reason ] )               ; the page, or the one --element match
           | { "aria" SP selector SP "match" SP n SP "of" SP m ":" ( NL yaml | SP "none" [ SP reason ] ) }
           | "aria: same as" SP scheme
reason     = "(not rendered)" | "(not painted)"   ; no box; or it or an ancestor is visibility hidden or opacity 0
```

- Numbers are integer px rounded half away from zero, except ratios (one decimal), angles and scale (two decimals). Summary lines group by `summaryText` (contrast also by `textColor`) in order of first appearance.
- Page text (names, text previews, font families, the redirect URL) passes through `getPrintableText` right after `measurePage`: control characters and line separators dropped, `"` to `'`, `[` `]` to `(` `)`, `›` to `>`, so a page cannot forge a tag or a finding.
- A context-free name (no id, every class on 10 or more names) gets its nearest uniquely named ancestor with an id or class in front: `div.footer-legal li`.
- A run whose viewport and scroll equal an earlier run's, with another scheme, compares trees without findings and colors. When they match: `tree: same as light, differences:` plus the lines whose findings differ, and `summary: same as light` when the summary lines are equal too. Runs at different viewports print one full block each, and no block compares them.
- Aria: Playwright's default YAML snapshot in the measured state, the whole subtree of each match even with `--no-children`.
- `--element`: matches print under their ancestor lines, facts and summary stay page-wide, a match behind a modal prints normally with its findings. Matches without a box: `<selector>: 2 matched, 1 not rendered`.

Tag order: frame, `rtl`/`ltr`, transform, `translated`, `animating`, `role`, visibility state, `scroll`, `clips`, `pad`, `gaps`, `text`, `renders`, shadow, `over 100000 px`, `frame not walked`, `children skipped N`, then findings.

| Tag | Meaning |
| --- | --- |
| `[fixed]`, `[top layer modal]` | `@x,y` is from the viewport |
| `[stuck]` | sticky, moved from its flow position |
| `[rotated 30° from 100x20]`, `[scaled 1.50 from 100x20]` | the size is the upright bounding box, `from` the layout size |
| `[translated x -320 y 40]` | the own transform only moves the node |
| `[animating]`, `[role carousel]` | motion facts (4.3) |
| `[clips 5 of 8 children]` | a non-scrolling clip cuts 5 of its 8 direct children fully (`clipped-out` by it) or by 1 px or more (shown, with their clip inside its padding box) |
| `[pad 16 8]` | padding in shorthand order, when not all zero |
| `[gaps 24]`, `[gaps across 16]`, `[gaps 24 across 16]` | distances between in-flow children and text runs, stacked, side by side, rows and columns; `, free 110 at end` from 1 px; up to 6 values, then `…`; never on a text flow |
| `[text 16/24, 2 lines]` | font size / line height; `fill transparent`, `on image`; with `--colors`: `#e6edf3 on #1e2530, contrast 13.0` (the ratio only when both colors are known) |
| `[renders background, border-bottom, shadow]` | what it paints: also `outline`, `image`, `control`, `::before`, `::after`; with `--colors` each color follows its part |
| `[shadow root]`, `[shadow root closed]`, `[slotted]` | shadow host; light-DOM child drawn through a slot |
| `[behind modal, 214 elements not printed]` | on `body` while a modal or fullscreen element is open |

### 5.2 Example

`pxtree localhost:5173 --scroll '#pricing'`

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
    a "Features" 66x40 @136,0 [text 15/40]
    …×4 similar a 57x40..84x40
  main 1280x2186 @0,64
    section#pricing 1280x812 @0,472 [pad 40 120][gaps 48]
      h2.section-title "Pricing" 1040x44 [text 36/44][!! covered top 24 by header.site]
      ul.plans 1040x640 @0,92 [gaps across 32]
        li.plan 325x640 [pad 32][gaps 16][renders background, border, shadow]
          span.plan-note "billed yearly, cancel…" 275x20 @0,120 [text 14/20][!! clipped right 14 by li.plan]
        …×2 similar li.plan 325x640
    footer 1280x96 @0,1284 [pad 24 120][renders border-top]
      p.meta "© 2026 Acme Inc." 1040x20 [text 13/20][!! contrast 2.8]
```

## 6. Module layout

```
src/types.ts              every type between the page, the findings, the formatter and the API
src/browser/index.ts      bundle entry: attachShadow hook, globalThis.__pxtree (measurePage, settlePage, getPageStateText, ...)
src/browser/walk.ts       flat tree walk, visibility, names, top layer, --element matching
src/browser/geometry.ts   rects, transforms, sticky, clip chain, ink, colors, text metrics
src/browser/coverage.ts   pointer-events override, grid sampling, text backgrounds
src/browser/settle.ts     settlePage, revealByScrolling
src/findings/*.ts         layouts (@x,y, gaps) and analyze(): every finding and its suppression
src/format/*.ts           format(), summary, snapshots and the since-last-run diff
src/node/*.ts             session (launch, per-run pipeline, script, screenshot, aria, fonts) and the cache
src/cli.ts, src/mcp.ts    CLI flags and exit codes; the MCP server with the measure and guide tools
```

`src/browser/*` runs only in the page and imports only types. `src/findings/*`, `src/format/*` and `src/guide.ts` are pure. The build bundles the browser code as an IIFE that the session installs with `context.addInitScript`, and writes `skills/pxtree/SKILL.md` from `scripts/skill.ts`.

## 7. Testing

`npm test` builds, then runs `node --test test/*.test.ts`: pure tests on hand-built `PageMeasurement` objects, browser tests on `test/fixtures/*.html`.
Each fixture is a small static page with no external resources, and each has at least one assertion that a finding must not fire.

## 8. Performance

| Step | Cap |
| --- | --- |
| Browser launch | once per session |
| Context and page | one per `measure` call, reused across viewports and schemes |
| Reveal pass | 30 steps, 2000 ms image wait |
| Settle | 1000 ms |
| Walk | 20000 nodes |
| Sticky probe | 20 elements |
| Coverage | 15000 grid points plus 6000 top-up points, 21000 in total |
| Font check | 20 font stacks |
| Findings and format | linear; alignment groups capped at 50 members and 200 descendants each, overlap sweep at 50 active boxes |

## 9. Install

See README. Publishing is by hand:

1. `npm test`, then `npm publish`.
2. MCP Registry: `mcp-publisher login github`, then `mcp-publisher publish`. The binary comes from the releases of github.com/modelcontextprotocol/registry. The npm package named `mcp-publisher` is an unrelated tool, never `npx` it.
3. The versions in `package.json`, `server.json` and `.claude-plugin/plugin.json` must match (`test/versions.test.ts`).
