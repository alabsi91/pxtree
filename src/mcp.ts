import { mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createSession, format, readingGuideText, type MeasureOptions, type Session } from './index.ts';

const measureToolDescription = `Measures how a webpage actually renders in headless Chromium and returns it as compact text: a facts line, changes since the last run, a summary of findings, then one line per element as an indented tree.

Findings are measurements that passed a threshold, never verdicts. Judge each one against the code.

Tree line: name "text" WxH @x,y [tags] [!! findings] ×N. WxH is the border box after transforms. @x,y is from the parent's content box, x from the start edge.

Parameters: target (URL, localhost:5173-style host, or HTML file path), viewports, schemes, scroll, element, children, colors, wait, script (Playwright page code), screenshot, timeout, diff, summary (no tree), changes (facts and since last run only).

Call the guide tool once before the first measure to learn the tags and findings.`;

const guideToolDescription = 'Returns the pxtree reading guide: every flag, the output grammar, every tag and finding, and the limits. Call it once before the first measure.';

const measureInputSchema = {
  target: z.string().describe('URL, host like localhost:5173, or HTML file path'),
  viewports: z.array(z.object({ width: z.number().int().positive(), height: z.number().int().positive() })).optional().describe('Default [{ width: 1280, height: 800 }]'),
  schemes: z.array(z.enum(['light', 'dark'])).optional().describe('prefers-color-scheme per run. Default ["light"]'),
  scroll: z.union([z.object({ x: z.number(), y: z.number() }), z.string()]).optional().describe('Window scroll coordinates, or a selector to scroll to the top'),
  element: z.string().optional().describe('Print only elements matching this selector and their ancestor lines'),
  children: z.boolean().optional().describe('With element: include what is inside the matches. Default true'),
  colors: z.boolean().optional().describe('Print hex colors in [text] and [renders]'),
  wait: z.union([z.number().nonnegative(), z.string()]).optional().describe('After the script: milliseconds to sleep, or a selector to wait for'),
  script: z.string().optional().describe('Body of async (page) => {} run with the Playwright page before measuring'),
  screenshot: z.boolean().optional().describe('Save a PNG per run under the OS temp directory and return its path'),
  timeout: z.number().positive().optional().describe('Milliseconds to reach DOMContentLoaded. Default 30000'),
  diff: z.boolean().optional().describe('Compare with the previous run of the same target and settings. Default true'),
  summary: z.boolean().optional().describe('Print the facts line, since last run and summary, without the tree'),
  changes: z.boolean().optional().describe('Print only the facts line and since last run'),
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

function registerMeasureTool(server: McpServer, session: Session): void {
  server.registerTool('measure', { description: measureToolDescription, inputSchema: measureInputSchema }, async (input) => {
    const result = await session.measure(input.target, await createMeasureOptions(input));
    if (result.error !== null) {
      return { isError: true, content: [{ type: 'text', text: result.error.message }] };
    }

    const reportText = format(result, { shouldShowColors: input.colors, isSummaryOnly: input.summary, isChangesOnly: input.changes });
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
  const server = new McpServer({ name: 'pxtree', version: packageVersion });

  registerMeasureTool(server, session);
  registerGuideTool(server);

  process.stdin.once('end', async () => {
    await server.close();
    await session.close();
  });

  await server.connect(new StdioServerTransport());
}
