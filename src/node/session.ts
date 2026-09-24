import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { Script } from 'node:vm';
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from 'playwright-core';
import { analyze } from '../findings/findings.ts';
import { createSnapshot } from '../format/diff.ts';
import { getPrintableText, getScreenshotClip } from '../format/format.ts';
import type {
  AriaMatchVisibility,
  ColorScheme,
  FontFallback,
  FontRequest,
  MeasureOptions,
  MeasurePageOptions,
  MeasureResult,
  PageMeasurement,
  PageScript,
  PxtreeInPage,
  RunResult,
  ScrollStop,
  Session,
  SessionOptions,
  SettleReport,
  Viewport,
} from '../types.ts';
import { getDefaultCacheDirectory, getSnapshotKey, readSnapshot, writeSnapshot } from './cache.ts';

type PxtreeGlobal = typeof globalThis & { __pxtree: PxtreeInPage };

const maxNodes = 20000;
const maxSamples = 21000;
const settleMaxWaitMs = 1000;
const revealMaxSteps = 30;
const revealMaxImageWaitMs = 2000;
const loadEventMaxWaitMs = 2000;
const networkQuietMaxWaitMs = 1500;
const selectorWaitGraceMs = 1000;
const maxFollowedNavigationCount = 5;

const maxFontStackCount = 20;

/** What loading a viewport and running the script found. */
interface LoadFacts {
  status: number | null;
  isPageUnchangedByScript: boolean;
}

type MeasureErrorKind = 'launch' | 'load' | 'script' | 'measure';

class MeasureError extends Error {
  kind: MeasureErrorKind;

  constructor(kind: MeasureErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

function getFirstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  return message.split('\n')[0].trim();
}

function getPlaywrightVersion(): string {
  const require = createRequire(import.meta.url);

  return (require('playwright-core/package.json') as { version: string }).version;
}

function getLaunchFailureMessage(error: unknown, channel: string | undefined): string {
  const firstLine = getFirstLine(error);
  const isBrowserMissing = channel === undefined && firstLine.includes("Executable doesn't exist");
  if (isBrowserMissing) {
    return `could not launch chromium, run: npx -y playwright@${getPlaywrightVersion()} install chromium`;
  }

  return `could not launch ${channel ?? 'chromium'}: ${firstLine}`;
}

function isDownloadError(error: unknown): boolean {
  return getFirstLine(error).includes('Download is starting');
}

function getLoadFailureMessage(error: unknown, url: string, target: string): string {
  const reason = getFirstLine(error)
    .replace(/^page\.goto: /, '')
    .replace(/ at \S+$/, '');

  if (isDownloadError(error)) {
    return `target is a download, not a page: ${url}`;
  }

  const trimmedTarget = target.trim();
  const isBareTarget = url === `http://${trimmedTarget}`;

  if (isBareTarget && reason.includes('ERR_NAME_NOT_RESOLVED')) {
    return `could not load ${trimmedTarget}: no file at that path and no host named ${new URL(url).hostname}`;
  }

  return `could not load ${url}: ${reason}`;
}

/**
 * The URL that `measure` loads for a target. A URL stays as it is. A host like `localhost:3000` gets `http://`.
 * A file path becomes a `file:` URL resolved from the working directory. A `?query` or `#fragment` after a file path
 * stays on the URL, unless a file with that whole name exists. Whitespace around the target is ignored.
 */
export function getTargetUrl(target: string): string {
  const trimmedTarget = target.trim();
  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmedTarget) || /^(about|data|blob):/i.test(trimmedTarget);
  if (hasScheme) {
    return trimmedTarget;
  }

  const suffixPosition = existsSync(trimmedTarget) ? -1 : trimmedTarget.search(/[?#]/);
  const filePath = suffixPosition === -1 ? trimmedTarget : trimmedTarget.slice(0, suffixPosition);
  const urlSuffix = suffixPosition === -1 ? '' : trimmedTarget.slice(suffixPosition);
  const isFilePath = /^[./~]/.test(filePath) || /\.x?html?$/i.test(filePath) || existsSync(filePath);

  return isFilePath ? pathToFileURL(resolve(filePath)).href + urlSuffix : `http://${trimmedTarget}`;
}

/** A target, wait or timeout that cannot work, found before the browser starts. null when there is none. */
function getInputError(target: string, url: string, wait: number | string | undefined, timeoutMs: number): MeasureError | null {
  if (target.trim() === '') {
    return new MeasureError('load', 'target is empty');
  }

  if (isDirectoryTargetUrl(url)) {
    return new MeasureError('load', `target is a directory: ${target.trim()}`);
  }

  if (typeof wait === 'number' && wait > timeoutMs) {
    return new MeasureError('script', `wait failed: ${wait} ms is longer than the timeout of ${timeoutMs} ms`);
  }

  return null;
}

function getUniqueViewports(viewports: Viewport[]): Viewport[] {
  const viewportBySize = new Map(viewports.map((viewport) => [`${viewport.width}x${viewport.height}`, viewport]));

  return [...viewportBySize.values()];
}

/** True when a target URL is a file URL that names a directory. */
export function isDirectoryTargetUrl(targetUrl: string): boolean {
  return isFileUrl(targetUrl) && statSync(fileURLToPath(targetUrl), { throwIfNoEntry: false })?.isDirectory() === true;
}

/** The URL loading ended on, or null when it is the target. A trailing slash and a default port do not count. */
export function getRedirectedUrl(targetUrl: string, finalUrl: string): string | null {
  const getComparableUrl = (url: string) => {
    const parsedUrl = new URL(url);
    parsedUrl.pathname = parsedUrl.pathname.replace(/\/+$/, '');

    return parsedUrl.href;
  };

  try {
    return getComparableUrl(targetUrl) === getComparableUrl(finalUrl) ? null : finalUrl;
  } catch {
    return null;
  }
}

/** Makes every string that the page controls printable, at the point where the measurement leaves the page. */
function makePageTextPrintable(measurement: PageMeasurement): void {
  for (const node of measurement.nodes) {
    node.name = getPrintableText(node.name);
    node.text = getPrintableText(node.text);
  }

  measurement.failedFontFamilies = measurement.failedFontFamilies.map(getPrintableText);
}

/** Several runs get a `-WxH-scheme` suffix, and several scroll stops add `-scroll-N` to it. */
function getScreenshotPath(basePath: string, viewport: Viewport, colorScheme: ColorScheme, hasSeveralRuns: boolean, scrollStopNumber: number | null): string {
  if (!hasSeveralRuns) {
    return basePath;
  }

  const extension = extname(basePath);
  const pathWithoutExtension = basePath.slice(0, basePath.length - extension.length);
  const scrollStopSuffix = scrollStopNumber === null ? '' : `-scroll-${scrollStopNumber}`;

  return `${pathWithoutExtension}-${viewport.width}x${viewport.height}-${colorScheme}${scrollStopSuffix}${extension}`;
}

/** Splits at commas outside parentheses, brackets and quotes, so a selector like `:is(h2, h3)` stays one item. */
export function splitTopLevelCommas(listText: string): string[] {
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

/** A string stop like '0,900,end' is a list of stops, like the CLI flag. */
function getScrollStops(scroll: MeasureOptions['scroll']): ScrollStop[] {
  const scrollStops: ScrollStop[] = scroll === undefined ? [] : [scroll].flat();
  const splitScrollStops = scrollStops.flatMap((scrollStop): ScrollStop[] =>
    typeof scrollStop === 'string' ? splitTopLevelCommas(scrollStop).map((stopText) => stopText.trim()) : [scrollStop],
  );

  return splitScrollStops.length === 0 ? [0] : splitScrollStops.map(normalizeScrollStop);
}

/** Turns a digit string like '900' or '900px' into a number. Any other string stays as it is. */
function normalizeDigitString(value: number | string, unitSuffix: string): number | string {
  if (typeof value === 'number') {
    return value;
  }

  const digitMatch = new RegExp(`^(\\d+)(?:${unitSuffix})?$`, 'i').exec(value.trim());

  return digitMatch === null ? value : Number(digitMatch[1]);
}

function normalizeScrollStop(scrollStop: ScrollStop): ScrollStop {
  return normalizeDigitString(scrollStop, 'px');
}

/** `SyntaxError: Unexpected token '}' at 2:1` for source that does not parse, with the position in the script. null when it parses. */
function getSyntaxErrorText(source: string, addedLineCount: number, addedColumnCount: number): string | null {
  try {
    new Script(source, { filename: 'script' });
    return null;
  } catch (error) {
    const stackLines = error instanceof Error ? (error.stack ?? '').split('\n') : [];
    const lineNumber = Number(/^script:(\d+)/.exec(stackLines[0] ?? '')?.[1] ?? 0) - addedLineCount;
    const caretColumn = (stackLines[2] ?? '').indexOf('^') + 1;
    const columnNumber = lineNumber === 1 ? caretColumn - addedColumnCount : caretColumn;
    const positionText = lineNumber > 0 && caretColumn > 0 ? ` at ${lineNumber}:${columnNumber}` : '';

    return `SyntaxError: ${getFirstLine(error)}${positionText}`;
  }
}

const functionScriptPattern = /^(async\s+)?(function\b|\([^()]*\)\s*=>|[\w$]+\s*=>)/;

/**
 * A script string is either the body of `async (page) => {}` or a whole function like `async (page) => {}`.
 * A function is called with the page. Anything that parses as neither fails with the syntax error of the body.
 */
function createPageScript(script: string | PageScript): PageScript {
  if (typeof script === 'function') {
    return script;
  }

  const trimmedScript = script.trim();
  const functionSource = `(${trimmedScript}\n)`;
  const isFunctionScript = functionScriptPattern.test(trimmedScript) && getSyntaxErrorText(functionSource, 0, 1) === null;

  if (isFunctionScript) {
    const scriptFunction: unknown = new Function(`return ${functionSource};`)();

    if (typeof scriptFunction === 'function') {
      return scriptFunction as PageScript;
    }
  }

  const bodySyntaxErrorText = getSyntaxErrorText(`(async function (page) {\n${script}\n})`, 1, 0);
  if (bodySyntaxErrorText !== null) {
    throw new MeasureError('script', `script failed: not a function body or a function, ${bodySyntaxErrorText}`);
  }

  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (parameterName: string, body: string) => PageScript;

  return new AsyncFunction('page', script);
}

async function takeScreenshot(page: Page, path: string, measurement: PageMeasurement | null): Promise<void> {
  const clip = measurement === null ? null : getScreenshotClip(measurement);

  await page.screenshot(clip === null ? { path } : { path, clip });
}

interface AriaMatch {
  ariaSnapshot: string;
  visibility: AriaMatchVisibility;
}

/** One snapshot for the page, or one per element match, each with what its element shows. */
async function getAriaSnapshots(page: Page, elementSelector: string | undefined): Promise<AriaMatch[]> {
  if (elementSelector === undefined) {
    return [{ ariaSnapshot: await page.ariaSnapshot(), visibility: 'shown' }];
  }

  const elementLocators = await page.locator(`css=${elementSelector}`).all();

  return Promise.all(
    elementLocators.map(async (elementLocator) => ({
      ariaSnapshot: await elementLocator.ariaSnapshot(),
      visibility: await elementLocator.evaluate((element): AriaMatchVisibility => {
        if (!element.checkVisibility()) {
          return 'not-rendered';
        }

        return element.checkVisibility({ visibilityProperty: true, opacityProperty: true }) ? 'shown' : 'not-painted';
      }),
    })),
  );
}

async function getPageStateText(page: Page): Promise<string> {
  return page.evaluate(() => (globalThis as PxtreeGlobal).__pxtree.getPageStateText());
}

function isFileUrl(url: string): boolean {
  return URL.canParse(url) && new URL(url).protocol === 'file:';
}

/** Waits a short while for the load event, then for a quiet network unless the page is a file. */
async function waitForLoadAndQuietNetwork(page: Page): Promise<void> {
  await page.waitForLoadState('load', { timeout: loadEventMaxWaitMs }).catch(() => {});

  if (!isFileUrl(page.url())) {
    await page.waitForLoadState('networkidle', { timeout: networkQuietMaxWaitMs }).catch(() => {});
  }
}

/** Tries the load twice when the first attempt fails early. Both attempts share one timeout budget. */
async function loadTarget(page: Page, url: string, target: string, timeoutMs: number): Promise<number | null> {
  let lastError: unknown = null;
  const loadDeadline = Date.now() + timeoutMs;

  for (let attempt = 0; attempt < 2; attempt++) {
    const remainingMs = loadDeadline - Date.now();
    if (remainingMs <= 0) break;

    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: remainingMs });
      await waitForLoadAndQuietNetwork(page);

      return response?.status() ?? null;
    } catch (error) {
      lastError = error;
      if (isDownloadError(error) || getFirstLine(error).includes('ERR_NAME_NOT_RESOLVED')) break;
    }
  }

  throw new MeasureError('load', getLoadFailureMessage(lastError, url, target));
}

/** Counts navigations of the main frame and tells whether one has started but not committed yet. */
interface NavigationTracker {
  navigationCount: number;
  hasPendingNavigation: boolean;
}

function createNavigationTracker(page: Page): NavigationTracker {
  const navigationTracker: NavigationTracker = { navigationCount: 0, hasPendingNavigation: false };

  page.on('request', (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      navigationTracker.navigationCount++;
      navigationTracker.hasPendingNavigation = true;
    }
  });

  page.on('requestfailed', (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      navigationTracker.hasPendingNavigation = false;
    }
  });

  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      navigationTracker.hasPendingNavigation = false;
    }
  });

  return navigationTracker;
}

/**
 * Runs one phase of a measurement and gives up with a clean error when it takes longer than phaseTimeoutMs.
 * The caller closes the context after the error. That also rejects the page call that still hangs.
 */
async function runPhase<T>(phaseName: string, phaseTimeoutMs: number, runOperation: () => Promise<T>): Promise<T> {
  const operation = runOperation();
  let timeoutHandle: NodeJS.Timeout | undefined;

  operation.catch(() => {});

  const timeout = new Promise<never>((_resolve, reject) => {
    const timeoutMessage = `measurement timed out after ${Math.round(phaseTimeoutMs)} ms during ${phaseName}`;
    timeoutHandle = setTimeout(() => reject(new MeasureError('measure', timeoutMessage)), phaseTimeoutMs);
  });

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function measureInPage(page: Page, measurePageOptions: MeasurePageOptions): Promise<PageMeasurement> {
  return page.evaluate((pageOptions) => (globalThis as PxtreeGlobal).__pxtree.measurePage(pageOptions), measurePageOptions);
}

type SelectorOptionName = 'element' | 'scroll' | 'wait';

const scrollStopText = 'a y offset of 0 or more, end, or a selector';

const acceptedValueTextByOptionName: Record<SelectorOptionName, string> = {
  element: 'a valid selector',
  scroll: scrollStopText,
  wait: 'milliseconds or a valid selector',
};

function getInvalidSelectorMessage(optionName: SelectorOptionName, selector: string): string {
  const printedSelector = selector === '' ? "''" : selector;

  return `${optionName} failed: ${printedSelector} is not ${acceptedValueTextByOptionName[optionName]}`;
}

/** Checks the element, scroll and wait selectors on the blank page before loading, so a bad selector fails fast with one line. */
async function checkSelectors(
  page: Page,
  elementSelector: string | undefined,
  scrollStops: ScrollStop[],
  wait: number | string | undefined,
): Promise<void> {
  const selectorsByOptionName: Array<[SelectorOptionName, string]> = [];

  if (elementSelector !== undefined) {
    selectorsByOptionName.push(['element', elementSelector]);
  }

  for (const scrollStop of scrollStops) {
    if (typeof scrollStop === 'string' && scrollStop !== 'end') {
      selectorsByOptionName.push(['scroll', scrollStop]);
    }
  }

  if (typeof wait === 'string') {
    selectorsByOptionName.push(['wait', wait]);
  }

  for (const [optionName, selector] of selectorsByOptionName) {
    const isValidSelector = await page.evaluate((checkedSelector) => {
      try {
        document.querySelector(checkedSelector);
        return true;
      } catch {
        return false;
      }
    }, selector);

    if (!isValidSelector) {
      throw new MeasureError('script', getInvalidSelectorMessage(optionName, selector));
    }
  }
}

/** Maps a failure that is not a MeasureError, like a closed browser or a navigation that destroyed the page, to one. null when it is not known. */
function getKnownMeasureError(error: unknown, isBrowserConnected: boolean): MeasureError | null {
  const firstLine = getFirstLine(error);

  if (!isBrowserConnected) {
    return new MeasureError('launch', `browser closed while measuring: ${firstLine}`);
  }

  if (error instanceof MeasureError) {
    return error;
  }

  if (firstLine.includes('Execution context was destroyed')) {
    return new MeasureError('script', `the page navigated while measuring, wait for it in the script: ${firstLine}`);
  }

  return null;
}

interface PlatformFont {
  familyName: string;
  isCustomFont: boolean;
  glyphCount: number;
}

/** The platform font that drew the most glyphs. */
function getMainFont(platformFonts: PlatformFont[]): PlatformFont | null {
  let mainFont: PlatformFont | null = null;

  for (const platformFont of platformFonts) {
    if (mainFont === null || platformFont.glyphCount > mainFont.glyphCount) {
      mainFont = platformFont;
    }
  }

  return mainFont;
}

function isRequestedFontDrawn(fontRequest: FontRequest, mainFont: PlatformFont): boolean {
  const isSameFamily = mainFont.familyName.toLowerCase() === fontRequest.requestedFamily?.toLowerCase();

  return isSameFamily || (mainFont.isCustomFont && fontRequest.isWebFontLoaded);
}

/**
 * Asks Chromium which platform font drew one text element per font stack. Only stacks whose first named family is a
 * web font of the page count. A local family like Arial is swapped for a look-alike on some systems, which says nothing about the page.
 */
async function getFontFallbacks(page: Page): Promise<FontFallback[]> {
  const cdpSession = await page.context().newCDPSession(page);

  try {
    const { result: sampleArray } = await cdpSession.send('Runtime.evaluate', {
      expression: `globalThis.__pxtree.getFontSampleElements({ maxStackCount: ${maxFontStackCount} })`,
    });
    if (sampleArray.objectId === undefined) {
      return [];
    }

    const { result: requestsResult } = await cdpSession.send('Runtime.callFunctionOn', {
      objectId: sampleArray.objectId,
      functionDeclaration: 'function () { return globalThis.__pxtree.getFontRequests(this); }',
      returnByValue: true,
    });
    const fontRequests = requestsResult.value as FontRequest[];
    if (!fontRequests.some((fontRequest) => fontRequest.isWebFont)) {
      return [];
    }

    const { result: sampleProperties } = await cdpSession.send('Runtime.getProperties', { objectId: sampleArray.objectId, ownProperties: true });
    await cdpSession.send('DOM.getDocument', { depth: 0 });
    await cdpSession.send('CSS.enable');

    const fontFallbacks: FontFallback[] = [];

    for (const [samplePosition, fontRequest] of fontRequests.entries()) {
      const elementObjectId = sampleProperties.find((property) => property.name === String(samplePosition))?.value?.objectId;
      if (!fontRequest.isWebFont || fontRequest.requestedFamily === null || elementObjectId === undefined) continue;

      const { nodeId } = await cdpSession.send('DOM.requestNode', { objectId: elementObjectId });
      const { fonts } = await cdpSession.send('CSS.getPlatformFontsForNode', { nodeId });
      const mainFont = getMainFont(fonts);
      if (mainFont === null || isRequestedFontDrawn(fontRequest, mainFont)) continue;

      const requestedFamily = getPrintableText(fontRequest.requestedFamily);
      const drawnFamily = getPrintableText(mainFont.familyName);
      const isKnown = fontFallbacks.some((fallback) => fallback.requestedFamily === requestedFamily && fallback.drawnFamily === drawnFamily);

      if (!isKnown) {
        fontFallbacks.push({ requestedFamily, drawnFamily });
      }
    }

    return fontFallbacks;
  } finally {
    await cdpSession.detach();
  }
}

async function settlePage(page: Page): Promise<SettleReport> {
  const settle = await page.evaluate((maxWaitMs) => (globalThis as PxtreeGlobal).__pxtree.settlePage({ maxWaitMs }), settleMaxWaitMs);

  return { stillMovingName: settle.stillMovingName === null ? null : getPrintableText(settle.stillMovingName) };
}

async function scrollPage(page: Page, scrollStop: ScrollStop): Promise<void> {
  if (typeof scrollStop === 'number') {
    await page.evaluate((top) => window.scrollTo({ top, behavior: 'instant' }), scrollStop);
    return;
  }

  if (scrollStop === 'end') {
    await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
    return;
  }

  const isScrolled = await page.evaluate((selector) => (globalThis as PxtreeGlobal).__pxtree.scrollToElement(selector), scrollStop);

  if (!isScrolled) {
    throw new MeasureError('script', `scroll failed: no element matches ${scrollStop}, a stop is ${scrollStopText}`);
  }
}

/** The first line of a script error, and the selector that a Playwright action waited for when it names one. */
function getScriptFailureText(error: unknown): string {
  const errorName = error instanceof Error ? error.name : 'Error';
  const message = stripVTControlCharacters(error instanceof Error ? error.message : String(error));
  const waitingLine = message.split('\n').find((line) => line.trim().startsWith('- waiting for'));
  const failureText = waitingLine === undefined ? getFirstLine(error) : `${getFirstLine(error).replace(/\.$/, '')}, ${waitingLine.trim().slice(2)}`;

  return `script failed: ${errorName}: ${failureText}`;
}

/** Runs the script, then waits for the load of any page that the script navigated to. */
async function runPageScript(page: Page, pageScript: PageScript): Promise<void> {
  try {
    await pageScript(page);
    await page.waitForLoadState('load');
  } catch (error) {
    throw new MeasureError('script', page.isClosed() ? 'script failed: the script closed the page' : getScriptFailureText(error));
  }
}

function getFrameText(page: Page): string {
  const frameCount = page.frames().length - 1;

  return frameCount === 0 ? '' : `, ${frameCount} ${frameCount === 1 ? 'frame is' : 'frames are'} not searched`;
}

async function waitAfterScript(page: Page, wait: number | string, timeoutMs: number): Promise<void> {
  if (typeof wait === 'number') {
    await page.waitForTimeout(wait);
    return;
  }

  try {
    await page.waitForSelector(wait, { state: 'visible', timeout: timeoutMs });
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === 'TimeoutError';
    const reasonText = isTimeout ? `no visible element matches ${wait} after ${timeoutMs} ms${getFrameText(page)}` : getFirstLine(error);

    throw new MeasureError('script', `wait failed: ${reasonText}`);
  }
}

/**
 * Creates a session that keeps one browser alive across `measure` calls.
 * The browser launches on the first `measure` call. A launch failure is returned as `error.kind === 'launch'`.
 * Each `measure` call uses one browser context and one page for all its viewports and color schemes.
 */
export async function createSession(sessionOptions: SessionOptions = {}): Promise<Session> {
  const browserBundle = readFileSync(new URL('./browser.js', import.meta.url), 'utf8');
  let browserPromise: Promise<Browser> | null = null;

  function getBrowser(): Promise<Browser> {
    if (browserPromise !== null) {
      return browserPromise;
    }

    const launchPromise: Promise<Browser> = chromium.launch({ channel: sessionOptions.channel }).then(
      (browser) => {
        browser.once('disconnected', () => {
          if (browserPromise === launchPromise) {
            browserPromise = null;
          }
        });

        return browser;
      },
      (error: unknown) => {
        browserPromise = null;
        throw error;
      },
    );

    browserPromise = launchPromise;

    return launchPromise;
  }

  let isMeasureRunning = false;

  async function measure(target: string, options: MeasureOptions = {}): Promise<MeasureResult> {
    if (isMeasureRunning) {
      throw new Error('measure already running, await the previous call');
    }

    isMeasureRunning = true;

    try {
      return await measureTarget(target, options);
    } finally {
      isMeasureRunning = false;
    }
  }

  async function measureTarget(target: string, options: MeasureOptions): Promise<MeasureResult> {
    const url = getTargetUrl(target);
    const runs: RunResult[] = [];
    const wait = options.wait === undefined ? undefined : normalizeDigitString(options.wait, 'ms');
    const timeoutMs = options.timeoutMs ?? 30000;
    const inputError = getInputError(target, url, wait, timeoutMs);

    if (inputError !== null) {
      return { target: url, runs, error: { kind: inputError.kind, message: inputError.message } };
    }

    let pageScript: PageScript | null;

    try {
      pageScript = options.script === undefined ? null : createPageScript(options.script);
    } catch (error) {
      return { target: url, runs, error: { kind: 'script', message: getFirstLine(error) } };
    }

    let browser: Browser;

    try {
      browser = await getBrowser();
    } catch (error) {
      return { target: url, runs, error: { kind: 'launch', message: getLaunchFailureMessage(error, sessionOptions.channel) } };
    }

    const viewports = getUniqueViewports(options.viewports ?? [{ width: 1280, height: 800 }]);
    const colorSchemes = [...new Set<ColorScheme>(options.colorSchemes ?? ['light'])];
    const devicePixelRatio = options.devicePixelRatio ?? 1;
    const scrollStops = getScrollStops(options.scroll);
    const hasSeveralScrollStops = scrollStops.length > 1;
    const shouldReveal = options.shouldReveal ?? true;
    const shouldIncludeChildren = options.shouldIncludeChildren ?? true;
    const scriptCacheText = options.scriptCacheText ?? (typeof options.script === 'string' ? options.script : null);
    const isScriptWithoutCacheKey = options.script !== undefined && scriptCacheText === null && options.diffKey === undefined;
    const requestedCacheDirectory = options.cacheDirectory === undefined ? getDefaultCacheDirectory() : options.cacheDirectory;
    const cacheDirectory = isScriptWithoutCacheKey ? null : requestedCacheDirectory;
    const cacheOffReason = isScriptWithoutCacheKey && requestedCacheDirectory !== null ? 'script has no text; pass diffKey' : null;
    const snapshotStateKey = options.diffKey === undefined ? [scriptCacheText, wait ?? null] : [options.diffKey];
    const snapshotSettingsKey = [shouldReveal, sessionOptions.channel ?? null];
    const hasSeveralRuns = viewports.length * scrollStops.length * colorSchemes.length > 1;
    const shouldCaptureAriaSnapshot = options.shouldCaptureAriaSnapshot ?? false;
    const shouldMeasurePage = (options.shouldMeasurePage ?? true) || cacheDirectory !== null || options.elementSelector !== undefined;
    const loadPhaseTimeoutMs = timeoutMs + loadEventMaxWaitMs + networkQuietMaxWaitMs;

    const measurePageOptions: MeasurePageOptions = {
      elementSelector: options.elementSelector ?? null,
      maxNodes,
      maxSamples,
    };

    let context: BrowserContext;

    try {
      context = await browser.newContext({ viewport: viewports[0], deviceScaleFactor: devicePixelRatio });
    } catch (error) {
      return { target: url, runs, error: { kind: 'launch', message: `could not open a browser context: ${getFirstLine(error)}` } };
    }

    /** Runs the script and the wait. Returns the page state from before the script, or null without a script. */
    async function runScriptAndWait(page: Page): Promise<string | null> {
      let stateTextBeforeScript: string | null = null;

      if (pageScript !== null) {
        const script = pageScript;

        stateTextBeforeScript = await runPhase('script', timeoutMs, async () => {
          const stateText = await getPageStateText(page);
          await runPageScript(page, script);

          return stateText;
        });
      }

      if (wait !== undefined) {
        await runPhase('wait', timeoutMs + selectorWaitGraceMs, () => waitAfterScript(page, wait, timeoutMs));
      }

      return stateTextBeforeScript;
    }

    /**
     * Runs an operation. When the page starts a navigation during it, like a redirect in a script or a meta refresh,
     * it waits for the new page to load and runs the operation again on that page.
     */
    async function runFollowingNavigations<T>(page: Page, navigationTracker: NavigationTracker, runOperation: () => Promise<T>): Promise<T> {
      for (let attemptCount = 0; attemptCount <= maxFollowedNavigationCount; attemptCount++) {
        if (attemptCount > 0 || navigationTracker.hasPendingNavigation) {
          await runPhase('load', loadPhaseTimeoutMs, () => waitForNavigatedPage(page, navigationTracker));
        }

        const navigationCountBefore = navigationTracker.navigationCount;

        try {
          const operationResult = await runOperation();

          if (navigationTracker.navigationCount === navigationCountBefore) {
            return operationResult;
          }
        } catch (error) {
          const hasNavigated =
            navigationTracker.navigationCount !== navigationCountBefore || getFirstLine(error).includes('Execution context was destroyed');

          if (!hasNavigated) {
            throw error;
          }
        }
      }

      throw new MeasureError('load', `the page kept navigating, gave up after ${maxFollowedNavigationCount} navigations at ${page.url()}`);
    }

    async function waitForNavigatedPage(page: Page, navigationTracker: NavigationTracker): Promise<void> {
      if (navigationTracker.hasPendingNavigation) {
        const isMainFrame = (frame: Frame) => frame === page.mainFrame();
        await page.waitForEvent('framenavigated', { predicate: isMainFrame, timeout: timeoutMs }).catch(() => {});
      }

      await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs });
      await waitForLoadAndQuietNetwork(page);
    }

    async function addPreviousSnapshot(run: RunResult): Promise<RunResult> {
      if (cacheDirectory === null || run.page === null || run.analysis === null) {
        return run;
      }

      const snapshotRunKey = [url, run.viewport.width, run.viewport.height, run.colorScheme, devicePixelRatio, run.scrollStop];
      const snapshotKey = getSnapshotKey([...snapshotRunKey, ...snapshotSettingsKey, ...snapshotStateKey]);
      const previousSnapshot = await readSnapshot(cacheDirectory, snapshotKey);
      await writeSnapshot(cacheDirectory, snapshotKey, createSnapshot(run.page, run.analysis));

      return { ...run, previousSnapshot };
    }

    async function measureRun(
      page: Page,
      requestedViewport: Viewport,
      scrollStopPosition: number,
      colorScheme: ColorScheme,
      loadFacts: LoadFacts,
      settle: SettleReport,
    ): Promise<RunResult> {
      const scrollStop = scrollStops[scrollStopPosition];
      const measurement = shouldMeasurePage ? await measureInPage(page, measurePageOptions) : null;
      const fontFallbacks = measurement === null ? [] : await getFontFallbacks(page);

      if (measurement !== null) {
        makePageTextPrintable(measurement);
      }

      let screenshotPath: string | null = null;

      if (options.screenshotPath !== undefined) {
        const scrollStopNumber = hasSeveralScrollStops ? scrollStopPosition + 1 : null;
        screenshotPath = getScreenshotPath(options.screenshotPath, requestedViewport, colorScheme, hasSeveralRuns, scrollStopNumber);
        await takeScreenshot(page, screenshotPath, measurement);
      }

      const ariaMatches = shouldCaptureAriaSnapshot ? await getAriaSnapshots(page, options.elementSelector) : null;
      const runWithoutMeasurement: RunResult = {
        viewport: page.viewportSize() ?? requestedViewport,
        colorScheme,
        scrollStop,
        status: loadFacts.status,
        settle,
        devicePixelRatio,
        page: null,
        analysis: null,
        previousSnapshot: null,
        isCacheEnabled: cacheDirectory !== null,
        cacheOffReason,
        screenshotPath,
        shouldIncludeChildren,
        ariaSnapshots: ariaMatches?.map((ariaMatch) => ariaMatch.ariaSnapshot) ?? null,
        ariaMatchVisibilities: ariaMatches?.map((ariaMatch) => ariaMatch.visibility) ?? null,
        isPageUnchangedByScript: loadFacts.isPageUnchangedByScript,
        redirectedUrl: getRedirectedUrl(url, page.url()),
        fontFallbacks,
      };

      if (measurement === null) {
        return runWithoutMeasurement;
      }

      return { ...runWithoutMeasurement, page: measurement, analysis: analyze(measurement) };
    }

    /** Settles, scrolls and measures one scroll stop, one run per scheme. */
    async function measureScrollStop(
      page: Page,
      viewport: Viewport,
      scrollStopPosition: number,
      loadFacts: LoadFacts,
      stateTextBeforeScript: string | null,
    ): Promise<RunResult[]> {
      await runPhase('settle', timeoutMs, async () => {
        await page.emulateMedia({ colorScheme: colorSchemes[0] });
        await settlePage(page);

        if (stateTextBeforeScript !== null) {
          loadFacts.isPageUnchangedByScript = stateTextBeforeScript === (await getPageStateText(page));
        }
      });

      const firstSettle = await runPhase('scroll', timeoutMs, async () => {
        await scrollPage(page, scrollStops[scrollStopPosition]);

        return settlePage(page);
      });

      const scrollStopRuns = [
        await runPhase('measure', timeoutMs, () => measureRun(page, viewport, scrollStopPosition, colorSchemes[0], loadFacts, firstSettle)),
      ];

      for (const colorScheme of colorSchemes.slice(1)) {
        const settle = await runPhase('settle', timeoutMs, async () => {
          await page.emulateMedia({ colorScheme });

          return settlePage(page);
        });

        scrollStopRuns.push(await runPhase('measure', timeoutMs, () => measureRun(page, viewport, scrollStopPosition, colorScheme, loadFacts, settle)));
      }

      return scrollStopRuns;
    }

    try {
      await context.addInitScript({ content: browserBundle });
      const page = await context.newPage();
      const navigationTracker = createNavigationTracker(page);
      page.setDefaultTimeout(timeoutMs / 4);

      await checkSelectors(page, options.elementSelector, scrollStops, wait);

      for (const viewport of viewports) {
        const status = await runPhase('load', loadPhaseTimeoutMs, async () => {
          await page.setViewportSize(viewport);
          await page.emulateMedia({ colorScheme: colorSchemes[0] });

          return loadTarget(page, url, target, timeoutMs);
        });

        const loadFacts: LoadFacts = { status, isPageUnchangedByScript: false };

        await runFollowingNavigations(page, navigationTracker, async () => {
          await runPhase('settle', timeoutMs, async () => {
            await page.evaluate(async () => {
              await document.fonts.ready;
            });
            await settlePage(page);
          });

          if (shouldReveal) {
            await runPhase('reveal', timeoutMs, () =>
              page.evaluate(
                (revealOptions) => (globalThis as PxtreeGlobal).__pxtree.revealByScrolling(revealOptions),
                { maxSteps: revealMaxSteps, maxImageWaitMs: revealMaxImageWaitMs },
              ),
            );
          }
        });

        for (const scrollStopPosition of scrollStops.keys()) {
          const stateTextBeforeScript = scrollStopPosition === 0 ? await runScriptAndWait(page) : null;
          const scrollStopRuns = await runFollowingNavigations(page, navigationTracker, () =>
            measureScrollStop(page, viewport, scrollStopPosition, loadFacts, stateTextBeforeScript),
          );

          for (const run of scrollStopRuns) {
            runs.push(await addPreviousSnapshot(run));
          }
        }
      }

      return { target: url, runs, error: null };
    } catch (error) {
      const measureError = getKnownMeasureError(error, browser.isConnected());
      if (measureError === null) {
        throw error;
      }

      return { target: url, runs, error: { kind: measureError.kind, message: measureError.message } };
    } finally {
      await context.close().catch(() => {});
    }
  }

  async function close(): Promise<void> {
    if (browserPromise === null) {
      return;
    }

    const browser = await browserPromise.catch(() => null);
    browserPromise = null;
    await browser?.close();
  }

  return { measure, close };
}

/** Measures a URL, host or file path in a one-shot session. Load, launch and script failures are returned in `error`, not thrown. */
export async function measure(target: string, options?: MeasureOptions): Promise<MeasureResult> {
  const session = await createSession();

  try {
    return await session.measure(target, options);
  } finally {
    await session.close();
  }
}
