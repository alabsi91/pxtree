import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { Page } from 'playwright-core';
import { createSession, format, getTargetUrl, type MeasureResult, type Session } from 'pxtree';
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
  return result.runs[0].page?.nodes.some((node) => node.visibility === 'unpainted-opacity') === true;
}

function getPngSize(pngPath: string): { width: number; height: number } {
  const pngBytes = readFileSync(pngPath);

  return { width: pngBytes.readUInt32BE(16), height: pngBytes.readUInt32BE(20) };
}

test('a second measure while one runs throws', async () => {
  const firstMeasure = session.measure(getFixtureUrl('state.html'), { cacheDirectory: null });

  await assert.rejects(session.measure(getFixtureUrl('state.html'), { cacheDirectory: null }), { message: 'measure already running, await the previous call' });
  assert.equal((await firstMeasure).error, null);
});

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

test('state: the aria tree lists the menu items only after the script opens the menu', async () => {
  const closedLines = await formatFixture(session, 'state', { shouldCaptureAriaSnapshot: true });
  const openLines = await formatFixture(session, 'state', { shouldCaptureAriaSnapshot: true, script: "await page.click('#menu-toggle')" });
  const openAriaLines = openLines.slice(openLines.indexOf('aria:'));

  assert.ok(closedLines.includes('aria:'), closedLines.join('\n'));
  assert.equal(hasLineStartingWith(closedLines, '- listitem'), false, closedLines.join('\n'));
  assert.ok(openAriaLines.includes('- button "Menu"'), openAriaLines.join('\n'));
  assert.deepEqual(
    openAriaLines.filter((line) => line.trimStart().startsWith('- listitem')).map((line) => line.trim()),
    ['- listitem: Profile', '- listitem: Settings', '- listitem: Sign out'],
  );
});

test('state: the aria tree follows --element, one heading per match, whole subtree even without children', async () => {
  const script = "await page.click('#menu-toggle')";
  const itemLines = await formatFixture(session, 'state', { shouldCaptureAriaSnapshot: true, script, elementSelector: '.menu-item', report: 'none' });
  const menuLines = await formatFixture(session, 'state', {
    shouldCaptureAriaSnapshot: true,
    script,
    elementSelector: '.menu',
    shouldIncludeChildren: false,
    report: 'none',
  });

  assert.deepEqual(itemLines.slice(1), [
    'aria .menu-item match 1 of 3:',
    '- listitem: Profile',
    'aria .menu-item match 2 of 3:',
    '- listitem: Settings',
    'aria .menu-item match 3 of 3:',
    '- listitem: Sign out',
  ]);
  assert.deepEqual(menuLines.slice(1), ['aria:', '- list:', '  - listitem: Profile', '  - listitem: Settings', '  - listitem: Sign out']);
});

test('state: element matches with no box print none (not rendered) under their count', async () => {
  const itemLines = await formatFixture(session, 'state', { shouldCaptureAriaSnapshot: true, elementSelector: '.menu-item', report: 'none' });

  assert.deepEqual(itemLines.slice(1), [
    'aria .menu-item match 1 of 3: none (not rendered)',
    'aria .menu-item match 2 of 3: none (not rendered)',
    'aria .menu-item match 3 of 3: none (not rendered)',
  ]);
});

test('state: a script that changes nothing prints page unchanged by script, one that opens the menu does not', async () => {
  const unchangedLines = await formatFixture(session, 'state', { script: 'await page.mouse.click(5, 5)', report: 'none', shouldCaptureAriaSnapshot: true });
  const openedLines = await formatFixture(session, 'state', { script: "await page.click('#menu-toggle')", report: 'none', shouldCaptureAriaSnapshot: true });

  assert.match(unchangedLines[0], / page unchanged by script/);
  assert.doesNotMatch(openedLines[0], /unchanged/);
});

test('state: a second scheme with the same aria tree prints aria: same as light', async () => {
  const reportLines = await formatFixture(session, 'state', { shouldCaptureAriaSnapshot: true, colorSchemes: ['light', 'dark'], report: 'none' });

  assert.equal(reportLines.filter((line) => line === 'aria:').length, 1, reportLines.join('\n'));
  assert.equal(reportLines.at(-1), 'aria: same as light');
});

test('shouldMeasurePage false skips the measurement only while the cache and elementSelector are off', async () => {
  const cacheDirectory = await mkdtemp(join(temporaryDirectory, 'skip-'));
  const skippedResult = await measureFixture(session, 'state', { shouldMeasurePage: false, shouldCaptureAriaSnapshot: true });
  const cachedResult = await measureFixture(session, 'state', { shouldMeasurePage: false, cacheDirectory });
  const elementResult = await measureFixture(session, 'state', { shouldMeasurePage: false, elementSelector: 'button' });

  assert.equal(skippedResult.runs[0].page, null);
  assert.equal(skippedResult.runs[0].analysis, null);
  assert.ok(skippedResult.runs[0].ariaSnapshots?.[0].includes('- button "Menu"'));
  assert.notEqual(cachedResult.runs[0].page, null);
  assert.notEqual(elementResult.runs[0].page, null);
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
    result.runs.map((run) => run.page?.colorScheme),
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
  assert.equal(secondResult.runs[0].previousSnapshot?.version, 3);

  await measureFixture(session, 'state', { cacheDirectory, colorSchemes: ['dark'] });
  const snapshotFileNames = readdirSync(cacheDirectory);
  assert.equal(snapshotFileNames.length, 2);
  assert.match(snapshotFileNames[0], /^[0-9a-f]{40}\.json$/);
});

test('since last run: a class added to an unrelated element renames a node but keeps its path', async () => {
  const cacheDirectory = join(temporaryDirectory, 'stable-paths-cache');
  const addClassScript = "await page.evaluate(() => document.querySelector('.note').classList.add('wide'))";

  const firstLines = await formatFixture(session, 'stable-paths', { cacheDirectory, diffKey: 'stable-paths' });
  const secondLines = await formatFixture(session, 'stable-paths', { cacheDirectory, diffKey: 'stable-paths', script: addClassScript });

  findLine(firstLines, 'div.card.wide');
  findLine(secondLines, 'div.card.primary');
  assert.equal(findLine(secondLines, 'since last run'), 'since last run: no changes');
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

test('reveal: a list of scroll stops measures one run per stop, and a stop that repeats the tree prints only its differences', async () => {
  const reportText = (await formatFixture(session, 'reveal', { scroll: [0, '.feature-two', 'end'] })).join('\n');
  const runBlocks = reportText.split('\n\n');

  assert.deepEqual(
    runBlocks.map((runBlock) => runBlock.split('\n')[0].match(/scroll \d+\/\d+/)?.[0]),
    ['scroll 0/2800', 'scroll 1800/2800', 'scroll 2800/2800'],
  );
  assert.equal(runBlocks[1].split('\n').at(-1), 'tree: same as scroll 0');
  assert.equal(runBlocks[2].split('\n').at(-1), 'tree: same as scroll .feature-two');
});

test('reveal: a digit string scroll stop is a y offset', async () => {
  const singleStopText = (await formatFixture(session, 'reveal', { scroll: '900' })).join('\n');
  const listReportText = (await formatFixture(session, 'reveal', { scroll: ['0', '.feature-two', 'end'] })).join('\n');
  const listRunBlocks = listReportText.split('\n\n');

  assert.match(singleStopText, /scroll 900\/2800/);
  assert.deepEqual(
    listRunBlocks.map((runBlock) => runBlock.split('\n')[0].match(/scroll \d+\/\d+/)?.[0]),
    ['scroll 0/2800', 'scroll 1800/2800', 'scroll 2800/2800'],
  );
});

test('reveal: a lone selector stop lands on the element after the reveal transitions finish', async () => {
  const reportLines = await formatFixture(session, 'reveal', { scroll: '.feature-two', report: 'summary' });

  assert.match(reportLines[0], /scroll 1800\/2800/);
});

test('reveal: a scroll selector that matches nothing or is not valid CSS fails with one line', async () => {
  const missingResult = await session.measure(getFixtureUrl('reveal'), { cacheDirectory: null, scroll: '.missing' });
  const invalidResult = await session.measure(getFixtureUrl('reveal'), { cacheDirectory: null, scroll: '9px0' });

  assert.equal(missingResult.error?.message, 'scroll failed: no element matches .missing, a stop is a y offset of 0 or more, end, or a selector');
  assert.equal(invalidResult.error?.message, 'scroll failed: 9px0 is not a y offset of 0 or more, end, or a selector');
});

test('reveal: a scroll stop string with commas is a list of stops, and a selector stop reaches into shadow roots', async () => {
  const listResult = await measureFixture(session, 'reveal', { scroll: '0, end', shouldMeasurePage: false });
  const shadowResult = await session.measure(getFixtureUrl('shadow-dom'), { cacheDirectory: null, scroll: '.inner' });

  assert.deepEqual(listResult.runs.map((run) => run.scrollStop), [0, 'end']);
  assert.equal(shadowResult.error, null);
});

test('reveal: the since-last-run key includes the scroll stop', async () => {
  const cacheDirectory = join(temporaryDirectory, 'scroll-stop-cache');

  await measureFixture(session, 'reveal', { cacheDirectory, scroll: 0 });
  const endResult = await measureFixture(session, 'reveal', { cacheDirectory, scroll: 'end' });

  assert.equal(endResult.runs[0].previousSnapshot, null);
});

test('animations: a finding inside a scroll-driven animation says it is mid animation, in the tree and the summary', async () => {
  const reportLines = await formatFixture(session, 'animations');

  assert.match(findLine(reportLines, 'div.scroll-reveal '), /\[animating\]/);
  assert.match(findLine(reportLines, 'p.reveal-text '), /\[!! contrast [\d.]+ \(mid animation\)\]$/);
  assert.ok(
    reportLines.some((line) => /^ {2}contrast [\d.]+ \(mid animation\), text #d8d8d8: p\.reveal-text$/.test(line)),
    reportLines.join('\n'),
  );
});

test('fonts: a web font that did not draw prints once as not used, the generic and default fonts print nothing', async () => {
  const result = await measureFixture(session, 'fonts');
  const factsLine = format(result).split('\n')[0];

  assert.equal(result.runs[0].fontFallbacks.length, 1, JSON.stringify(result.runs[0].fontFallbacks));
  assert.equal(result.runs[0].fontFallbacks[0].requestedFamily, 'Brandface');
  assert.match(factsLine, / font "Brandface" not used, drew \S/);
  assert.doesNotMatch(factsLine, /font failed/);
});

test('a measurement that runs past the timeout ends with a measure error, and the session keeps working', async () => {
  const hangingScript = 'await page.evaluate(() => { document.elementsFromPoint = function () { for (;;) {} }; })';
  const startTime = Date.now();
  const result = await session.measure(getFixtureUrl('state'), { cacheDirectory: null, timeoutMs: 3000, script: hangingScript });

  assert.equal(result.error?.kind, 'measure');
  assert.equal(result.error?.message, 'measurement timed out after 3000 ms during measure');
  assert.ok(Date.now() - startTime < 10000, `took ${Date.now() - startTime} ms`);
  assert.equal((await measureFixture(session, 'state')).runs.length, 1);
});

test('a page that blocks its main thread after load times out in the phase it hangs, and the session keeps working', async () => {
  const startTime = Date.now();
  const result = await session.measure(getFixtureUrl('node-hang'), { cacheDirectory: null, timeoutMs: 3000 });
  const elapsedMs = Date.now() - startTime;

  assert.equal(result.error?.kind, 'measure');
  assert.match(result.error?.message ?? '', /^measurement timed out after 3000 ms during \w+$/);
  assert.ok(elapsedMs < 5000, `took ${elapsedMs} ms`);
  assert.equal((await measureFixture(session, 'state')).runs.length, 1);
});

test('a numeric wait longer than the timeout fails naming the wait, a selector wait gets the whole timeout and names the selector', async () => {
  const numberStartTime = Date.now();
  const numberResult = await session.measure(getFixtureUrl('state'), { cacheDirectory: null, timeoutMs: 1000, wait: 1500 });
  const numberElapsedMs = Date.now() - numberStartTime;
  const selectorStartTime = Date.now();
  const selectorResult = await session.measure(getFixtureUrl('state'), { cacheDirectory: null, timeoutMs: 2000, wait: '#never' });
  const selectorElapsedMs = Date.now() - selectorStartTime;

  assert.deepEqual(numberResult.error, { kind: 'script', message: 'wait failed: 1500 ms is longer than the timeout of 1000 ms' });
  assert.ok(numberElapsedMs < 500, `took ${numberElapsedMs} ms`);
  assert.deepEqual(selectorResult.error, { kind: 'script', message: 'wait failed: no visible element matches #never after 2000 ms' });
  assert.ok(selectorElapsedMs >= 2000, `took ${selectorElapsedMs} ms`);
  assert.equal((await measureFixture(session, 'state', { timeoutMs: 1000, wait: 500 })).runs.length, 1);
});

test('an unreachable host shares one timeout across both load attempts', async () => {
  const silentServer = createServer(() => {});
  await new Promise<void>((resolve) => silentServer.listen(0, '127.0.0.1', resolve));
  const { port } = silentServer.address() as AddressInfo;

  try {
    const startTime = Date.now();
    const result = await session.measure(`http://127.0.0.1:${port}/`, { cacheDirectory: null, timeoutMs: 2000 });
    const elapsedMs = Date.now() - startTime;

    assert.equal(result.error?.kind, 'load');
    assert.ok(elapsedMs < 3500, `took ${elapsedMs} ms`);
  } finally {
    silentServer.closeAllConnections();
    silentServer.close();
  }
});

test('an element selector that is not valid CSS fails with one line before loading', async () => {
  const bracketResult = await session.measure(getFixtureUrl('state'), { cacheDirectory: null, elementSelector: 'div[' });
  const emptyResult = await session.measure(getFixtureUrl('state'), { cacheDirectory: null, elementSelector: '', shouldCaptureAriaSnapshot: true });

  assert.deepEqual(bracketResult.error, { kind: 'script', message: 'element failed: div[ is not a valid selector' });
  assert.deepEqual(emptyResult.error, { kind: 'script', message: "element failed: '' is not a valid selector" });
});

test('the first stop runs the script before it scrolls, so a stop can target what the script adds', async () => {
  const script = "await page.click('#more')";
  const selectorResult = await measureFixture(session, 'node-late', { script, scroll: '#late' });
  const endResult = await measureFixture(session, 'node-late', { script, scroll: 'end' });
  const endPage = endResult.runs[0].page!;

  assert.ok(selectorResult.runs[0].page!.scroll.y > 2000, String(selectorResult.runs[0].page!.scroll.y));
  assert.ok(endPage.scroll.maxY > 2000, String(endPage.scroll.maxY));
  assert.equal(endPage.scroll.y, endPage.scroll.maxY);
});

function hasSimplePageHeader(result: MeasureResult): boolean {
  return result.runs[0].page!.nodes.some((node) => node.name.startsWith('header.site'));
}

test('a script that navigates, awaited or not, measures the page it lands on and says redirected to', async () => {
  const clickResult = await measureFixture(session, 'node-late', { script: "await page.click('#go')" });
  const evaluateResult = await measureFixture(session, 'node-late', {
    script: "await page.evaluate(() => { setTimeout(() => { location.href = 'simple.html'; }, 20); })",
  });

  for (const result of [clickResult, evaluateResult]) {
    assert.ok(hasSimplePageHeader(result), format(result));
    assert.match(result.runs[0].redirectedUrl ?? '', /simple\.html$/);
  }
});

test('a page that navigates by itself after load is followed and measured where it lands', async () => {
  const result = await measureFixture(session, 'node-navigate');

  assert.ok(hasSimplePageHeader(result), format(result));
  assert.match(format(result).split('\n')[0], / redirected to file:\/\/\S+simple\.html/);
});

test('a script given as a whole function is called with the page', async () => {
  const functionScripts = [
    "async (page) => { await page.click('#more') }",
    "(page) => page.click('#more')",
    "async function (page) { await page.click('#more') }",
    "function clickMore(page) { return page.click('#more') }",
  ];

  for (const script of functionScripts) {
    const result = await measureFixture(session, 'node-late', { script, scroll: '#late' });

    assert.ok(result.runs[0].page!.scroll.y > 2000, `${script}: ${result.runs[0].page!.scroll.y}`);
    assert.equal(result.runs[0].isPageUnchangedByScript, false, script);
  }
});

test('a script that parses as neither a body nor a function fails with its position before the browser starts', async () => {
  const result = await session.measure(getFixtureUrl('state'), { cacheDirectory: null, script: "await page.click('#more')\nconst broken = ;" });

  assert.deepEqual(result.error, {
    kind: 'script',
    message: "script failed: not a function body or a function, SyntaxError: Unexpected token ';' at 2:16",
  });
});

test('a script that closes the page, or an action that times out, fails with one line that says so', async () => {
  const closeResult = await session.measure(getFixtureUrl('state'), { cacheDirectory: null, script: 'await page.close()' });
  const clickResult = await session.measure(getFixtureUrl('state'), { cacheDirectory: null, timeoutMs: 2000, script: "await page.click('#never')" });

  assert.deepEqual(closeResult.error, { kind: 'script', message: 'script failed: the script closed the page' });
  assert.equal(clickResult.error?.message, "script failed: TimeoutError: page.click: Timeout 500ms exceeded, waiting for locator('#never')");
});

test('a script that resizes the viewport reports the size it measured', async () => {
  const result = await measureFixture(session, 'state', { script: 'await page.setViewportSize({ width: 400, height: 300 })' });

  assert.deepEqual(result.runs[0].viewport, { width: 400, height: 300 });
});

test('an empty target or a directory fails with one line, and repeated viewports and schemes run once', async () => {
  const emptyResult = await session.measure('  ', { cacheDirectory: null });
  const directoryResult = await session.measure('test/fixtures', { cacheDirectory: null });
  const repeatedResult = await measureFixture(session, 'state', {
    viewports: [{ width: 390, height: 844 }, { width: 390, height: 844 }],
    colorSchemes: ['light', 'light'],
    shouldMeasurePage: false,
  });

  assert.deepEqual(emptyResult.error, { kind: 'load', message: 'target is empty' });
  assert.deepEqual(directoryResult.error, { kind: 'load', message: 'target is a directory: test/fixtures' });
  assert.equal(repeatedResult.runs.length, 1);
});

test('a download target fails with one line that says it is a download', async () => {
  const downloadServer = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename=file.bin' });
    response.end('bytes');
  });
  await new Promise<void>((resolve) => downloadServer.listen(0, '127.0.0.1', resolve));
  const downloadUrl = `http://127.0.0.1:${(downloadServer.address() as AddressInfo).port}/file.bin`;

  try {
    const result = await session.measure(downloadUrl, { cacheDirectory: null });

    assert.deepEqual(result.error, { kind: 'load', message: `target is a download, not a page: ${downloadUrl}` });
  } finally {
    downloadServer.close();
  }
});

test('an element match past the walk cap says not walked, and the facts line says the walk was capped', async () => {
  const addElementsScript = "await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div>x</div>'.repeat(20010) + '<p id=\"last\">last</p>'))";
  const result = await measureFixture(session, 'simple', { script: addElementsScript, elementSelector: '#last', shouldReveal: false });
  const reportLines = format(result).split('\n');

  assert.match(reportLines[0], / walk capped at 20000 of \d+ elements/);
  assert.ok(reportLines.includes('#last: 1 matched, 1 not walked, page over 20000 elements'), reportLines.join('\n'));
});

test('a closed browser relaunches on the next measure', async () => {
  const closeBrowserScript = async (page: Page) => {
    await page.context().browser()!.close();
  };
  const closedResult = await session.measure(getFixtureUrl('state'), { cacheDirectory: null, script: closeBrowserScript });

  assert.equal(closedResult.error?.kind, 'launch', JSON.stringify(closedResult.error));
  assert.equal((await measureFixture(session, 'state')).runs.length, 1);
});

test('a still moving element name cannot forge a finding on the facts line', async () => {
  const result = await measureFixture(session, 'node-still-moving');
  const factsLine = format(result).split('\n')[0];

  assert.match(factsLine, / still moving x-a/);
  assert.doesNotMatch(factsLine, /\[|\]|"|›/);
});

test('the since-last-run key includes the reveal setting, and a function script without cache text turns the diff off', async () => {
  const cacheDirectory = join(temporaryDirectory, 'settings-cache');

  await measureFixture(session, 'state', { cacheDirectory });
  const noRevealResult = await measureFixture(session, 'state', { cacheDirectory, shouldReveal: false });
  const functionScriptResult = await measureFixture(session, 'state', { cacheDirectory, script: async () => {} });

  assert.equal(noRevealResult.runs[0].previousSnapshot, null);
  assert.equal(functionScriptResult.runs[0].isCacheEnabled, false);
  assert.equal(functionScriptResult.runs[0].cacheOffReason, 'script has no text; pass diffKey');
  assert.equal(findLine(format(functionScriptResult).split('\n'), 'since last run'), 'since last run: off, script has no text; pass diffKey');

  const cacheOffResult = await measureFixture(session, 'state', { script: async () => {} });
  assert.equal(cacheOffResult.runs[0].cacheOffReason, null);
});

test('scheme runs: the dark tree differences follow --element', async () => {
  const reportText = (await formatFixture(session, 'node-scheme', { elementSelector: '.card', colorSchemes: ['light', 'dark'] })).join('\n');
  const darkBlock = reportText.split('\n\n')[1];

  assert.match(darkBlock, /tree: same as light, differences:\n {2}p "card text"/);
  assert.doesNotMatch(darkBlock, /footer text/);
});

test('scheme runs: with colors a dark tree that differs only in color prints in full', async () => {
  const plainLines = await formatFixture(session, 'node-scheme', { elementSelector: '.quiet', colorSchemes: ['light', 'dark'] });
  const colorLines = await formatFixture(session, 'node-scheme', { elementSelector: '.quiet', colorSchemes: ['light', 'dark'], shouldShowColors: true });
  const plainDarkBlock = plainLines.join('\n').split('\n\n')[1];
  const colorDarkBlock = colorLines.join('\n').split('\n\n')[1];

  assert.match(plainDarkBlock, /tree: same as light$/);
  assert.match(colorDarkBlock, /p\.quiet "quiet text" .*#444444/);
});

test('a redirect prints on the facts line, a trailing slash does not', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/old') {
      response.writeHead(302, { location: '/new' });
      response.end();
      return;
    }

    if (request.url === '/docs') {
      response.writeHead(301, { location: '/docs/' });
      response.end();
      return;
    }

    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><body><p>Page</p></body>');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const redirectedResult = await session.measure(`${origin}/old`, { cacheDirectory: null });
    const slashResult = await session.measure(`${origin}/docs`, { cacheDirectory: null });

    assert.equal(redirectedResult.runs[0].redirectedUrl, `${origin}/new`);
    assert.match(format(redirectedResult).split('\n')[0], new RegExp(` redirected to ${origin}/new`));
    assert.equal(slashResult.runs[0].redirectedUrl, null);
  } finally {
    server.close();
  }
});

test('a file path keeps its query and fragment on the URL', () => {
  const fixturePath = 'test/fixtures/state.html';

  assert.equal(getTargetUrl(`${fixturePath}?tab=2#menu`), `${getFixtureUrl('state')}?tab=2#menu`);
  assert.equal(getTargetUrl('localhost:5173/a?b'), 'http://localhost:5173/a?b');
});

test('animations: the page settles with no element still moving', async () => {
  const result = await measureFixture(session, 'animations');

  assert.equal(result.runs[0].settle.stillMovingName, null);
});
