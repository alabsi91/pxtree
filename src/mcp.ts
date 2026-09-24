import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createSession, format, getTargetUrl, readingGuideText, type MeasureOptions, type Session } from './index.ts';

const measureToolDescription = `Measures how a webpage actually renders in headless Chromium and returns it as compact text: a facts line, changes since the last run, a summary of findings, then one line per element as an indented tree.

Findings are measurements that passed a threshold, never verdicts. Judge each one against the code.

Tree line: name "text" WxH @x,y [tags] [!! findings] ×N. WxH is the border box after transforms. @x,y is from the parent's content box, x from the start edge.

Parameters: target (URL, localhost:5173-style host, or HTML file path), viewports, schemes, scroll, element, children, colors, wait, script (Playwright page code), screenshot, timeout, diff, diffKey, report (tree, findings for only the lines with findings, summary without the tree, changes, or none), aria (adds the accessibility tree: names, roles, states). One call can return the report, the aria tree and a screenshot together.

Call the guide tool once before the first measure to learn the tags and findings. If the pxtree skill is loaded, skip the guide tool: the skill already holds the guide.`;

const guideToolDescription = 'Returns the pxtree reading guide: every flag, the output grammar, every tag and finding, and the limits. Call it once before the first measure.';

const serverInstructions = `Run measure after every CSS or markup change. Pass the widths that matter when something reflows, both schemes when a color changed, and every region you need as one scroll array. Findings are measurements, not verdicts. Judge each against the code, then report in one of these shapes and nothing else:
Nothing to change: one line like "Landing page is clean at 390, 768 and 1280, light and dark.", then one line per side effect.
Changes made: one line per change, what and where, then one line per decision the user must make.
Never explain why a finding was fine. If you judged it, the user does not hear about it. Never paste the output. If the pxtree skill is loaded, skip the guide tool: the skill already holds the guide.`;

const maxViewportSide = 10000;
const maxViewportCount = 10;
const maxTimeoutMs = 120000;

const maxScrollStopCount = 10;

const viewportSideSchema = z.number().int().min(1).max(maxViewportSide);
const scrollStopSchema = z.union([z.number().nonnegative(), z.string().min(1)]);

const measureInputSchema = {
  target: z.string().describe('URL, host like localhost:5173, or HTML file path under the working directory'),
  viewports: z
    .array(z.object({ width: viewportSideSchema, height: viewportSideSchema }))
    .max(maxViewportCount)
    .optional()
    .describe('Default [{ width: 1280, height: 800 }]'),
  schemes: z.array(z.enum(['light', 'dark'])).optional().describe('prefers-color-scheme per run. Default ["light"]'),
  scroll: z
    .union([scrollStopSchema, z.array(scrollStopSchema).min(1).max(maxScrollStopCount)])
    .optional()
    .describe('A window y offset, "end" for the bottom, or a selector to scroll to the top. An array measures each stop in turn, one run per stop. Default 0'),
  element: z.string().optional().describe('Print only elements matching this selector and their ancestor lines'),
  children: z.boolean().optional().describe('With element: include what is inside the matches. Default true'),
  colors: z.boolean().optional().describe('Print hex colors in [text] and [renders]'),
  wait: z.union([z.number().nonnegative(), z.string()]).optional().describe('After the script: milliseconds to sleep, or a selector to wait for'),
  script: z.string().optional().describe('Body of async (page) => {} run with the Playwright page before measuring'),
  screenshot: z.boolean().optional().describe('Save a PNG per run under the OS temp directory and return its path'),
  timeout: z.number().positive().max(maxTimeoutMs).optional().describe('Milliseconds to reach DOMContentLoaded. Default 30000'),
  diff: z.boolean().optional().describe('Compare with the previous run of the same target and settings. Default true'),
  diffKey: z
    .string()
    .optional()
    .describe('A name that replaces script and wait in the since-last-run key, to compare a scripted run with a plain run that used the same name'),
  report: z
    .enum(['tree', 'findings', 'summary', 'changes', 'none'])
    .optional()
    .describe('tree: everything. findings: only lines with findings and their ancestors. summary: no tree. changes: facts line and since last run. none: facts line only. Default tree'),
  aria: z.boolean().optional().describe("Add Playwright's aria snapshot of the page, or of each element match, after the report"),
};

type MeasureInput = z.infer<z.ZodObject<typeof measureInputSchema>>;

async function createMeasureOptions(input: MeasureInput): Promise<MeasureOptions> {
  const measureOptions: MeasureOptions = {
    viewports: input.viewports,
    colorSchemes: input.schemes,
    scroll: input.scroll,
    elementSelector: input.element,
    shouldIncludeChildren: input.children,
    wait: input.wait,
    script: input.script,
    timeoutMs: input.timeout,
    shouldCaptureAriaSnapshot: input.aria,
    shouldMeasurePage: input.report !== 'none',
    diffKey: input.diffKey,
  };

  if (input.diff === false) {
    measureOptions.cacheDirectory = null;
  }

  if (input.screenshot === true) {
    const screenshotDirectory = await mkdtemp(join(tmpdir(), 'pxtree-'));
    measureOptions.screenshotPath = join(screenshotDirectory, 'screenshot.png');
  }

  return measureOptions;
}

/** A file target must stay inside the working directory, symlinks resolved. Other targets always pass. */
function isAllowedTarget(target: string): boolean {
  const targetUrl = getTargetUrl(target);
  if (!targetUrl.startsWith('file:')) {
    return true;
  }

  const getRealPath = (path: string) => (existsSync(path) ? realpathSync(path) : resolve(path));
  const relativePath = relative(getRealPath(process.cwd()), getRealPath(fileURLToPath(targetUrl)));

  const isOutside = relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);

  return !isOutside;
}

function registerMeasureTool(server: McpServer, session: Session): void {
  server.registerTool('measure', { description: measureToolDescription, inputSchema: measureInputSchema }, async (input) => {
    if (input.report === 'none' && input.aria !== true && input.screenshot !== true) {
      return { isError: true, content: [{ type: 'text', text: 'report none prints nothing without aria or screenshot' }] };
    }

    if (!isAllowedTarget(input.target)) {
      return { isError: true, content: [{ type: 'text', text: `file target outside the working directory: ${input.target}` }] };
    }

    const result = await session.measure(input.target, await createMeasureOptions(input));
    if (result.error !== null) {
      return { isError: true, content: [{ type: 'text', text: result.error.message }] };
    }

    const reportText = format(result, { shouldShowColors: input.colors, report: input.report });
    const reportContent = [{ type: 'text' as const, text: reportText }];
    const screenshotPaths = result.runs.flatMap((run) => (run.screenshotPath === null ? [] : [run.screenshotPath]));
    if (screenshotPaths.length > 0) {
      reportContent.push({ type: 'text', text: screenshotPaths.map((screenshotPath) => `screenshot: ${screenshotPath}`).join('\n') });
    }

    return { content: reportContent };
  });
}

function registerGuideTool(server: McpServer): void {
  server.registerTool('guide', { description: guideToolDescription }, () => ({ content: [{ type: 'text', text: readingGuideText }] }));
}

/** Serves the `measure` and `guide` tools over stdio with one warm browser session. Closes the browser when stdin ends. */
export async function runMcpServer(): Promise<void> {
  const session = await createSession();
  const packageVersion = (createRequire(import.meta.url)('../package.json') as { version: string }).version;
  const server = new McpServer({ name: 'pxtree', version: packageVersion }, { instructions: serverInstructions });

  registerMeasureTool(server, session);
  registerGuideTool(server);

  process.stdin.once('end', async () => {
    await server.close();
    await session.close();
  });

  await server.connect(new StdioServerTransport());
}
