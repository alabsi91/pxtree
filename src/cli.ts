#!/usr/bin/env node
import { constants, existsSync, statSync } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createSession, format, getTargetUrl, readingGuideText, type Session } from './index.ts';
import type { ColorScheme, FormatOptions, MeasureOptions, PageScript, ReportDetail, Viewport } from './types.ts';

const usageText = `usage: pxtree <url|host|file> [flags]
       pxtree guide    print the reading guide
       pxtree mcp      run as an MCP server on stdio

  --viewport <WxH[,WxH...]>   default 1280x800; a width alone like 390 gets a matching height; sides 1 to 10000
  --scheme <light|dark|light,dark>
  --dpr <n>                   up to 4
  --scroll <y|end|selector[,...]>   one run per stop
  --script <file|code>        trusted code, it runs in Node with the Playwright page
  --wait <ms|selector>
  --element <selector>
  --no-children
  --colors
  --report <tree|findings|summary|changes|none>   default tree
  --aria                      the aria tree after the report
  --screenshot <path>         .png, .jpg or .jpeg; no extension gets .png
  --json                      the raw result, --report and --max-chars do not apply
  --out <dir>
  --max-chars <n>             default 80000; past it the tree is cut
  --timeout <ms>              default 30000, up to 120000
  --channel <name>
  --no-reveal
  --no-diff
  --diff-key <name>           since last run compares runs with the same name, with or without a script

flag examples and how to read the output, run: pxtree guide`;

const maxViewportSide = 10000;
const maxDevicePixelRatio = 4;
const maxTimeoutMs = 120000;
const screenshotExtensions = ['.png', '.jpg', '.jpeg'];
const exitCodeBySignal = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

/** Set when a signal ends the run. The interrupted measure then prints nothing. */
let signalExitCode: number | null = null;

class CommandLineError extends Error {
  exitCode: number;

  constructor(exitCode: number, message: string) {
    super(message);
    this.exitCode = exitCode;
  }
}

class UsageError extends CommandLineError {
  constructor(message: string) {
    super(1, message);
  }
}

/** Common device heights for a width given alone. Any other width gets defaultViewportHeight. */
const viewportHeightByWidth = new Map([
  [390, 844],
  [768, 1024],
  [820, 1180],
  [1024, 768],
  [1280, 800],
  [1440, 900],
  [1920, 1080],
]);

const defaultViewportHeight = 800;

function parseViewports(viewportText: string): Viewport[] {
  return viewportText.split(',').map((sizeText) => {
    const sizeMatch = /^(\d+)(?:x(\d+))?$/i.exec(sizeText.trim());
    if (sizeMatch === null) {
      throw new UsageError(`bad viewport: ${sizeText}, expected WxH like 1280x800 or a width like 390`);
    }

    const width = Number(sizeMatch[1]);
    const height = sizeMatch[2] === undefined ? (viewportHeightByWidth.get(width) ?? defaultViewportHeight) : Number(sizeMatch[2]);
    if (width === 0 || height === 0) {
      throw new UsageError(`bad viewport: ${sizeText}, width and height must be positive`);
    }

    if (width > maxViewportSide || height > maxViewportSide) {
      throw new UsageError(`bad viewport: ${sizeText}, width and height must be at most ${maxViewportSide}`);
    }

    return { width, height };
  });
}

function parseColorSchemes(schemeText: string): ColorScheme[] {
  return schemeText.split(',').map((scheme) => {
    const trimmedScheme = scheme.trim();
    if (trimmedScheme !== 'light' && trimmedScheme !== 'dark') {
      throw new UsageError(`bad scheme: ${scheme}, expected light, dark or light,dark`);
    }

    return trimmedScheme;
  });
}

function parsePositiveNumber(flagName: string, numberText: string, maximum: number): number {
  const parsedNumber = Number(numberText);
  if (numberText.trim() === '' || !Number.isFinite(parsedNumber) || parsedNumber <= 0) {
    throw new UsageError(`bad --${flagName}: ${numberText}, expected a positive number`);
  }

  if (parsedNumber > maximum) {
    throw new UsageError(`bad --${flagName}: ${numberText}, expected at most ${maximum}`);
  }

  return parsedNumber;
}

/** A path without an extension gets `.png`. */
function getScreenshotPath(screenshotText: string): string {
  const expectedText = 'expected a .png, .jpg or .jpeg file';

  if (screenshotText.trim() === '') {
    throw new UsageError(`bad --screenshot: empty path, ${expectedText}`);
  }

  if (statSync(screenshotText, { throwIfNoEntry: false })?.isDirectory() === true) {
    throw new UsageError(`bad --screenshot: ${screenshotText} is a directory, ${expectedText}`);
  }

  const extension = extname(screenshotText);
  if (extension === '') {
    return `${screenshotText}.png`;
  }

  if (!screenshotExtensions.includes(extension.toLowerCase())) {
    throw new UsageError(`bad --screenshot: ${screenshotText}, ${expectedText}`);
  }

  return screenshotText;
}

/** Checks that the nearest existing ancestor is a writable directory, then creates the missing levels one at a time. */
async function createWritableDirectory(flagName: string, directoryPath: string): Promise<void> {
  const missingDirectoryPaths: string[] = [];
  let existingPath = resolve(directoryPath);

  while (!existsSync(existingPath)) {
    missingDirectoryPaths.unshift(existingPath);
    existingPath = dirname(existingPath);
  }

  if (!statSync(existingPath).isDirectory()) {
    throw new UsageError(`bad --${flagName}: ${existingPath} is a file, not a directory`);
  }

  try {
    await access(existingPath, constants.W_OK);

    for (const missingDirectoryPath of missingDirectoryPaths) {
      await mkdir(missingDirectoryPath);
    }
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code ?? getFirstLine(error);
    throw new UsageError(`bad --${flagName}: cannot write to ${directoryPath}, ${errorCode}`);
  }
}

function getFirstLine(error: unknown): string {
  return String(error instanceof Error ? error.message : error).split('\n')[0];
}

/** Closes the browser on ctrl-c, SIGTERM or SIGHUP and exits quietly with 128 plus the signal number. */
function exitOnSignals(session: Session): void {
  for (const [signalName, exitCode] of Object.entries(exitCodeBySignal)) {
    process.once(signalName, () => {
      signalExitCode = exitCode;
      void session.close().finally(() => process.exit(exitCode));
    });
  }
}

const reportDetails: ReportDetail[] = ['tree', 'findings', 'summary', 'changes', 'none'];

function parseReportDetail(reportText: string): ReportDetail {
  const reportDetail = reportDetails.find((detail) => detail === reportText);
  if (reportDetail === undefined) {
    throw new UsageError(`bad --report: ${reportText}, expected tree, findings, summary, changes or none`);
  }

  return reportDetail;
}

/** A script argument is a file when it exists, or when it is one path-like word ending in a script extension. */
async function loadScript(scriptArgument: string): Promise<{ script: string | PageScript; scriptCacheText: string }> {
  const isScriptFilePath = existsSync(scriptArgument) || /^[\w./\\~-]+\.(m?js|ts)$/.test(scriptArgument);
  if (!isScriptFilePath) {
    return { script: scriptArgument, scriptCacheText: scriptArgument };
  }

  const scriptPath = resolve(scriptArgument);
  if (!existsSync(scriptPath)) {
    throw new UsageError(`script file not found: ${scriptArgument}`);
  }

  const scriptCacheText = await readFile(scriptPath, 'utf8');
  let scriptModule: { default?: unknown };

  try {
    scriptModule = await import(pathToFileURL(scriptPath).href);
  } catch (error) {
    const errorName = error instanceof Error ? error.name : 'Error';
    throw new CommandLineError(2, `script failed: ${errorName}: ${getFirstLine(error)}`);
  }

  if (typeof scriptModule.default !== 'function') {
    throw new UsageError(`script file has no default export function: ${scriptArgument}`);
  }

  return { script: scriptModule.default as PageScript, scriptCacheText };
}

/** Keeps each run's facts line and summary block from the formatted report. */
function getFactsAndSummaryLines(reportText: string): string[] {
  const keptLines: string[] = [];

  for (const runBlock of reportText.split('\n\n')) {
    const blockLines = runBlock.split('\n');

    keptLines.push(blockLines[0]);

    const summaryStartIndex = blockLines.findIndex((line) => line.startsWith('summary:'));
    if (summaryStartIndex === -1) continue;

    keptLines.push(blockLines[summaryStartIndex]);

    for (const line of blockLines.slice(summaryStartIndex + 1)) {
      if (!line.startsWith('  ')) break;

      keptLines.push(line);
    }
  }

  return keptLines;
}

async function runMeasure(commandArguments: string[]): Promise<number> {
  const { values: flagValues, positionals: targetArguments } = parseArgs({
    args: commandArguments,
    allowPositionals: true,
    strict: true,
    options: {
      'viewport': { type: 'string' },
      'scheme': { type: 'string' },
      'dpr': { type: 'string' },
      'scroll': { type: 'string' },
      'script': { type: 'string' },
      'wait': { type: 'string' },
      'element': { type: 'string' },
      'no-children': { type: 'boolean', default: false },
      'colors': { type: 'boolean', default: false },
      'report': { type: 'string', default: 'tree' },
      'aria': { type: 'boolean', default: false },
      'screenshot': { type: 'string' },
      'json': { type: 'boolean', default: false },
      'out': { type: 'string' },
      'max-chars': { type: 'string' },
      'timeout': { type: 'string' },
      'channel': { type: 'string' },
      'no-reveal': { type: 'boolean', default: false },
      'no-diff': { type: 'boolean', default: false },
      'diff-key': { type: 'string' },
      'help': { type: 'boolean', short: 'h', default: false },
    },
  });

  if (flagValues.help) {
    console.log(usageText);
    return 0;
  }

  if (targetArguments.length !== 1) {
    throw new UsageError(
      targetArguments.length === 0 ? 'missing target, run pxtree --help' : `one target expected, got ${targetArguments.join(' ')}`,
    );
  }

  const targetUrl = getTargetUrl(targetArguments[0]);
  const isFileTarget = URL.canParse(targetUrl) && new URL(targetUrl).protocol === 'file:';
  const isDirectoryTarget = isFileTarget && statSync(fileURLToPath(targetUrl), { throwIfNoEntry: false })?.isDirectory() === true;
  if (isDirectoryTarget) {
    throw new UsageError(`target is a directory: ${targetArguments[0]}`);
  }

  const reportDetail = parseReportDetail(flagValues.report);

  if (reportDetail === 'none' && !flagValues.aria && flagValues.screenshot === undefined) {
    throw new UsageError('--report none prints nothing without --aria or --screenshot');
  }

  const measureOptions: MeasureOptions = {
    shouldIncludeChildren: !flagValues['no-children'],
    shouldReveal: !flagValues['no-reveal'],
    elementSelector: flagValues.element,
    shouldCaptureAriaSnapshot: flagValues.aria,
    shouldMeasurePage: reportDetail !== 'none',
    diffKey: flagValues['diff-key'],
    scroll: flagValues.scroll,
    wait: flagValues.wait,
  };

  const formatOptions: FormatOptions = {
    shouldShowColors: flagValues.colors,
    report: reportDetail,
  };

  if (flagValues.viewport !== undefined) {
    measureOptions.viewports = parseViewports(flagValues.viewport);
  }

  if (flagValues.scheme !== undefined) {
    measureOptions.colorSchemes = parseColorSchemes(flagValues.scheme);
  }

  if (flagValues.dpr !== undefined) {
    measureOptions.devicePixelRatio = parsePositiveNumber('dpr', flagValues.dpr, maxDevicePixelRatio);
  }

  if (flagValues.timeout !== undefined) {
    measureOptions.timeoutMs = parsePositiveNumber('timeout', flagValues.timeout, maxTimeoutMs);
  }

  if (flagValues['max-chars'] !== undefined) {
    formatOptions.maxCharacters = Math.floor(parsePositiveNumber('max-chars', flagValues['max-chars'], Infinity));
  }

  if (flagValues['no-diff']) {
    measureOptions.cacheDirectory = null;
  }

  if (flagValues.screenshot !== undefined) {
    measureOptions.screenshotPath = getScreenshotPath(flagValues.screenshot);
    await createWritableDirectory('screenshot', dirname(measureOptions.screenshotPath));
  }

  if (flagValues.out !== undefined) {
    await createWritableDirectory('out', flagValues.out);
  }

  if (flagValues.script !== undefined) {
    Object.assign(measureOptions, await loadScript(flagValues.script));
  }

  const session = await createSession({ channel: flagValues.channel });
  exitOnSignals(session);

  try {
    const result = await session.measure(targetArguments[0], measureOptions);

    if (signalExitCode !== null) {
      return signalExitCode;
    }

    if (result.error !== null) {
      if (flagValues.json) {
        console.log(JSON.stringify(result));
      }

      console.error(result.error.message);
      return result.error.kind === 'launch' ? 3 : 2;
    }

    if (flagValues.out !== undefined) {
      const reportText = format(result, formatOptions);
      const textPath = join(flagValues.out, 'pxtree.txt');
      const jsonPath = join(flagValues.out, 'pxtree.json');

      await writeFile(textPath, `${reportText}\n`);
      await writeFile(jsonPath, JSON.stringify(result));

      console.log([...getFactsAndSummaryLines(reportText), textPath, jsonPath].join('\n'));
    } else if (flagValues.json) {
      console.log(JSON.stringify(result));
    } else {
      console.log(format(result, formatOptions));
    }

    const hasNoElementMatch = result.runs.some((run) => run.page?.element?.matchedCount === 0);

    if (hasNoElementMatch) {
      console.error(`no element matches ${flagValues.element}`);
      return 2;
    }

    return 0;
  } finally {
    await session.close();
  }
}

async function main(): Promise<void> {
  const commandArguments = process.argv.slice(2);

  try {
    if (commandArguments[0] === 'guide') {
      if (commandArguments.length > 1) {
        throw new UsageError(`guide takes no arguments, got ${commandArguments.slice(1).join(' ')}`);
      }

      process.stdout.write(readingGuideText);
      return;
    }

    if (commandArguments[0] === 'help') {
      console.log(usageText);
      return;
    }

    if (commandArguments[0] === 'mcp') {
      const { runMcpServer } = await import('./mcp.ts');
      await runMcpServer();
      return;
    }

    process.exitCode = await runMeasure(commandArguments);
  } catch (error) {
    if (signalExitCode !== null) {
      return;
    }

    if (error instanceof CommandLineError) {
      console.error(error.message);
      process.exitCode = error.exitCode;
      return;
    }

    const isParseArgsError = (error as { code?: string }).code?.startsWith('ERR_PARSE_ARGS') === true;
    if (!isParseArgsError) {
      throw error;
    }

    console.error((error as Error).message);
    process.exitCode = 1;
  }
}

await main();
