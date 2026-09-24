import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { skillBodyText } from './guide.ts';
import { createSession, format, getTargetUrl, type MeasureOptions, type Session } from './index.ts';

const measureToolDescription = `Measures how a webpage renders in headless Chromium and returns compact text: a facts line, changes since the last run, a findings summary, then an indented tree, one line per element. Findings are measurements that passed a threshold, never verdicts.

Parameters: target (URL, host or HTML file path), viewports, schemes, scroll, element, children, colors, wait, script (Playwright page code), screenshot, timeout, diff, diffKey, report (tree, findings, summary, changes or none), aria (names, roles, states). One call returns the report, aria tree and screenshot for every viewport, scheme and scroll stop. Never split a question into parallel calls: one browser page, calls run one at a time.

Call read_me_first once per session before the first measure to learn the tags and findings.`;

const readMeFirstToolDescription = 'Read once per session before the first measure. How to use pxtree and how to read its output.';

const serverInstructions = `pxtree measures how a webpage actually renders and prints it as compact text: sizes, positions, clipping, overflow, truncation and contrast. Call read_me_first once per session before measuring.`;

const maxViewportSide = 10000;
const maxViewportCount = 10;
const maxTimeoutMs = 120000;

const maxScrollStopCount = 10;
const exitCodeBySignal = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

const viewportSideSchema = z.number().int().min(1).max(maxViewportSide);
const scrollStopSchema = z.union([z.number().nonnegative(), z.string().min(1)]);

/** Agents often send "true", "false" or "5000" as strings. These become the boolean or number they mean. */
function getCoercedValue(value: unknown): unknown {
  if (value === 'true' || value === 'false') {
    return value === 'true';
  }

  return typeof value === 'string' && /^\s*\d+\s*$/.test(value) ? Number(value) : value;
}

const booleanSchema = z.preprocess(getCoercedValue, z.boolean());
const positiveNumberSchema = z.preprocess(getCoercedValue, z.number().positive());

const measureInputSchema = {
  target: z.string().describe('A string: URL, host like localhost:5173, or HTML file path under the working directory'),
  viewports: z
    .array(z.object({ width: viewportSideSchema, height: viewportSideSchema }))
    .min(1, 'viewports needs at least one viewport')
    .max(maxViewportCount)
    .optional()
    .describe('An array of { width, height } with integer numbers, one run each. Default [{ width: 1280, height: 800 }]'),
  schemes: z
    .array(z.enum(['light', 'dark']))
    .min(1, 'schemes needs at least one scheme')
    .optional()
    .describe('An array of "light" and "dark", the prefers-color-scheme per run. Default ["light"]'),
  scroll: z
    .union([scrollStopSchema, z.array(scrollStopSchema).min(1).max(maxScrollStopCount)])
    .optional()
    .describe('A stop or an array of stops: a number or digit string is a window y offset, "end" is the bottom, anything else is a CSS selector to scroll to the top. An array measures each stop in turn, one run per stop. Default 0'),
  element: z.string().optional().describe('A CSS selector string: print only matching elements and their ancestor lines'),
  children: booleanSchema.optional().describe('A boolean. With element: include what is inside the matches. Default true'),
  colors: booleanSchema.optional().describe('A boolean: print hex colors in [text] and [renders]'),
  wait: z
    .union([z.number().nonnegative(), z.string()])
    .optional()
    .describe('After the script: a number or digit string of milliseconds to sleep, at most timeout, or a CSS selector string to wait up to timeout for'),
  script: z
    .string()
    .optional()
    .describe(
      'A string: the body of async (page) => {}, or a whole function like async (page) => {}, run with the Playwright page before measuring. It is trusted code that runs as Node in the server process with its full rights',
    ),
  screenshot: booleanSchema.optional().describe('A boolean: save a PNG per run under the OS temp directory and return its path'),
  timeout: positiveNumberSchema
    .pipe(z.number().max(maxTimeoutMs))
    .optional()
    .describe('A number of milliseconds to reach DOMContentLoaded. The script, a wait, reveal, settle and measuring each get this long again. Default 30000'),
  maxChars: positiveNumberSchema
    .optional()
    .describe('A number: the longest report in characters. Past it the tree is cut at a line; facts, since last run and summary stay. Default 80000'),
  diff: booleanSchema.optional().describe('A boolean: compare with the previous run of the same target and settings. Default true'),
  diffKey: z
    .string()
    .optional()
    .describe('A name string that replaces script and wait in the since-last-run key, to compare a scripted run with a plain run that used the same name'),
  report: z
    .enum(['tree', 'findings', 'summary', 'changes', 'none'])
    .optional()
    .describe('One of "tree", "findings", "summary", "changes", "none". tree: everything. findings: only lines with findings and their ancestors. summary: no tree. changes: facts line and since last run. none: facts line only. Default tree'),
  aria: booleanSchema.optional().describe("A boolean: add Playwright's aria snapshot of the page, or of each element match, after the report"),
};

/** Strict, so a misspelled key like `viewport` fails naming the key instead of being ignored. */
const measureInputObjectSchema = z.object(measureInputSchema).strict();

type MeasureInput = z.infer<typeof measureInputObjectSchema>;

let screenshotDirectory: string | null = null;

/** One temp directory per server for all screenshots. It is removed when the server stops. */
async function getScreenshotDirectory(): Promise<string> {
  screenshotDirectory ??= await mkdtemp(join(tmpdir(), 'pxtree-'));

  return screenshotDirectory;
}

let screenshotCount = 0;

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
    screenshotCount++;
    measureOptions.screenshotPath = join(await getScreenshotDirectory(), `screenshot-${screenshotCount}.png`);
  }

  return measureOptions;
}

/** A file target must stay inside the working directory, symlinks resolved. Other targets always pass. */
function isAllowedTarget(target: string): boolean {
  const targetUrl = getTargetUrl(target);
  const isFileTarget = URL.canParse(targetUrl) && new URL(targetUrl).protocol === 'file:';
  if (!isFileTarget) {
    return true;
  }

  const getRealPath = (path: string) => (existsSync(path) ? realpathSync(path) : resolve(path));
  const relativePath = relative(getRealPath(process.cwd()), getRealPath(fileURLToPath(targetUrl)));

  const isOutside = relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);

  return !isOutside;
}

/** Measure calls run one after another in arrival order, because the session measures one page at a time. */
function registerMeasureTool(server: McpServer, session: Session): void {
  let previousMeasureCall: Promise<unknown> = Promise.resolve();

  server.registerTool('measure', { description: measureToolDescription, inputSchema: measureInputObjectSchema }, (input) => {
    const measureCall = previousMeasureCall.then(() => measureInSession(session, input));
    previousMeasureCall = measureCall.catch(() => {});

    return measureCall;
  });
}

async function measureInSession(session: Session, input: MeasureInput): Promise<CallToolResult> {
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

  const reportText = format(result, { shouldShowColors: input.colors, report: input.report, maxCharacters: input.maxChars });
  const reportContent = [{ type: 'text' as const, text: reportText }];
  const screenshotPaths = result.runs.flatMap((run) => (run.screenshotPath === null ? [] : [run.screenshotPath]));
  if (screenshotPaths.length > 0) {
    reportContent.push({ type: 'text', text: screenshotPaths.map((screenshotPath) => `screenshot: ${screenshotPath}`).join('\n') });
  }

  return { content: reportContent };
}

function registerReadMeFirstTool(server: McpServer): void {
  server.registerTool('read_me_first', { description: readMeFirstToolDescription }, () => ({ content: [{ type: 'text', text: skillBodyText }] }));
}

/** Serves the `measure` and `read_me_first` tools over stdio with one warm browser session. Closes the browser when stdin ends. */
export async function runMcpServer(): Promise<void> {
  const session = await createSession();
  const packageVersion = (createRequire(import.meta.url)('../package.json') as { version: string }).version;
  const server = new McpServer({ name: 'pxtree', version: packageVersion }, { instructions: serverInstructions });

  registerMeasureTool(server, session);
  registerReadMeFirstTool(server);

  async function closeServer(): Promise<void> {
    await server.close();
    await session.close();

    if (screenshotDirectory !== null) {
      await rm(screenshotDirectory, { recursive: true, force: true });
    }
  }

  process.stdin.once('end', closeServer);

  for (const [signalName, exitCode] of Object.entries(exitCodeBySignal)) {
    process.once(signalName, () => {
      void closeServer().finally(() => process.exit(exitCode));
    });
  }

  await server.connect(new StdioServerTransport());
}
