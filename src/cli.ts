#!/usr/bin/env node
import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createSession, format, getTargetUrl, readingGuideText } from './index.ts';
import type { ColorScheme, FormatOptions, MeasureOptions, PageScript, ReportDetail, ScrollStop, Viewport } from './types.ts';

const usageText = `usage: pxtree <url|host|file> [flags]
       pxtree guide    print the reading guide
       pxtree mcp      run as an MCP server on stdio

  --viewport <WxH[,WxH...]>   default 1280x800; a width alone like 390 gets a matching height
  --scheme <light|dark|light,dark>
  --dpr <n>
  --scroll <y|end|selector[,...]>   one run per stop
  --script <file|code>
  --wait <ms|selector>
  --element <selector>
  --no-children
  --colors
  --report <tree|findings|summary|changes|none>   default tree
  --aria                      the aria tree after the report
  --screenshot <path>
  --json
  --out <dir>
  --timeout <ms>              default 30000
  --channel <name>
  --no-reveal
  --no-diff
  --diff-key <name>           since last run compares runs with the same name, with or without a script

flag examples and how to read the output, run: pxtree guide`;

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

function parsePositiveNumber(flagName: string, numberText: string): number {
  const parsedNumber = Number(numberText);
  if (numberText.trim() === '' || !Number.isFinite(parsedNumber) || parsedNumber <= 0) {
    throw new UsageError(`bad --${flagName}: ${numberText}, expected a positive number`);
  }

  return parsedNumber;
}

/** Splits at commas outside parentheses, brackets and quotes, so a selector like `:is(h2, h3)` stays one stop. */
function splitTopLevelCommas(listText: string): string[] {
  const listItems: string[] = [];
  let itemStart = 0;
  let nestingDepth = 0;
  let openQuote: string | null = null;

  for (let position = 0; position < listText.length; position++) {
    const character = listText[position];

    if (openQuote !== null) {
      if (character === openQuote) {
        openQuote = null;
      }
    } else if (character === '"' || character === "'") {
      openQuote = character;
    } else if (character === '(' || character === '[') {
      nestingDepth++;
    } else if (character === ')' || character === ']') {
      nestingDepth--;
    } else if (character === ',' && nestingDepth === 0) {
      listItems.push(listText.slice(itemStart, position));
      itemStart = position + 1;
    }
  }

  listItems.push(listText.slice(itemStart));

  return listItems;
}

/** A comma list of stops: a y offset, `end` for the bottom, or a selector. */
function parseScrollStops(scrollText: string): ScrollStop[] {
  return splitTopLevelCommas(scrollText).map((stopText) => {
    const trimmedStopText = stopText.trim();
    if (trimmedStopText === '') {
      throw new UsageError(`bad --scroll: ${scrollText}, expected stops like 0,900,end or '#pricing'`);
    }

    return /^\d+$/.test(trimmedStopText) ? Number(trimmedStopText) : trimmedStopText;
  });
}

const reportDetails: ReportDetail[] = ['tree', 'findings', 'summary', 'changes', 'none'];

function parseReportDetail(reportText: string): ReportDetail {
  const reportDetail = reportDetails.find((detail) => detail === reportText);
  if (reportDetail === undefined) {
    throw new UsageError(`bad --report: ${reportText}, expected tree, findings, summary, changes or none`);
  }

  return reportDetail;
}

function parseWait(waitText: string): number | string {
  return /^\d+$/.test(waitText) ? Number(waitText) : waitText;
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
    const firstMessageLine = String(error instanceof Error ? error.message : error).split('\n')[0];
    throw new CommandLineError(2, `script failed: ${errorName}: ${firstMessageLine}`);
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
      'timeout': { type: 'string' },
      'channel': { type: 'string' },
      'no-reveal': { type: 'boolean', default: false },
      'no-diff': { type: 'boolean', default: false },
      'diff-key': { type: 'string' },
      'help': { type: 'boolean', default: false },
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
  const isDirectoryTarget = targetUrl.startsWith('file:') && statSync(fileURLToPath(targetUrl), { throwIfNoEntry: false })?.isDirectory() === true;
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
    screenshotPath: flagValues.screenshot,
    shouldCaptureAriaSnapshot: flagValues.aria,
    shouldMeasurePage: reportDetail !== 'none',
    diffKey: flagValues['diff-key'],
  };

  if (flagValues.viewport !== undefined) {
    measureOptions.viewports = parseViewports(flagValues.viewport);
  }

  if (flagValues.scheme !== undefined) {
    measureOptions.colorSchemes = parseColorSchemes(flagValues.scheme);
  }

  if (flagValues.dpr !== undefined) {
    measureOptions.devicePixelRatio = parsePositiveNumber('dpr', flagValues.dpr);
  }

  if (flagValues.scroll !== undefined) {
    measureOptions.scroll = parseScrollStops(flagValues.scroll);
  }

  if (flagValues.wait !== undefined) {
    measureOptions.wait = parseWait(flagValues.wait);
  }

  if (flagValues.timeout !== undefined) {
    measureOptions.timeoutMs = parsePositiveNumber('timeout', flagValues.timeout);
  }

  if (flagValues['no-diff']) {
    measureOptions.cacheDirectory = null;
  }

  if (flagValues.script !== undefined) {
    Object.assign(measureOptions, await loadScript(flagValues.script));
  }

  const session = await createSession({ channel: flagValues.channel });

  try {
    const result = await session.measure(targetArguments[0], measureOptions);

    if (result.error !== null) {
      console.error(result.error.message);
      return result.error.kind === 'launch' ? 3 : 2;
    }

    const formatOptions: FormatOptions = {
      shouldShowColors: flagValues.colors,
      report: reportDetail,
    };

    if (flagValues.out !== undefined) {
      const reportText = format(result, formatOptions);
      const textPath = join(flagValues.out, 'pxtree.txt');
      const jsonPath = join(flagValues.out, 'pxtree.json');

      await mkdir(flagValues.out, { recursive: true });
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
      process.stdout.write(readingGuideText);
      return;
    }

    if (commandArguments[0] === 'mcp') {
      const { runMcpServer } = await import('./mcp.ts');
      await runMcpServer();
      return;
    }

    process.exitCode = await runMeasure(commandArguments);
  } catch (error) {
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
