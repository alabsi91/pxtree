const purposeText = `# pxtree: the rendered page as text

pxtree loads a page in headless Chromium and prints what rendered: pixel sizes and positions after transforms, what paints, what is clipped, covered, off center or truncated, and text contrast. One line per element, indented as a tree, findings on top. It never repeats CSS or attributes, so read the source for those. Use it after changing markup or CSS, instead of a screenshot or a DOM snapshot. The target is a URL, a host like \`localhost:5173\` (gets http://) or an HTML file path.

`;

/** How to report to the user after measuring. The guide and the skill file print it near their top. */
export const reportingRulesText = `## Reporting to the user

Findings are measurements, not verdicts. Judge each against the code and the design intent, then reply in one of two shapes and nothing else. Never paste the tool output. Never mention a finding you judged fine, or why.
- Nothing to change: one line, \`Landing page is clean at 390, 768 and 1280, light and dark.\` Then one line per side effect, \`Docs dev server left running on :3000.\` No ratios, finding names, list of what you judged intentional or description of what was measured.
- Changes made: one line per change, what and where. Then one line per decision the user must make.

`;

const workflowText = `## Workflow

On 47 planted bugs, pxtree text against a viewport screenshot found tap targets 5 of 6 (screenshot 1), overflow hidden clipping, a dropdown cut by its header included, 3 of 3 (0), contrast in light or dark 4 of 4 (3), content under a fixed or sticky bar 3 of 3 (2), overflow at 390 4 of 4 and cut dialogs 2 of 2. A run costs about 540 tokens, 60 with \`--report summary\`, and a 1280x800 screenshot about 1100. It is weak at centering (2 of 4, it missed a label at the top of a tall button and a glyph nudged 4 px), at a responsive rule that squeezes a layout (3 of 4, the screenshot 4), and at a big data table read whole (about 1300 tokens).

1. Check that the dev server answers (\`curl -sI localhost:5173\`). A down server costs a run that prints only \`could not load\`.
2. Ask for every viewport, scheme and scroll stop in one call, like \`--viewport 390,1280 --scheme light,dark --scroll 0,'#pricing',end\`. Never split one question into parallel calls, because over MCP there is one browser page and calls run one at a time. For several pages, one process per page is fine.
3. Start with \`--report summary\`, then on a big page \`--report findings\`, then \`--element '<selector>'\` for one area. Tree tags like \`[clipped out by …]\` are measurements too, so read the tree where the summary points before acting. Fix what the code shows is a bug, then check with \`--report changes\` that \`since last run\` shows the change you meant.
4. Add \`--aria\` for names, roles, states, labels, reading order or what a screen reader gets.
5. Take one \`--report none --screenshot shot.png\` last, only if the text leaves a doubt.
6. Prototype a fix with \`--script "await page.addStyleTag(…)"\` and give it and a plain baseline run the same \`--diff-key base\`.
7. Text wraps unexpectedly: \`--element 'h1' --viewport 1280,1440,1920 --report tree\`, then read \`N lines, W on one line\` against the element's width.

`;

const flagsText = `## Flags

\`npx -y pxtree@latest <target> [flags]\`. The MCP \`measure\` tool takes \`target\` and the flags as inputs. A dash means CLI only.

| CLI flag | MCP input | meaning |
|---|---|---|
| \`--viewport 390x844,1280x800\` | \`viewports: [{ width, height }]\` | one run per size, default 1280x800. A width alone gets its device height |
| \`--scheme light,dark\` | \`schemes\` | prefers-color-scheme, default light |
| \`--dpr 2\` | - | device pixel ratio, default 1 |
| \`--scroll 0,'#pricing',end\` | \`scroll\` | one run per stop: a y offset, a selector (to the viewport top) or \`end\`. Default 0 |
| \`--script "await page.click('text=Menu')"\` | \`script\` | Playwright page code for a state (open menu, dialog, hover), run once at the first stop: a function body, or a whole \`async (page) => {}\`. The CLI also takes a file that exports \`async (page) => {}\` |
| \`--wait 500\` or \`'.menu'\` | \`wait\` | after the script, sleep ms (at most the timeout) or wait up to the timeout until the selector is visible |
| \`--element '.card'\` | \`element\` | print only matches and their ancestor lines. Facts, summary and since last run stay page-wide |
| \`--no-children\` | \`children: false\` | with element, drop what is inside the matches |
| \`--colors\` | \`colors\` | hex colors in \`[text]\` and \`[renders]\` |
| \`--report summary\` | \`report\` | \`tree\` (default), \`findings\` (lines with findings, under their ancestors' names), \`summary\` (no tree), \`changes\` (facts, since last run), \`none\` (facts) |
| \`--aria\` | \`aria\` | the aria tree after the report, one per element match, always the whole subtree |
| \`--screenshot shot.png\` | \`screenshot: true\` | PNG of the viewport, clipped to a single element match. MCP saves it in the OS temp directory |
| \`--json\` | - | the raw measurement JSON, also on failure. \`--report\` does not apply |
| \`--out ./pxtree-out\` | - | write pxtree.txt and pxtree.json, print facts and summary |
| \`--max-chars 200000\` | \`maxChars\` | longest report, default 80000. Past it the tree is cut at a line and the last line says so. Facts, since last run and summary are never cut |
| \`--timeout 60000\` | \`timeout\` | ms to reach DOMContentLoaded, default 30000, at most 120000. Script, wait, reveal and measuring each get this long again |
| \`--channel chrome\` | - | use an installed browser |
| \`--no-reveal\` | - | skip the scroll pass that fires lazy-load and reveal-on-scroll |
| \`--no-diff\` | \`diff: false\` | skip since last run |
| \`--diff-key base\` | \`diffKey\` | key since last run on this name instead of script and wait |

The aria tree has names, roles and labels and no geometry. One call can hold all three, \`--report summary --aria --screenshot shot.png\`. \`--report none --aria\` is the aria tree alone, \`--report none --screenshot shot.png\` a pure screenshot. With --no-diff too, \`none\` skips measuring and the facts line says \`not measured\`. A script is trusted code: it runs as Node in the pxtree process with its full rights, so pass only code you wrote.

`;

const readingText = `## Output, per viewport, scheme and scroll stop

Facts: \`1280x800 light dpr 1 ltr scroll 0/1450 page 1280x2250 painted to 2210\` is viewport, scheme, dpr, direction (\`rtl (start is right)\`), scroll y/max, document size and lowest painted pixel. Then, when true: \`status 404\`, \`redirected to <url>\`, \`sideways 14 by a.more\` (the widest \`past viewport\` element), \`scroll locked\`, \`window does not scroll, main scrolls y 2400 in 800\` (an app shell, use \`--scroll '<selector>'\`), \`page unchanged by script\` (DOM, control values, top layer and scroll offsets, not :hover or :focus), \`top layer: dialog#x modal, div.menu popover\`, \`still moving div.x\` (never settled), \`font "Inter" not used, drew Arial\` (a page web font drew no text), \`font failed Inter\`, \`coverage sampled partly\`, \`walk capped at 20000 of 31000 elements\` (the tree ends there, an element match past it says \`not walked\`), \`screenshot shot.png 1280x800\` (path and pixel size). A page that navigates on its own after load, like a meta refresh or a login redirect, is followed and measured where it lands, with \`redirected to <url>\`.
\`since last run:\` changes against the last run with the same url, size, scheme, dpr, scroll, script and wait (or diff key), in document order. \`~\` changed, \`+\` new, \`-\` gone. \`~ 12 boxes from body>main>section down moved 44 down\` only moved, all by the same amount. \`findings gone: text overflows end 30\` went away. \`text changed\` means the element's own text changed.
\`summary:\` each finding once with its amount range, \`×count\` and up to three names. A bare tag gets its nearest uniquely named ancestor, \`div.footer-legal li\`. A name siblings share gets its position, \`section.claims p 3 of 5\`. While a modal is open, the inert page behind it has no findings and the summary ends \`3 findings behind the modal not listed\` (\`--element\` on it prints them).
A second scheme whose tree differs only in findings and colors prints \`tree: same as light, differences:\` and only the lines whose findings differ, and \`summary: same as light\` when it matches. A later scroll stop does the same against the previous one, \`tree: same as scroll 0, differences:\`. Other viewports print in full.
\`aria:\` Playwright's aria snapshot as YAML in the measured state (after script, scroll and wait): roles, names, states like \`[checked]\`, text in reading order. \`aria: none\` when empty. \`aria .item match 2 of 3:\` heads each element match, \`none (not rendered)\` or \`none (not painted)\` says why one is empty. \`aria: same as light\` for a second scheme with the same tree.

Tree line: \`name "text" WxH @x,y [tags][!! findings] ×N\`.
- name is tag#id.class, generated ids and hashed or utility classes dropped. "text" is the start of its own text.
- WxH is the border box after transforms. @x,y is from the parent's content box, x from the start edge (right in rtl). No @ means 0,0.
- Two spaces of indent per depth. Same-size wrappers join as \`div.a › div.b › a.link\`.
- \`×N\` N identical siblings. \`…×N similar li.item 300x120..300x180\` N more same-name siblings, sizes as a range. \`…×N similar with the same findings\` N more whose findings match the line above, numbers aside. The summary counts them all.
- No tag means nothing to say. Hidden things (display none, closed details or dialogs) are absent.

## Tags

- \`[fixed]\` @x,y is from the viewport. \`[stuck]\` sticky and moved from its flow position
- \`[top layer modal|popover|fullscreen]\` top-layer root, printed after body, @x,y from the viewport
- \`[rtl]\` \`[ltr]\` direction differs from the parent
- \`[rotated 30° from 100x20]\` \`[scaled 1.50 from 100x20]\` \`[scaled 2.00x1.00 from 100x20]\` \`[flipped x from 100x20]\` WxH is the upright bounding box, from is the layout size
- \`[translated x -320]\` its transform only moves it, by these px (x, y or both)
- \`[animating]\` a running, paused infinite or scroll-driven animation targets it. Findings on or inside it end \`(mid animation)\`, one frame of a moving state
- \`[role carousel]\` \`[role marquee]\` from role or aria-roledescription
- \`[not painted: opacity 0]\` children not walked. \`[not painted: visibility hidden]\` paints nothing, no findings, children can still show
- \`[content skipped]\` by content-visibility
- \`[sr-only]\` clipped to at most 1 px on an axis, or away. Its text counts nowhere
- \`[clipped out by div.x]\` fully outside an ancestor's clip. Text and controls get the finding instead
- \`[offscreen]\` parked where no scroll can reach
- \`[scroll y 568 in 300 at 120, 15 of 25 out]\` scroll box: content size, visible size, offset, children fully out of view
- \`[clips 5 of 8 children]\` its overflow or clip cuts 5 of its 8 children, fully or partly
- \`[pad 16 8]\` padding in shorthand order
- \`[gaps 24]\` \`[gaps across 16]\` space between stacked or side-by-side children, several values when they differ. \`free 110 at end\` is unused space
- \`[text 16/24, 2 lines, 559 on one line]\` font size / line height px, and the width unwrapped (not across a br or kept newline, first 200 per page). \`on image\` when the background is unknown, \`fill transparent\` for gradient or transparent text. With colors \`#e6edf3 on #1e2530, contrast 13.0\`
- \`[renders background, border-bottom, shadow]\` what the box itself paints, also outline, image, control, ::before, ::after
- \`[shadow root]\` \`[shadow root closed]\` shadow host. \`[slotted]\` light-DOM child drawn through a slot
- \`[frame not walked]\` iframe, measure its URL on its own. \`[children skipped 12]\` children not printed. \`[over 100000 px]\` on one axis
- \`[behind modal, 214 elements not printed]\` on body while a modal is open

## Findings, inside [!! ...], amounts in px

A finding is a measurement past a threshold. The tool never guesses intent, so a full-bleed section, avatar stack, open popover or collapsed panel prints its numbers too. Siblings compare by tag plus the classes most of them carry, so \`li.active\` counts as \`li\`. Two siblings with classes but none in common, like \`div.sidebar\` and \`div.content\`, do not compare.
- \`clipped end 12 by div.panel\` text or a control cut 1 px or more by an ancestor's overflow, clip or clip-path, or the viewport
- \`clipped out by div.panel\` text, a control or a box holding them fully outside a non-scrolling clip. What a scroll box can bring into view gets neither
- \`overflows parent end 14\` an in-flow box past its parent's border box, \`start and end 24\` when both sides match
- \`text overflows end 30\` its own text ink past its box
- \`past viewport end 14\` box or text ink past the viewport's inline end, so the page scrolls sideways. On the box where it starts and any box past its own parent
- \`covered top 24 by header.site\` another element paints over it, inside the viewport. \`covered 40% by X (translucent)\` when it shows through
- \`overlaps div.badge 12x40\` sibling boxes with ink intersect by 2 px or more on both axes
- \`off center 3 down\` in a box with symmetric padding, free space above and below its children's border boxes (margins count) differs by 3. \`off center 2 end\` on the inline axis
- \`text off center 3 down\` one text line, space above cap height and below baseline differ by 3 or more
- \`a.button tops 312..328 across siblings\` in a row of sibling cards, the same part (same tag, same child position) shares no top, center or bottom line. The numbers are its @y values. \`div.stat tops 0..6\` is the cards themselves
- \`input.field starts 0..3 across siblings\` stacked siblings, or the same part in each, with @x 0 to 3 and no shared start, center or end line
- \`12 wider than li.card\` one sibling in a row is 12 wider than most. \`16 taller than\`, \`10 shorter than\` for height
- \`gaps 16 16 24 16 between li.step\` one sibling gap differs from the most common by 2 px or more
- \`text truncated ellipsis 40\`, \`text clamped 3 lines\`, \`text cut 40\`
- \`contrast 2.8\` below 4.5, or 3 for large text
- \`small target 20x20\` interactive, under 24 px, another target inside its 24 px spacing circle (WCAG 2.5.8). Fully covered, pointer-events none and inert neighbors do not count
- \`image not loaded\` img with a src loaded no pixels. \`image aspect 1.30 of natural\` object-fit fill stretches it 1.30 times its natural aspect. \`image upscaled 2.1\` raster drawn at 2.1 times its natural pixels
- \`scroll range y 3\` scroll box content exceeds it by 1-8 px

\`clipped out by X\` under a \`[clips …]\` clipper with \`[translated …]\` or \`[animating]\` on its track is a carousel or marquee. Judge it from the code.

## Limits

- Coverage is checked only inside the viewport. Scroll to check another region. Closed declarative shadow roots, iframes and svg insides are not walked.
- Pseudo-element ink sits on the element's box. Clip paths count as their border box. Border radius is ignored. Vertical writing modes print physical positions. A rotated or scaled box gets no overlap, centering, width or height findings inside.
- Desktop emulation: (hover: hover) and (pointer: fine) match, no touch. Scrollbars take 0 px (overlay).
- Time-based animations are finished (infinite ones reset to 0). Scroll-driven ones, view-timeline reveals included, stay where the scroll left them. \`--scroll '<selector>'\` brings one fully in. To inspect a frame, pause the animation at that time in the script and pxtree leaves it there.
- Waits for DOMContentLoaded, then up to 2 s for load and 1.5 s for a quiet network (not for files). Use --wait for slower pages. Page text prints quotes as ', brackets as ( ) and › as >, so it cannot fake a tag or finding.
`;

/** The agent reading guide. `pxtree guide` prints it verbatim. */
export const readingGuideText = purposeText + reportingRulesText + flagsText + readingText;

/** How to use pxtree and how to read its output. The skill file prints it under its frontmatter, the MCP `read_me_first` tool returns it. */
export const skillBodyText = purposeText + reportingRulesText + workflowText + flagsText + readingText;
