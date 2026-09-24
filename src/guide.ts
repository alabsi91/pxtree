/** How to report to the user after measuring. The guide and the skill file print it near their top. */
export const reportingRulesText = `Findings are measurements, not verdicts. Judge each one against the code and the design intent, then reply to the user in one of two shapes and nothing else. Never explain why a finding was fine. If you judged it, the user does not hear about it. Never paste the tool output.
- Nothing to change: one line, \`Landing page is clean at 390, 768 and 1280, light and dark.\` Then one line per side effect, \`Docs dev server left running on :3000.\` No ratios, no finding names, no list of what you judged intentional, no description of what was measured.
- Changes made: one line per change, what and where. Then one line per decision the user must make.

`;

const guideIntroductionText = `# pxtree: the rendered page as text

pxtree loads a page in headless Chromium and prints what actually rendered: pixel sizes and positions after transforms, what paints, what is clipped, covered, off center or truncated, and text contrast. One line per element, indented as a tree, findings on top. It never repeats CSS or attributes: read the source for those. Use it after changing markup or CSS, instead of a screenshot or a DOM snapshot.

Target: a URL, a host like \`localhost:5173\` (gets http://) or an HTML file path.

`;

const guideReferenceText = `## Flags

--viewport 390x844,1280x800     one measurement per size (default 1280x800); a width alone like 390 gets its device height
--scheme light,dark             prefers-color-scheme (default light)
--dpr 2                         device pixel ratio (default 1)
--scroll 0,'#pricing',end       scroll stops, one run each: a y offset, a selector (goes to the top of the viewport) or end (the bottom); the script runs once, at the first stop
--script "await page.click('text=Menu')"   Playwright page code run before measuring; or a file whose default export is async (page) => {}
--wait 500 | '.menu'            after the script: sleep ms, or wait until the selector is visible
--element '.card'               print only matches and their ancestor lines; facts, summary and since last run stay page-wide
--no-children                   with --element, drop what is inside the matches
--colors                        hex colors in [text] and [renders]
--report summary                tree (default, everything) | findings (only lines with findings, under their ancestors' names) | summary (no tree) | changes (facts and since last run, to check a fix) | none (facts line only)
--aria                          add the aria tree after the report; with --element one per match, always the whole subtree, even with --no-children
--screenshot shot.png           PNG of the viewport, clipped to the element with one --element match; the facts line ends with its path and pixel size
--json                          the raw measurement JSON instead of text
--out ./pxtree-out              write pxtree.txt and pxtree.json, print only facts and summary
--timeout 60000                 ms to reach DOMContentLoaded (default 30000); the measurement gets what is left of it after loading
--channel chrome                use an installed browser
--no-reveal                     skip the scroll pass that fires lazy-load and reveal-on-scroll
--no-diff                       skip the since-last-run comparison
--diff-key base                 since last run keys on this name instead of script and wait: a --script fix compares with a plain run of the same key

Names, roles and labels are the aria tree's job. Sizes and positions are the measurement's. Add --aria when you check accessible names, roles, states, labels, reading order or what a screen reader gets. It carries no geometry.
One call can hold all three: \`--report summary --aria --screenshot shot.png\`. \`--report none --aria\` is the aria tree alone, \`--report none --screenshot shot.png\` a pure screenshot. With --no-diff too, \`none\` skips the measurement and the facts line says \`not measured\`.

## Output, per viewport and scheme

Line 1, facts: \`1280x800 light dpr 1 ltr scroll 0/1450 page 1280x2250 painted to 2210\` = viewport, scheme, dpr, direction (\`rtl (start is right)\`), scroll y/max, document size, lowest painted pixel. Then page facts when true: \`status 404\`, \`redirected to <url>\`, \`sideways 14 by a.more\` (page scrolls sideways by 14, the widest \`past viewport\` element causes it), \`scroll locked\`, \`window does not scroll, main scrolls y 2400 in 800\` (an app shell: scroll inside main with --scroll '<selector>'), \`page unchanged by script\` (DOM, control values, top layer and scroll offsets are as before the script; a CSS :hover or :focus state does not count), \`top layer: dialog#x modal, div.menu popover\`, \`still moving div.x\` (never settled), \`font "Inter" not used, drew Arial\` (a web font of the page did not draw the text), \`font failed Inter\`, \`coverage sampled partly\`, \`stopped at 20000 elements\`, \`screenshot shot.png 1280x800\`.
\`since last run:\` changes against the previous run with the same url, size, scheme, scroll, script and wait (or the same --diff-key), in document order. \`~\` changed, \`+\` new, \`-\` gone. \`~ 12 boxes from body>main>section down moved 44 down\`: boxes that only moved, all by the same amount. \`findings gone: text overflows end 30\`: a finding that went away.
\`summary:\` each finding once, with its amount range, \`×count\` and up to three element names. A bare tag gets its nearest uniquely named ancestor in front: \`div.footer-legal li\`. A name that siblings share gets its position among them: \`section.claims p 3 of 5\`. While a modal is open, the inert page behind it has no findings and the summary ends with \`3 findings behind the modal not listed\` (--element on something behind it prints its findings).
A second scheme whose tree matches the first except for findings and colors prints \`tree: same as light, differences:\` and only the lines whose findings differ, and \`summary: same as light\` when its summary is the same. A later scroll stop whose tree matches the previous stop prints \`tree: same as scroll 0, differences:\` the same way. Runs at other viewports print in full, one block each.
\`aria:\` with --aria, after the report: Playwright's aria snapshot as YAML, taken in the measured state (after --script, --scroll and --wait). Roles, names, states like \`[checked]\` or \`[expanded]\`, text, in reading order. \`aria: none\` when it is empty. \`aria .item match 2 of 3:\` heads each of several --element matches, \`none (not rendered)\` or \`none (not painted)\` says why one is empty. \`aria: same as light\` when a second scheme has the same tree.
Tree lines: \`name "text" WxH @x,y [tags][!! findings] ×N\` (bracket groups follow each other with no space)
- name is tag#id.class.class (generated ids and hashed or utility classes dropped); "text" is the start of its own text.
- WxH is the border box after transforms. @x,y is from the parent's content box, x from the start edge (the right edge in rtl). No @ means 0,0.
- Two spaces of indent per depth. Wrapper boxes of the same size join as \`div.a › div.b › a.link\`.
- \`×N\` N identical siblings. \`…×N similar li.item 300x120..300x180\` N more same-name siblings, sizes as a range. \`…×N similar with the same findings\` N more siblings whose findings match the line above, numbers aside; the summary counts them all.
- No tag means nothing to say. Hidden things are simply absent (display none, closed details, closed dialogs).

## Tags

[fixed]                          @x,y is from the viewport
[stuck]                          sticky element currently moved from its flow position
[top layer modal|popover|fullscreen]   top-layer root, printed after body, @x,y from the viewport
[rtl] / [ltr]                    direction differs from the parent
[rotated 30° from 100x20]        WxH is the upright bounding box, from = layout size
[scaled 1.50 from 100x20]        same, for scale
[translated x -320]              its transform only moves it, by these px (x, y or both)
[animating]                      a running, paused infinite, or scroll-driven animation targets it; findings on it or inside it end with (mid animation), one frame of a moving state
[role carousel] [role marquee]   from role or aria-roledescription
[not painted: opacity 0]         opacity 0, children not walked
[not painted: visibility hidden] paints nothing and has no findings, wherever it sits; children can still show
[content skipped]                content-visibility skipped its content
[sr-only]                        screen-reader-only box: clipped content at most 1 px on an axis, or clipped away; its text counts nowhere
[clipped out by div.x]           fully outside an ancestor's clip; text and controls get the finding instead
[offscreen]                      parked where no scroll can reach
[scroll y 568 in 300 at 120, 15 of 25 out]   scroll box: content size, visible size, offset, children fully out of view
[clips 5 of 8 children]          its overflow hidden or clip cuts 5 of its 8 children fully or partly
[pad 16 8]                       padding in CSS shorthand order
[gaps 24] [gaps across 16]       space between children stacked / side by side; \`free 110 at end\` is unused space; several values when they differ
[text 16/24, 2 lines]            font size / line height px; \`on image\` when the background is unknown; \`fill transparent\` for gradient or transparent text; with --colors \`#e6edf3 on #1e2530, contrast 13.0\`
[renders background, border-bottom, shadow]   what the box itself paints; also outline, image, control, ::before, ::after
[shadow root] [shadow root closed] [slotted]   shadow host; light-DOM child drawn through a slot
[over 100000 px]                 over 100000 px on one axis
[frame not walked]               iframe, measure its URL on its own
[children skipped 12]            children not printed
[behind modal, 214 elements not printed]   on body while a modal is open

## Findings, inside [!! ...], amounts in px

Each finding is a measurement that passed a threshold. The tool never guesses intent: a full-bleed section, an avatar stack, an open popover or a collapsed panel prints its numbers like anything else.

clipped right 12 by div.panel      text or control cut by an ancestor's overflow, clip or clip-path (or by viewport), 1 px or more
clipped out by div.panel           text, control or a box holding them, fully outside a non-scrolling clip; what a scroll box can bring into view never gets either
overflows parent end 14            in-flow box extends past its parent's border box; \`start and end 24\` when both sides match
text overflows end 30              its own text ink extends past its box
past viewport end 14               its box or text ink extends past the viewport's inline end, so the page scrolls sideways; on the box where it starts and on any box that sticks out of its own parent
covered top 24 by header.site      another element paints over it (checked inside the viewport only); \`covered 40% by X (translucent)\` when the cover lets it show through
overlaps div.badge 12x40           two sibling boxes with ink intersect by 2 px or more on both axes
off center 3 down                  in a box with symmetric padding, the free space above and below its children's border boxes differs by 3 (margins count as offset); \`off center 2 end\` on the inline axis
text off center 3 down             one text line: the space above its cap height and below its baseline differ by 3 or more
a.button tops 312..328 across siblings   in a row of sibling cards, the same part (same tag at the same child position) shares no top, center or bottom line, in each card and in the row; 312..328 are the @y values the tree prints for it; \`div.stat tops 0..6\` is the cards themselves
input.field starts 0..3 across siblings   in a column of stacked siblings, @x from 0 to 3 px with no shared start, center or end line; like tops, also for the same part inside each sibling
12 wider than li.card              one sibling in a row is 12 wider than the width most siblings share
16 taller than li.card             the same for height, also \`10 shorter than li.card\`
gaps 16 16 24 16 between li.step   gaps between siblings, when one differs from the most common by 2 px or more
                                   siblings compare by tag plus the classes at least half of them carry, so \`li.active\` counts as an \`li\`
text truncated ellipsis 40         also \`text clamped 3 lines\`, \`text cut 40\`
contrast 2.8                       text contrast ratio below 4.5 (3 for large text)
small target 20x20                 interactive element under 24 px, with another target inside its 24 px spacing circle (WCAG 2.5.8); fully covered, pointer-events none and inert neighbors do not count
image not loaded                   img with a src finished loading with no pixels
image aspect 1.30 of natural       object-fit fill draws it at 1.30 times its natural aspect ratio
image upscaled 2.1                 raster drawn at 2.1 times its natural pixels
scroll range y 3                   scroll box whose content exceeds it by 1-8 px

\`clipped out by X\` under a clipper tagged \`[clips 5 of 8 children]\`, with \`[translated …]\` or \`[animating]\` on its track, is what a carousel or marquee looks like. Judge it from the code.

## Limits

- Coverage is checked only inside the viewport. Scroll with --scroll to check another region.
- Declarative closed shadow roots, iframes and svg insides are not walked.
- Pseudo-element ink is placed on the element's box. Clip paths count as their border box. Border radius is ignored.
- Desktop emulation only: (hover: hover) and (pointer: fine) match. No touch.
- Scrollbars take 0 px (overlay-scrollbar device).
- Time-based animations are finished (infinite ones reset to 0) before measuring. Scroll-driven ones, view-timeline reveals included, are measured where the scroll left them. \`--scroll '<selector>'\` brings one fully in.
- Vertical writing modes print physical positions.
- No overlap, centering, width or height findings inside a rotated or scaled box.
- pxtree waits for DOMContentLoaded, then up to 2 s for load and 1.5 s for a quiet network (not for files). Use --wait for slower pages.
- Text that the page controls prints with quotes as ', brackets as ( ) and › as >, so it cannot fake a tag or a finding.
`;

/** The reading guide without the reporting rules, for the skill file that prints them at its top. */
export const readingGuideReferenceText = guideIntroductionText + guideReferenceText;

/** The agent reading guide. `pxtree guide` and the MCP `guide` tool print it verbatim. */
export const readingGuideText = guideIntroductionText + reportingRulesText + guideReferenceText;
