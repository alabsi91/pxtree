import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
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
  Snapshot,
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

const maxFontStackCount = 20;

/** What loading a viewport and running the script found. The time budget of the measurement starts at budgetStartTime. */
interface LoadFacts {
  status: number | null;
  redirectedUrl: string | null;
  budgetStartTime: number;
  isPageUnchangedByScript: boolean;
}

type MeasureErrorKind = 'load' | 'script' | 'measure';

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

function getLoadFailureReason(error: unknown): string {
  return getFirstLine(error)
    .replace(/^page\.goto: /, '')
    .replace(/ at \S+$/, '');
}

/**
 * The URL that `measure` loads for a target. A URL stays as it is. A host like `localhost:3000` gets `http://`.
 * A file path becomes a `file:` URL resolved from the working directory. A `?query` or `#fragment` after a file path
 * stays on the URL, unless a file with that whole name exists.
 */
export function getTargetUrl(target: string): string {
  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(target) || /^(about|data|blob):/i.test(target);
  if (hasScheme) {
    return target;
  }

  const suffixPosition = existsSync(target) ? -1 : target.search(/[?#]/);
  const filePath = suffixPosition === -1 ? target : target.slice(0, suffixPosition);
  const urlSuffix = suffixPosition === -1 ? '' : target.slice(suffixPosition);
  const isFilePath = /^[./~]/.test(filePath) || /\.x?html?$/i.test(filePath) || existsSync(filePath);

  return isFilePath ? pathToFileURL(resolve(filePath)).href + urlSuffix : `http://${target}`;
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

function getScrollStops(scroll: MeasureOptions['scroll']): ScrollStop[] {
  const scrollStops = scroll === undefined ? [] : [scroll].flat();

  return scrollStops.length === 0 ? [0] : scrollStops.map(normalizeScrollStop);
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

function createPageScript(script: string | PageScript): PageScript {
  if (typeof script === 'function') {
    return script;
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

async function loadTarget(page: Page, url: string, timeoutMs: number): Promise<number | null> {
  let lastError: unknown = null;
  const isFileTarget = url.startsWith('file:');

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

      await page.waitForLoadState('load', { timeout: loadEventMaxWaitMs }).catch(() => {});

      if (!isFileTarget) {
        await page.waitForLoadState('networkidle', { timeout: networkQuietMaxWaitMs }).catch(() => {});
      }

      return response?.status() ?? null;
    } catch (error) {
      lastError = error;
    }
  }

  throw new MeasureError('load', `could not load ${url}: ${getLoadFailureReason(lastError)}`);
}

/** Runs measurePage in the page, and gives up with a clean error when it takes longer than the time that is left. */
async function measureInPage(page: Page, measurePageOptions: MeasurePageOptions, remainingMs: number): Promise<PageMeasurement> {
  const measurement = page.evaluate((pageOptions) => (globalThis as PxtreeGlobal).__pxtree.measurePage(pageOptions), measurePageOptions);
  let timeoutHandle: NodeJS.Timeout | undefined;

  // Closing the context after a timeout rejects the evaluation. Nothing waits for it then.
  measurement.catch(() => {});

  const timeout = new Promise<never>((_resolve, reject) => {
    const timeoutMessage = `measurement timed out after ${Math.round(remainingMs)} ms`;
    timeoutHandle = setTimeout(() => reject(new MeasureError('measure', timeoutMessage)), remainingMs);
  });

  try {
    return await Promise.race([measurement, timeout]);
  } finally {
    clearTimeout(timeoutHandle);
  }
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
  return page.evaluate((maxWaitMs) => (globalThis as PxtreeGlobal).__pxtree.settlePage({ maxWaitMs }), settleMaxWaitMs);
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

  const scrollOutcome = await page.evaluate((selector) => {
    let element: Element | null;
    try {
      element = document.querySelector(selector);
    } catch {
      return 'invalid-selector';
    }

    element?.scrollIntoView({ block: 'start', behavior: 'instant' });

    return element === null ? 'no-match' : 'scrolled';
  }, scrollStop);

  if (scrollOutcome === 'invalid-selector') {
    throw new MeasureError('script', `scroll failed: ${scrollStop} is not a valid selector`);
  }

  if (scrollOutcome === 'no-match') {
    throw new MeasureError('script', `scroll failed: no element matches ${scrollStop}`);
  }
}

async function runPageScript(page: Page, script: string | PageScript): Promise<void> {
  try {
    await createPageScript(script)(page);
  } catch (error) {
    const errorName = error instanceof Error ? error.name : 'Error';
    throw new MeasureError('script', `script failed: ${errorName}: ${getFirstLine(error)}`);
  }
}

async function waitAfterScript(page: Page, wait: number | string): Promise<void> {
  if (typeof wait === 'number') {
    await page.waitForTimeout(wait);
    return;
  }

  try {
    await page.waitForSelector(wait, { state: 'visible' });
  } catch (error) {
    throw new MeasureError('script', `wait failed: ${getFirstLine(error)}`);
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
    browserPromise ??= chromium.launch({ channel: sessionOptions.channel }).catch((error: unknown) => {
      browserPromise = null;
      throw error;
    });

    return browserPromise;
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

    let browser: Browser;

    try {
      browser = await getBrowser();
    } catch (error) {
      return { target: url, runs, error: { kind: 'launch', message: getLaunchFailureMessage(error, sessionOptions.channel) } };
    }

    const viewports = options.viewports ?? [{ width: 1280, height: 800 }];
    const colorSchemes = options.colorSchemes ?? ['light'];
    const devicePixelRatio = options.devicePixelRatio ?? 1;
    const scrollStops = getScrollStops(options.scroll);
    const hasSeveralScrollStops = scrollStops.length > 1;
    const wait = options.wait === undefined ? undefined : normalizeDigitString(options.wait, 'ms');
    const timeoutMs = options.timeoutMs ?? 30000;
    const shouldReveal = options.shouldReveal ?? true;
    const shouldIncludeChildren = options.shouldIncludeChildren ?? true;
    const cacheDirectory = options.cacheDirectory === undefined ? getDefaultCacheDirectory() : options.cacheDirectory;
    const scriptCacheText = options.scriptCacheText ?? (typeof options.script === 'string' ? options.script : null);
    const snapshotStateKey = options.diffKey === undefined ? [scriptCacheText, wait ?? null] : [options.diffKey];
    const hasSeveralRuns = viewports.length * scrollStops.length * colorSchemes.length > 1;
    const shouldCaptureAriaSnapshot = options.shouldCaptureAriaSnapshot ?? false;
    const shouldMeasurePage = (options.shouldMeasurePage ?? true) || cacheDirectory !== null || options.elementSelector !== undefined;

    const measurePageOptions: MeasurePageOptions = {
      elementSelector: options.elementSelector ?? null,
      maxNodes,
      maxSamples,
    };

    const context = await browser.newContext({ viewport: viewports[0], deviceScaleFactor: devicePixelRatio });

    /** Runs the script and the wait. Returns the page state from before the script, or null without a script. */
    async function runScriptAndWait(page: Page): Promise<string | null> {
      const stateTextBeforeScript = options.script === undefined ? null : await getPageStateText(page);

      if (options.script !== undefined) {
        await runPageScript(page, options.script);
      }

      if (wait !== undefined) {
        await waitAfterScript(page, wait);
      }

      return stateTextBeforeScript;
    }

    async function measureRun(
      page: Page,
      viewport: Viewport,
      scrollStopPosition: number,
      colorScheme: ColorScheme,
      loadFacts: LoadFacts,
      settle: SettleReport,
    ): Promise<RunResult> {
      const scrollStop = scrollStops[scrollStopPosition];
      const remainingMs = Math.max(0, timeoutMs - (Date.now() - loadFacts.budgetStartTime));
      const measurement = shouldMeasurePage ? await measureInPage(page, measurePageOptions, remainingMs) : null;
      const fontFallbacks = measurement === null ? [] : await getFontFallbacks(page);

      if (measurement !== null) {
        makePageTextPrintable(measurement);
      }

      let screenshotPath: string | null = null;

      if (options.screenshotPath !== undefined) {
        const scrollStopNumber = hasSeveralScrollStops ? scrollStopPosition + 1 : null;
        screenshotPath = getScreenshotPath(options.screenshotPath, viewport, colorScheme, hasSeveralRuns, scrollStopNumber);
        await takeScreenshot(page, screenshotPath, measurement);
      }

      const ariaMatches = shouldCaptureAriaSnapshot ? await getAriaSnapshots(page, options.elementSelector) : null;
      const runWithoutMeasurement: RunResult = {
        viewport,
        colorScheme,
        scrollStop,
        status: loadFacts.status,
        settle,
        devicePixelRatio,
        page: null,
        analysis: null,
        previousSnapshot: null,
        isCacheEnabled: cacheDirectory !== null,
        screenshotPath,
        shouldIncludeChildren,
        ariaSnapshots: ariaMatches?.map((ariaMatch) => ariaMatch.ariaSnapshot) ?? null,
        ariaMatchVisibilities: ariaMatches?.map((ariaMatch) => ariaMatch.visibility) ?? null,
        isPageUnchangedByScript: loadFacts.isPageUnchangedByScript,
        redirectedUrl: loadFacts.redirectedUrl,
        fontFallbacks,
      };

      if (measurement === null) {
        return runWithoutMeasurement;
      }

      const analysis = analyze(measurement);
      let previousSnapshot: Snapshot | null = null;

      if (cacheDirectory !== null) {
        const snapshotKey = getSnapshotKey([url, viewport.width, viewport.height, colorScheme, devicePixelRatio, scrollStop, ...snapshotStateKey]);
        previousSnapshot = await readSnapshot(cacheDirectory, snapshotKey);
        await writeSnapshot(cacheDirectory, snapshotKey, createSnapshot(measurement, analysis));
      }

      return { ...runWithoutMeasurement, page: measurement, analysis, previousSnapshot };
    }

    try {
      await context.addInitScript({ content: browserBundle });
      const page = await context.newPage();
      page.setDefaultTimeout(timeoutMs / 4);

      for (const viewport of viewports) {
        await page.setViewportSize(viewport);
        await page.emulateMedia({ colorScheme: colorSchemes[0] });

        const status = await loadTarget(page, url, timeoutMs);
        const loadFacts: LoadFacts = {
          status,
          redirectedUrl: getRedirectedUrl(url, page.url()),
          budgetStartTime: Date.now(),
          isPageUnchangedByScript: false,
        };

        await page.evaluate(async () => {
          await document.fonts.ready;
        });
        await settlePage(page);

        if (shouldReveal) {
          await page.evaluate(
            (revealOptions) => (globalThis as PxtreeGlobal).__pxtree.revealByScrolling(revealOptions),
            { maxSteps: revealMaxSteps, maxImageWaitMs: revealMaxImageWaitMs },
          );
        }

        for (const scrollStopPosition of scrollStops.keys()) {
          const isFirstScrollStop = scrollStopPosition === 0;
          const stopLoadFacts = isFirstScrollStop ? loadFacts : { ...loadFacts, budgetStartTime: Date.now() };

          await page.emulateMedia({ colorScheme: colorSchemes[0] });
          await settlePage(page);
          await scrollPage(page, scrollStops[scrollStopPosition]);

          const stateTextBeforeScript = isFirstScrollStop ? await runScriptAndWait(page) : null;
          const firstSettle = await settlePage(page);

          if (stateTextBeforeScript !== null) {
            loadFacts.isPageUnchangedByScript = stateTextBeforeScript === (await getPageStateText(page));
          }
          runs.push(await measureRun(page, viewport, scrollStopPosition, colorSchemes[0], stopLoadFacts, firstSettle));

          for (const colorScheme of colorSchemes.slice(1)) {
            await page.emulateMedia({ colorScheme });
            const schemeLoadFacts = { ...stopLoadFacts, budgetStartTime: Date.now() };
            const settle = await settlePage(page);
            runs.push(await measureRun(page, viewport, scrollStopPosition, colorScheme, schemeLoadFacts, settle));
          }
        }
      }

      return { target: url, runs, error: null };
    } catch (error) {
      if (error instanceof MeasureError) {
        return { target: url, runs, error: { kind: error.kind, message: error.message } };
      }

      throw error;
    } finally {
      await context.close();
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
