import { readingGuideReferenceText, reportingRulesText } from '../src/guide.ts';

export const skillFileUrl = new URL('../skills/pxtree/SKILL.md', import.meta.url);

const skillIntroductionText = `---
name: pxtree
description: Measures how a webpage actually renders and prints it as compact text - pixel sizes, positions, clipping, covered text, overflow, off center boxes, truncation, contrast. Use when building, editing, styling or debugging a webpage, a layout, CSS, or a component's rendering, and whenever you would otherwise take a screenshot or a DOM or accessibility snapshot to check how something looks.
license: MIT
---

# Checking a rendered page with pxtree

## Reporting to the user

${reportingRulesText}Before the first call, check that the dev server answers (\`curl -sI localhost:5173\`), so a down server never costs a measurement that only prints \`could not load\`.

pxtree reports what the browser drew, which the source cannot tell you. Use it when (numbers from 47 planted bugs, text against a viewport screenshot):
- tap targets: 5 of 6 found, the screenshot 1 of 6
- clipping by overflow hidden, a dropdown cut by its header included: 3 of 3, the screenshot 0 of 3
- contrast, light or dark: 4 of 4, the screenshot 3 of 4
- content under a fixed or sticky bar: 3 of 3, the screenshot 2 of 3
- a phone width or an open dialog: overflow at 390 4 of 4, cut dialogs 2 of 2
- tokens: about 540 a run, about 60 with --report summary, against about 1100 for a 1280x800 screenshot

Do not bother when:
- you check whether something looks centered: off center 2 of 4, a label at the top of a tall button and a 4 px nudged glyph were missed
- a responsive rule squeezes a layout: 3 of 4, the screenshot 4 of 4
- the page is a big data table and you need all of it: about 1300 tokens, more than a screenshot

Long sessions:
- Start with \`--report summary\` (facts, since last run and findings, no tree), then on a big page \`--report findings\` (only the tree lines with findings, under their ancestors' names), then drill into one area with \`--element '<selector>'\`.
- After a fix, verify it with \`--report changes\`: only the facts line and what changed since the last run.
- To prototype a fix with \`--script "await page.addStyleTag(…)"\`, give it and a plain baseline run the same \`--diff-key base\`, so since last run compares them.
- Add \`--aria\` when you check labels, roles or reading order.
- Measure several regions in one call with \`--scroll 0,'#pricing',end\`, not one call per stop.
- Take one \`--report none --screenshot shot.png\` at the end, only if the text leaves a doubt.

Command shapes:

\`\`\`
npx -y pxtree@latest localhost:5173                                  # dev server
npx -y pxtree@latest ./dist/index.html                               # HTML file
npx -y pxtree@latest localhost:5173 --viewport 390,1280              # mobile and desktop
npx -y pxtree@latest localhost:5173 --scheme dark                    # dark mode
npx -y pxtree@latest localhost:5173 --scroll '#pricing'              # a region below the fold
npx -y pxtree@latest localhost:5173 --scroll 0,'#pricing',end        # several regions in one call
npx -y pxtree@latest localhost:5173 --element '.card'                # one component and its ancestors
npx -y pxtree@latest localhost:5173 --script "await page.click('text=Menu')" --wait '.menu'   # a state: open menu, dialog, hover
npx -y pxtree@latest localhost:5173 --report summary --aria          # findings plus names, roles and reading order
npx -y pxtree@latest localhost:5173 --report findings                # only the lines with findings, on a big page
npx -y pxtree@latest localhost:5173 --report none --screenshot shot.png   # only when the text is not enough
\`\`\`

Tags in the tree such as \`[clipped out by …]\`, \`[not painted …]\` and \`[children skipped …]\` are measurements too, so once \`--report summary\` points you somewhere, read the tree there before acting. Fix what the code shows is a bug, run again, and check \`since last run\` shows the change you meant.

`;

export function createSkillText(): string {
  return skillIntroductionText + readingGuideReferenceText;
}
