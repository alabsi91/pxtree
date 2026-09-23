import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import { analyze } from '../findings/findings.ts';
import { createSnapshot } from '../format/diff.ts';
import { getScreenshotClip } from '../format/format.ts';
import type {
  ColorScheme,
  MeasureOptions,
  MeasurePageOptions,
  MeasureResult,
  PageMeasurement,
  PageScript,
  PxtreeInPage,
  RunResult,
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

class MeasureError extends Error {
  kind: 'load' | 'script';

  constructor(kind: 'load' | 'script', message: string) {
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

function resolveTarget(target: string): string {
  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(target) || /^(about|data|blob):/i.test(target);
  if (hasScheme) {
    return target;
  }

  const isFilePath = /^[./~]/.test(target) || /\.x?html?$/i.test(target) || existsSync(target);

  return isFilePath ? pathToFileURL(resolve(target)).href : `http://${target}`;
}

function getScreenshotPath(basePath: string, viewport: Viewport, colorScheme: ColorScheme, hasSeveralRuns: boolean): string {
  if (!hasSeveralRuns) {
    return basePath;
  }

  const extension = extname(basePath);
  const pathWithoutExtension = basePath.slice(0, basePath.length - extension.length);

  return `${pathWithoutExtension}-${viewport.width}x${viewport.height}-${colorScheme}${extension}`;
}

function createPageScript(script: string | PageScript): PageScript {
  if (typeof script === 'function') {
    return script;
  }

  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (parameterName: string, body: string) => PageScript;

  return new AsyncFunction('page', script);
}

async function takeScreenshot(page: Page, path: string, measurement: PageMeasurement): Promise<void> {
  const clip = getScreenshotClip(measurement);

  await page.screenshot(clip === null ? { path } : { path, clip });
}

async function loadTarget(page: Page, url: string, timeoutMs: number): Promise<number | null> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

      await page.waitForLoadState('load', { timeout: loadEventMaxWaitMs }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: networkQuietMaxWaitMs }).catch(() => {});

      return response?.status() ?? null;
    } catch (error) {
      lastError = error;
    }
  }

  throw new MeasureError('load', `could not load ${url}: ${getLoadFailureReason(lastError)}`);
}

async function settlePage(page: Page): Promise<SettleReport> {
  return page.evaluate((maxWaitMs) => (globalThis as PxtreeGlobal).__pxtree.settlePage({ maxWaitMs }), settleMaxWaitMs);
}

async function scrollPage(page: Page, scroll: NonNullable<MeasureOptions['scroll']>): Promise<void> {
  if (typeof scroll === 'string') {
    const hasScrolled = await page.evaluate((selector) => {
      const element = document.querySelector(selector);
      element?.scrollIntoView({ block: 'start', behavior: 'instant' });

      return element !== null;
    }, scroll);

    if (!hasScrolled) {
      throw new MeasureError('script', `scroll failed: no element matches ${scroll}`);
    }

    return;
  }

  await page.evaluate(({ x, y }) => window.scrollTo({ left: x, top: y, behavior: 'instant' }), scroll);
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

  async function measure(target: string, options: MeasureOptions = {}): Promise<MeasureResult> {
    const url = resolveTarget(target);
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
    const scroll = options.scroll ?? { x: 0, y: 0 };
    const timeoutMs = options.timeoutMs ?? 30000;
    const shouldReveal = options.shouldReveal ?? true;
    const shouldIncludeChildren = options.shouldIncludeChildren ?? true;
    const cacheDirectory = options.cacheDirectory === undefined ? getDefaultCacheDirectory() : options.cacheDirectory;
    const scriptCacheText = options.scriptCacheText ?? (typeof options.script === 'string' ? options.script : null);
    const hasSeveralRuns = viewports.length * colorSchemes.length > 1;

    const measurePageOptions: MeasurePageOptions = {
      elementSelector: options.elementSelector ?? null,
      maxNodes,
      maxSamples,
    };

    const context = await browser.newContext({ viewport: viewports[0], deviceScaleFactor: devicePixelRatio });

    async function measureRun(page: Page, viewport: Viewport, colorScheme: ColorScheme, status: number | null, settle: SettleReport): Promise<RunResult> {
      const measurement = await page.evaluate((pageOptions) => (globalThis as PxtreeGlobal).__pxtree.measurePage(pageOptions), measurePageOptions);

      let screenshotPath: string | null = null;

      if (options.screenshotPath !== undefined) {
        screenshotPath = getScreenshotPath(options.screenshotPath, viewport, colorScheme, hasSeveralRuns);
        await takeScreenshot(page, screenshotPath, measurement);
      }

      const analysis = analyze(measurement);
      let previousSnapshot: Snapshot | null = null;

      if (cacheDirectory !== null) {
        const snapshotKey = getSnapshotKey([url, viewport.width, viewport.height, colorScheme, devicePixelRatio, scroll, scriptCacheText, options.wait ?? null]);
        previousSnapshot = await readSnapshot(cacheDirectory, snapshotKey);
        await writeSnapshot(cacheDirectory, snapshotKey, createSnapshot(measurement, analysis));
      }

      return {
        viewport,
        colorScheme,
        status,
        settle,
        page: measurement,
        analysis,
        previousSnapshot,
        isCacheEnabled: cacheDirectory !== null,
        screenshotPath,
        shouldIncludeChildren,
      };
    }

    try {
      await context.addInitScript({ content: browserBundle });
      const page = await context.newPage();
      page.setDefaultTimeout(timeoutMs / 4);

      for (const viewport of viewports) {
        await page.setViewportSize(viewport);
        await page.emulateMedia({ colorScheme: colorSchemes[0] });

        const status = await loadTarget(page, url, timeoutMs);
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

        await scrollPage(page, scroll);

        if (options.script !== undefined) {
          await runPageScript(page, options.script);
        }

        if (options.wait !== undefined) {
          await waitAfterScript(page, options.wait);
        }

        const firstSettle = await settlePage(page);
        runs.push(await measureRun(page, viewport, colorSchemes[0], status, firstSettle));

        for (const colorScheme of colorSchemes.slice(1)) {
          await page.emulateMedia({ colorScheme });
          const settle = await settlePage(page);
          runs.push(await measureRun(page, viewport, colorScheme, status, settle));
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
