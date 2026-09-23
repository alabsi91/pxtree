import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { Page } from 'playwright-core';
import { createSession, type MeasureResult, type Session } from 'pxtree';
import { findLine, formatFixture, getFixtureUrl, measureFixture } from './helpers.ts';

let session: Session;
let temporaryDirectory: string;

before(async () => {
  session = await createSession();
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'pxtree-driver-'));
});

after(async () => {
  await session.close();
  await rm(temporaryDirectory, { recursive: true, force: true });
});

function hasLineStartingWith(reportLines: string[], lineStart: string): boolean {
  return reportLines.some((line) => line.trimStart().startsWith(lineStart));
}

function hasUnpaintedNode(result: MeasureResult): boolean {
  return result.runs[0].page.nodes.some((node) => node.visibility === 'unpainted-opacity');
}

function getPngSize(pngPath: string): { width: number; height: number } {
  const pngBytes = readFileSync(pngPath);

  return { width: pngBytes.readUInt32BE(16), height: pngBytes.readUInt32BE(20) };
}

test('state: the menu prints only after the script clicks it open', async () => {
  const closedLines = await formatFixture(session, 'state');
  assert.equal(hasLineStartingWith(closedLines, 'ul.menu'), false);

  const openLines = await formatFixture(session, 'state', { script: "await page.click('#menu-toggle')" });
  findLine(openLines, 'ul.menu');
  findLine(openLines, 'li.menu-item "Profile"');
});

test('state: a hover-only tooltip prints after page.hover', async () => {
  const idleLines = await formatFixture(session, 'state');
  assert.equal(hasLineStartingWith(idleLines, 'div.tooltip'), false);

  const hoverLines = await formatFixture(session, 'state', { script: "await page.hover('.tip-anchor')" });
  findLine(hoverLines, 'div.tooltip "Helpful tooltip text"');
});

test('state: --wait waits for a selector that appears after the script', async () => {
  const script = "await page.click('#load')";

  const unwaitedLines = await formatFixture(session, 'state', { script });
  assert.equal(hasLineStartingWith(unwaitedLines, 'div.late-panel'), false);

  const waitedLines = await formatFixture(session, 'state', { script, wait: '.late-panel' });
  findLine(waitedLines, 'div.late-panel "Loaded later"');
});

test('two viewports and two schemes share one browser, one context and one page', async () => {
  const seenPages = new Set<Page>();
  const contextCounts: number[] = [];
  const pageCounts: number[] = [];

  const result = await measureFixture(session, 'state', {
    viewports: [
      { width: 390, height: 844 },
      { width: 1280, height: 800 },
    ],
    colorSchemes: ['light', 'dark'],
    script: async (page) => {
      seenPages.add(page);
      contextCounts.push(page.context().browser()?.contexts().length ?? 0);
      pageCounts.push(page.context().pages().length);
    },
  });

  assert.deepEqual(
    result.runs.map((run) => `${run.viewport.width}x${run.viewport.height} ${run.colorScheme}`),
    ['390x844 light', '390x844 dark', '1280x800 light', '1280x800 dark'],
  );
  assert.deepEqual(
    result.runs.map((run) => run.page.colorScheme),
    ['light', 'dark', 'light', 'dark'],
  );
  assert.equal(seenPages.size, 1);
  assert.deepEqual(contextCounts, [1, 1]);
  assert.deepEqual(pageCounts, [1, 1]);
});

test('a throwing script ends the run with a script error', async () => {
  const result = await session.measure(getFixtureUrl('state'), { cacheDirectory: null, script: "throw new TypeError('boom')" });

  assert.deepEqual(result.error, { kind: 'script', message: 'script failed: TypeError: boom' });
  assert.equal(result.runs.length, 0);
});

test('a missing file ends the run with a load error', async () => {
  const missingUrl = getFixtureUrl('does-not-exist');
  const result = await session.measure(missingUrl, { cacheDirectory: null });

  assert.deepEqual(result.error, { kind: 'load', message: `could not load ${missingUrl}: net::ERR_FILE_NOT_FOUND` });
});

test('screenshots get a size and scheme suffix when there are several runs', async () => {
  const screenshotPath = join(temporaryDirectory, 'shot.png');

  const result = await measureFixture(session, 'state', {
    viewports: [
      { width: 400, height: 300 },
      { width: 600, height: 500 },
    ],
    screenshotPath,
  });

  const expectedPaths = [join(temporaryDirectory, 'shot-400x300-light.png'), join(temporaryDirectory, 'shot-600x500-light.png')];
  assert.deepEqual(
    result.runs.map((run) => run.screenshotPath),
    expectedPaths,
  );
  assert.deepEqual(getPngSize(expectedPaths[1]), { width: 600, height: 500 });
  assert.equal(existsSync(screenshotPath), false);
});

test('a screenshot with one matched element is clipped to it', async () => {
  const screenshotPath = join(temporaryDirectory, 'button.png');

  const result = await measureFixture(session, 'state', { elementSelector: '#menu-toggle', screenshotPath });

  assert.equal(result.runs[0].screenshotPath, screenshotPath);
  assert.deepEqual(getPngSize(screenshotPath), { width: 120, height: 40 });
});

test('the since-last-run cache stores one snapshot per key and reads it back', async () => {
  const cacheDirectory = join(temporaryDirectory, 'cache');

  const firstResult = await measureFixture(session, 'state', { cacheDirectory });
  assert.equal(firstResult.runs[0].previousSnapshot, null);
  assert.equal(firstResult.runs[0].isCacheEnabled, true);

  const secondResult = await measureFixture(session, 'state', { cacheDirectory });
  assert.equal(secondResult.runs[0].previousSnapshot?.version, 1);

  await measureFixture(session, 'state', { cacheDirectory, colorSchemes: ['dark'] });
  const snapshotFileNames = readdirSync(cacheDirectory);
  assert.equal(snapshotFileNames.length, 2);
  assert.match(snapshotFileNames[0], /^[0-9a-f]{40}\.json$/);
});

test('the cache is off with cacheDirectory null', async () => {
  const result = await measureFixture(session, 'state');

  assert.equal(result.runs[0].isCacheEnabled, false);
  assert.equal(result.runs[0].previousSnapshot, null);
});

test('reveal: below-the-fold sections are shown after the reveal pass', async () => {
  assert.equal(hasUnpaintedNode(await measureFixture(session, 'reveal')), false);
  assert.equal(hasUnpaintedNode(await measureFixture(session, 'reveal', { shouldReveal: false })), true);
});

test('animations: the page settles with no element still moving', async () => {
  const result = await measureFixture(session, 'animations');

  assert.equal(result.runs[0].settle.stillMovingName, null);
});
