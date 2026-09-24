# pxtree

Loads a webpage in headless Chromium and prints what actually rendered as a compact text tree, so an AI coding agent can check a layout without a screenshot.

A dev server page with a row of three cards, a row of three plans, a list of steps, a row of stats and an article:

```
$ npx -y pxtree@latest localhost:5173
1280x800 light dpr 1 ltr scroll 0/50 page 1280x850 painted to 810
since last run: no changes
summary: 5 findings
  a.button tops 80..152 across siblings: ul.cards
  div.stat tops 0..6 across siblings: div.stats
  12 wider than li.plan: li.plan.featured
  72 taller than li.card: li.card
  gaps 16 16 24 16 between li.step: ul.steps
body 1280x850 [pad 24][gaps 24 24 24 24 16, free 16 at end]
  ul.cards 1232x208 [gaps across 16, free 600 at end][!! a.button tops 80..152 across siblings]
    li.card 200x136 [pad 16][gaps 8][renders background]
      h3 "Starter" 168x24 [text 19/24]
      p "Short text." 168x24 @0,32 [text 16/24]
      a.button "Choose" 168x40 @0,64 [pad 8 16][text 16/24][renders background]
    li.card 200x136 @216,0 [pad 16][gaps 8][renders background]
      h3 "Team" 168x24 [text 19/24]
      p "Short text." 168x24 @0,32 [text 16/24]
      a.button "Choose" 168x40 @0,64 [pad 8 16][text 16/24][renders background]
    li.card 200x208 @432,0 [pad 16][gaps 8][renders background][!! 72 taller than li.card]
      h3 "Business" 168x24 [text 19/24]
      p "A much longer…" 168x96 @0,32 [text 16/24, 4 lines]
      a.button "Choose" 168x40 @0,136 [pad 8 16][text 16/24][renders background]
  ul.plans 1232x56 @0,232 [gaps across 16, free 588 at end]
    li.plan "Monthly" 200x56 [pad 16][text 16/24][renders background] ×2
    li.plan.featured "Lifetime" 212x56 @432,0 [pad 16][text 16/24][renders background][!! 12 wider than li.plan]
  ul.steps 1232x192 @0,312 [gaps 16 16 24 16][!! gaps 16 16 24 16 between li.step]
    li.step "One" 1232x24 [text 16/24] ×2
    li.step.active "Three" 1232x24 @0,80 [text 16/24]
    li.step "Four" 1232x24 @0,128 [text 16/24] ×2
  div.stats 1232x62 @0,528 [gaps across 16, free 456 at end][!! div.stat tops 0..6 across siblings]
    div.stat "Revenue" 182x56 [pad 16][text 16/24][renders background] ×2
    div.stat.alert "Refunds" 182x56 @396,6 [pad 16][text 16/24][renders background]
    div.stat "Customers" 182x56 @594,0 [pad 16][text 16/24][renders background]
  article 1232x132 @0,614 [gaps 12]
    h2 "First heading" 1232x24 [text 24/24]
    p "First paragraph." 1232x24 @0,36 [text 16/24]
    h2 "Second heading" 1232x24 @0,72 [text 24/24]
    p "Second paragraph." 1232x24 @0,108 [text 16/24]
  p.with-link "Read the first." 1232x24 @0,762 [text 16/24]
    a "guide" 39x17 @69,3 [text 16/24]
```

The first line is the facts line: viewport, color scheme, device pixel ratio, direction, scroll position out of the maximum, document size, and `painted to`, the lowest painted pixel. `since last run` compares with the previous run of the same URL and settings. That history lives in `~/.cache/pxtree`, never in your project, and `--no-diff` skips it.

The `ul.cards` line says the "Choose" buttons in the three cards have tops from 80 px to 152 px below the top of their card. The `li.plan.featured "Lifetime"` line says that plan is 212x56 at x 432 in its row, 12 px wider than the width its siblings share. Findings are measurements with a threshold, never verdicts. The agent decides from the code whether they are intended.

## Why not a screenshot

- It gives numbers in CSS px, not pixels the model has to estimate.
- The agent reads it in one pass, as text, with the findings listed on top.
- One call covers several viewports and color schemes.

## Install

pxtree drives Playwright's Chromium. Install it once, about 150 MB:

```
npx -y playwright@1.63.0 install chromium
```

pxtree itself downloads nothing and never edits your project. `--channel chrome` uses an installed Chrome instead. Needs Node 20 or newer.

### MCP server

| Client | Install | Scope |
|---|---|---|
| Codex | `codex mcp add pxtree -- npx -y pxtree@latest mcp` | user, `~/.codex/config.toml` |
| Claude Code | `claude mcp add --scope user pxtree -- npx -y pxtree@latest mcp` | user. `--scope project` writes `.mcp.json` |
| Cursor | [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/install-mcp?name=pxtree&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsInB4dHJlZUBsYXRlc3QiLCJtY3AiXX0%3D) or `~/.cursor/mcp.json` / `.cursor/mcp.json` | user / project |
| VS Code Copilot | [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=flat-square)](https://insiders.vscode.dev/redirect?url=vscode%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522pxtree%2522%252C%2522command%2522%253A%2522npx%2522%252C%2522args%2522%253A%255B%2522-y%2522%252C%2522pxtree%2540latest%2522%252C%2522mcp%2522%255D%257D) or `code --add-mcp '{"name":"pxtree","command":"npx","args":["-y","pxtree@latest","mcp"]}'` | user. `.vscode/mcp.json` for project, see below |
| OpenCode | `~/.config/opencode/opencode.json` or `opencode.json`, see below | user / project |

OpenCode, `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "pxtree": { "type": "local", "command": ["npx", "-y", "pxtree@latest", "mcp"], "enabled": true }
  }
}
```

<details>
<summary>Other clients and config files</summary>

Any MCP client that reads `mcpServers`:

```json
{
  "mcpServers": {
    "pxtree": { "command": "npx", "args": ["-y", "pxtree@latest", "mcp"] }
  }
}
```

| Client | Command or config path | Scope |
|---|---|---|
| Claude Code plugin (MCP server and skill) | `/plugin marketplace add alabsi91/pxtree`, then `/plugin install pxtree@pxtree` | user |
| Gemini CLI | `gemini mcp add -s user pxtree npx -y pxtree@latest mcp` | user. Without `-s user`: project `.gemini/settings.json` |
| Devin (formerly Windsurf) | `devin mcp add pxtree -- npx -y pxtree@latest mcp`, files `~/.config/devin/mcp_config.json` / `.devin/mcp_config.json` | user / project |
| Amp | `amp mcp add pxtree -- npx -y pxtree@latest mcp`, files `~/.config/amp/settings.json` / `.amp/settings.json`, see below | user / project |
| Zed | `~/.config/zed/settings.json`, see below | user |
| Cline | CLI: `cline mcp` or `~/.cline/mcp.json`. VS Code extension: Cline panel, MCP Servers, Configure | user |
| Roo Code | `.roo/mcp.json`, or `mcp_settings.json` from Roo's settings | project / user |
| JetBrains AI Assistant | Settings, Tools, AI Assistant, Model Context Protocol (MCP): paste the JSON above. The file path is not documented, check your client's docs | user / project |

VS Code, `.vscode/mcp.json`:

```json
{
  "servers": {
    "pxtree": { "type": "stdio", "command": "npx", "args": ["-y", "pxtree@latest", "mcp"] }
  }
}
```

Amp, `settings.json`:

```json
{
  "amp.mcpServers": {
    "pxtree": { "command": "npx", "args": ["-y", "pxtree@latest", "mcp"] }
  }
}
```

Zed, `settings.json`:

```json
{
  "context_servers": {
    "pxtree": { "command": "npx", "args": ["-y", "pxtree@latest", "mcp"], "env": {} }
  }
}
```

</details>

MCP Registry name: `io.github.alabsi91/pxtree`. The server has two tools: `measure`, and `guide`, which returns the reading guide.

`measure` takes `target` and the CLI flags as inputs: `viewports`, `schemes`, `scroll`, `element`, `children`, `colors`, `wait`, `script`, `screenshot` (true saves a PNG per run under the temp directory), `timeout`, `diff`, `report` (`tree`, `findings`, `summary`, `changes` or `none`) and `aria` (true adds the aria tree). One call can return the report, the aria tree and a screenshot together. Inputs are bounded: viewport sides 1 to 10000, at most 10 viewports, `timeout` at most 120000. A file target must sit under the server's working directory.

### Skill

For agents that read [Agent Skills](https://agentskills.io), Codex included through `.agents/skills`:

```
npx -y skills add alabsi91/pxtree
```

Or link it by hand. `~/.agents/skills` is read by Codex, Cursor, Copilot, Gemini CLI, OpenCode, Amp and Devin. Claude Code reads `~/.claude/skills`.

```
git clone https://github.com/alabsi91/pxtree
mkdir -p ~/.agents/skills ~/.claude/skills
ln -s "$PWD/pxtree/skills/pxtree" ~/.agents/skills/pxtree
ln -s "$PWD/pxtree/skills/pxtree" ~/.claude/skills/pxtree
```

Use `<project>/.agents/skills` or `<project>/.claude/skills` for one project only.

### Shell-only agents

Tell the agent to run this. It prints the flags, the output grammar, every tag and finding, and the limits.

```
npx -y pxtree@latest guide
```

## CLI

```
npx -y pxtree@latest https://example.com --viewport 390x844,1280x800 --scheme light,dark
npx -y pxtree@latest localhost:5173 --scroll '#pricing' --element '.card'
npx -y pxtree@latest ./dist/index.html
npx -y pxtree@latest localhost:5173 --script "await page.click('text=Menu')" --wait '.menu'
npx -y pxtree@latest localhost:5173 --element '#pricing' --screenshot pricing.png
npx -y pxtree@latest localhost:5173 --viewport 390,1280
npx -y pxtree@latest localhost:5173 --report summary --aria
npx -y pxtree@latest localhost:5173 --report findings
npx -y pxtree@latest localhost:5173 --report changes
npx -y pxtree@latest localhost:5173 --report none --screenshot shot.png
```

The screenshot is clipped to the `--element` match only when the selector matches exactly one element. Otherwise it is the whole viewport, and the facts line says how many matched.

`--report` picks how much of the measurement prints: `tree` (the default, everything), `findings` (the tree cut down to the lines with a finding and the names of their ancestors), `summary` (no tree), `changes` (the facts line and since last run, to check a fix) or `none` (the facts line only). A width alone in `--viewport` gets a matching height: 390x844, 768x1024, 820x1180, 1024x768, 1280x800, 1440x900, 1920x1080, and 800 for any other width. `--aria` adds Playwright's aria snapshot of the page, or of each `--element` match, after the report: roles, names, states and reading order, taken in the same state as the measurement. So one call can carry the findings, the accessibility tree and a screenshot.

`npx -y pxtree@latest --help` lists the flags. `npx -y pxtree@latest guide` explains how to read the output.

## Limits

- Coverage is checked only inside the viewport.
- Declarative closed shadow roots are not walked.
- iframes are not walked. Measure the frame URL on its own.
- Pseudo-element ink is placed on the element's box.
- Clip paths count as their border box. Border radius is ignored.
- Inside a rotated or scaled box there are no overlap, centering or width findings. Its axis-aligned boxes do not say where things are.
- Contrast is not measured over images or gradients, where the `[text]` tag says `on image`, nor for a transparent text fill such as gradient text, where it says `fill transparent`.
- `small target` skips links inside a line of text and targets with enough spacing, as WCAG 2.5.8 allows.
- pxtree does not guess intent. A full-bleed section, an avatar stack, an open popover or a collapsed panel prints its numbers like anything else.
- Desktop emulation only: `(hover: hover)` and `(pointer: fine)` match. No touch.
- Vertical writing modes print physical positions.
- Loading waits at most 2 s for `load` and 1.5 s for a quiet network, which files skip. Slower pages need `--wait`.

## API

```ts
import { createSession, format } from 'pxtree';

const session = await createSession();
const result = await session.measure('localhost:5173', { viewports: [{ width: 390, height: 844 }] });
console.log(format(result));
await session.close();
```

## License

MIT
