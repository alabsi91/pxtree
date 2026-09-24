import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { type Browser, type Page, chromium } from 'playwright-core';
import { analyze } from '../src/findings/findings.ts';
import type { MeasuredNode, MeasurePageOptions, PageMeasurement } from '../src/types.ts';

const browserBundle = readFileSync(new URL('../dist/browser.js', import.meta.url), 'utf8');
const defaultMeasureOptions: MeasurePageOptions = { elementSelector: null, maxNodes: 20000, maxSamples: 21000 };

let browser: Browser;

before(async () => {
  browser = await chromium.launch();
});

after(async () => {
  await browser.close();
});

interface PageOptions {
  width?: number;
  height?: number;
  colorScheme?: 'light' | 'dark';
}

async function openPage(options: PageOptions = {}): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: options.width ?? 1280, height: options.height ?? 800 },
    colorScheme: options.colorScheme ?? 'light',
  });
  await context.addInitScript({ content: browserBundle });

  return context.newPage();
}

async function openFixture(name: string, options: PageOptions = {}): Promise<Page> {
  const page = await openPage(options);
  await page.goto(new URL(`fixtures/${name}.html`, import.meta.url).href);
  await page.evaluate(() => document.fonts.ready);

  return page;
}

function measurePage(page: Page, options: Partial<MeasurePageOptions> = {}): Promise<PageMeasurement> {
  return page.evaluate((measureOptions) => globalThis.__pxtree!.measurePage(measureOptions), {
    ...defaultMeasureOptions,
    ...options,
  });
}

async function settlePage(page: Page): Promise<void> {
  const settleReport = await page.evaluate(() => globalThis.__pxtree!.settlePage({ maxWaitMs: 1000 }));
  assert.equal(settleReport.stillMovingName, null);
}

async function scrollPage(page: Page, top: number): Promise<void> {
  await page.evaluate((scrollTop) => window.scrollTo({ top: scrollTop, behavior: 'instant' }), top);
}

function getNode(measurement: PageMeasurement, name: string): MeasuredNode {
  const node = measurement.nodes.find((candidate) => candidate.name === name);

  if (!node) {
    const nodeNames = measurement.nodes.map((candidate) => candidate.name).join(', ');
    throw new Error(`no node named ${name}, nodes: ${nodeNames}`);
  }

  return node;
}

function hasNode(measurement: PageMeasurement, name: string): boolean {
  return measurement.nodes.some((node) => node.name === name);
}

function getDomFingerprint(page: Page): Promise<string> {
  return page.evaluate(() => {
    const sheetCounts = [document.adoptedStyleSheets.length];

    for (const element of document.querySelectorAll('*')) {
      if (element.shadowRoot) {
        sheetCounts.push(element.shadowRoot.adoptedStyleSheets.length);
      }
    }

    return JSON.stringify([document.documentElement.outerHTML, sheetCounts]);
  });
}

test('rtl page maps its start to the right and keeps an ltr island', async () => {
  const page = await openFixture('rtl', { width: 390, height: 844 });
  const measurement = await measurePage(page);

  assert.equal(measurement.direction, 'rtl');
  assert.ok(measurement.scroll.maxX > 0, 'the page scrolls sideways');

  const card = getNode(measurement, 'div.card');
  const moreLink = getNode(measurement, 'a.more');
  const cardContentRight = card.rect.x + card.rect.width - card.border[1] - card.padding[1];

  assert.equal(moreLink.direction, 'rtl');
  assert.ok(Math.abs(moreLink.rect.x + moreLink.rect.width - cardContentRight) < 0.5, 'a.more starts at the right edge');
  assert.ok(moreLink.rect.x < 0, 'a.more runs past the left edge of the viewport');
  assert.equal(moreLink.visibility, 'shown');

  const island = getNode(measurement, 'div.island');
  const firstSpan = getNode(measurement, 'span.first');

  assert.equal(island.direction, 'ltr');
  assert.equal(measurement.nodes[island.parentIndex].direction, 'rtl');
  assert.ok(Math.abs(firstSpan.rect.x - (island.rect.x + island.padding[3])) < 0.5, 'ltr island starts at the left');

  await page.context().close();
});

test('top layer: modal dialog and popover are roots, the page behind is inert', async () => {
  const page = await openFixture('top-layer');
  const measurement = await measurePage(page);

  const dialog = getNode(measurement, 'dialog#confirm-delete');
  const popover = getNode(measurement, 'div#hint');

  assert.equal(dialog.parentIndex, -1);
  assert.equal(dialog.topLayer, 'modal');
  assert.equal(dialog.isViewportFrame, true);
  assert.equal(measurement.modalIndex, dialog.index);
  assert.equal(popover.parentIndex, -1);
  assert.equal(popover.topLayer, 'popover');
  assert.deepEqual(measurement.topLayerIndexes, [dialog.index, popover.index]);
  assert.ok(popover.index > dialog.subtreeEnd, 'the popover is not walked inside the dialog');

  const bodySubtree = measurement.nodes.slice(0, measurement.nodes[0].subtreeEnd + 1);

  assert.ok(bodySubtree.every((node) => node.isInert), 'everything behind the modal is inert');
  assert.ok(bodySubtree.every((node) => node.coverage === null), 'inert nodes get no coverage');

  const heading = getNode(measurement, 'h2');

  assert.equal(heading.isInert, false);
  assert.ok(heading.coverage!.coveredSampleCount > 0);

  for (const coverer of heading.coverage!.coverers) {
    assert.ok(measurement.topLayerIndexes.includes(coverer.index), 'only a top-layer node covers the dialog heading');
  }

  await page.context().close();
});

test('sticky header covers a heading only when stuck, a pointer-events none shade still counts', async () => {
  const page = await openFixture('sticky-cover');

  const atTop = await measurePage(page);

  assert.equal(getNode(atTop, 'header.site').isStuck, false);
  assert.equal(getNode(atTop, 'nav.sub').isStuck, false, 'a sticky offset does not count as stuck at its flow position');
  assert.equal(getNode(atTop, 'h2.section-title').coverage!.coveredSampleCount, 0);

  await scrollPage(page, 400);

  const domBefore = await getDomFingerprint(page);
  const scrolled = await measurePage(page);
  const domAfter = await getDomFingerprint(page);

  assert.equal(domAfter, domBefore, 'the sticky probe leaves the DOM as it found it');

  const header = getNode(scrolled, 'header.site');
  const heading = getNode(scrolled, 'h2.section-title');
  const headingCoverage = heading.coverage!;

  assert.equal(header.isStuck, true);

  const subNav = getNode(scrolled, 'nav.sub');

  assert.equal(subNav.isStuck, true);
  assert.equal(subNav.rect.y, 400 + 64, 'the stuck rect sits at its top offset below the scroll');

  assert.equal(headingCoverage.coverers[0].index, header.index);
  assert.ok(headingCoverage.coveredSampleCount > 0);
  assert.ok(headingCoverage.coveredSampleCount < headingCoverage.sampleCount, 'only the top of the heading is covered');

  const shade = getNode(scrolled, 'div.shade');
  const shadedText = getNode(scrolled, 'p.under-shade');

  assert.equal(shadedText.coverage!.coverers[0].index, shade.index);
  assert.equal(shadedText.coverage!.coverers[0].isTranslucent, true);

  await page.context().close();
});

test('scroll containers report their axes and keep scrolled-out children shown', async () => {
  const page = await openFixture('scroll-container');
  await page.evaluate(() => {
    document.querySelector('ul.list')!.scrollTop = 120;
  });

  const measurement = await measurePage(page);
  const listNode = getNode(measurement, 'ul.list');

  assert.deepEqual(listNode.scroll, {
    axes: [{ axis: 'y', contentSize: 568, visibleSize: 300, offset: 120 }],
    childCount: 25,
    childrenOutCount: 11,
  });
  assert.equal(listNode.clipsChildren.y, 'scroll');

  const listItems = measurement.nodes.filter((node) => node.parentIndex === listNode.index);

  assert.equal(listItems.length, 25);
  assert.ok(listItems.every((item) => item.visibility === 'shown'), 'scrolled-out items are not clipped out');
  assert.ok(listItems.every((item) => item.clip?.clipperIndexY === listNode.index));

  const barelyScrolling = getNode(measurement, 'div.barely');

  assert.deepEqual(barelyScrolling.scroll!.axes, [{ axis: 'y', contentSize: 103, visibleSize: 100, offset: 0 }]);

  const hiddenBox = getNode(measurement, 'div.hidden-box');
  const hiddenBoxIndex = measurement.nodes.indexOf(hiddenBox);
  const clippedLine = measurement.nodes[hiddenBoxIndex + 1];

  assert.equal(hiddenBox.clipsChildren.x, 'clip');
  assert.equal(hiddenBox.scroll, null, 'overflow hidden is not a scroll container');
  assert.equal(clippedLine.clip!.clipperIndexX, hiddenBox.index);
  assert.equal(clippedLine.clip!.rect.width, 200);

  await page.context().close();
});

test('transforms: rotate, scale and the individual properties', async () => {
  const page = await openFixture('transforms');
  const measurement = await measurePage(page);

  const rotated = getNode(measurement, 'div.box.rotated');

  assert.equal(rotated.rotateDegrees, 30);
  assert.equal(rotated.scale, 1);
  assert.equal(rotated.layoutWidth, 100);
  assert.equal(rotated.layoutHeight, 20);
  assert.ok(Math.abs(rotated.rect.width - 96.6) < 0.1, 'visual width is the upright bounding box');

  const scaled = getNode(measurement, 'div.box.scaled');

  assert.equal(scaled.scale, 1.5);
  assert.equal(scaled.rect.width, 150);
  assert.equal(getNode(measurement, 'div.box.turned').rotateDegrees, 45);

  const moved = getNode(measurement, 'div.box.moved');

  assert.equal(moved.rotateDegrees, 0, 'translate is not a rotation');
  assert.equal(moved.scale, 1);

  const both = getNode(measurement, 'div.box.both');

  assert.equal(both.rotateDegrees, 10);
  assert.equal(both.scale, 2);

  const tiltedText = measurement.nodes[rotated.index + 1];

  assert.equal(tiltedText.isInsideTransform, true);
  assert.ok(tiltedText.textInfo!.lineHeight < 25, 'normal line height is not read from the rotated box');

  const button = getNode(measurement, 'button.spinner-button');

  assert.equal(measurement.nodes[button.index + 1].isInsideTransform, true);
  assert.equal(button.isInsideTransform, false);

  await page.context().close();
});

test('shadow dom: open root with slots, closed root through attachShadow, declarative closed root', async () => {
  const page = await openFixture('shadow-dom');
  const domBefore = await getDomFingerprint(page);
  const measurement = await measurePage(page);
  const domAfter = await getDomFingerprint(page);

  assert.equal(domAfter, domBefore, 'the pointer-events sheet is removed from every root');

  const openCard = getNode(measurement, 'open-card');

  assert.equal(openCard.shadow, 'open');
  assert.equal(getNode(measurement, 'span.card-title').isSlotted, true);
  assert.equal(getNode(measurement, 'p.card-body').isSlotted, true);
  assert.equal(getNode(measurement, 'span.inner').isSlotted, false);

  const closedPanel = getNode(measurement, 'closed-panel');
  const closedInner = getNode(measurement, 'b.closed-inner');

  assert.equal(closedPanel.shadow, 'closed');
  assert.ok(closedInner.index > closedPanel.index && closedInner.index <= closedPanel.subtreeEnd);

  const sealedBox = getNode(measurement, 'sealed-box');

  assert.equal(sealedBox.shadow, null);
  assert.equal(sealedBox.subtreeEnd, sealedBox.index, 'a declarative closed host is a leaf');

  const innerMatch = await measurePage(page, { elementSelector: '.inner' });

  assert.deepEqual(innerMatch.element, {
    selector: '.inner',
    matchedIndexes: [getNode(measurement, 'span.inner').index],
    matchedCount: 1,
  });

  const closedMatch = await measurePage(page, { elementSelector: '.closed-inner' });

  assert.deepEqual(closedMatch.element!.matchedIndexes, [closedInner.index]);

  const sealedMatch = await measurePage(page, { elementSelector: '.sealed-inner' });

  assert.equal(sealedMatch.element!.matchedCount, 0);

  await page.context().close();
});

test('svg and iframe are leaves', async () => {
  const page = await openFixture('svg-iframe');
  const measurement = await measurePage(page);

  const chart = getNode(measurement, 'svg.chart');
  const frame = getNode(measurement, 'iframe.embed');

  assert.equal(chart.subtreeEnd, chart.index, 'the 200 circles are not walked');
  assert.equal(chart.ink.replaced, 'svg');
  assert.equal(frame.isFrame, true);
  assert.equal(frame.subtreeEnd, frame.index);
  assert.equal(measurement.nodes.length, 3);

  await page.context().close();
});

test('visibility states', async () => {
  const page = await openFixture('visibility');
  const measurement = await measurePage(page);

  assert.equal(getNode(measurement, 'p.plain').visibility, 'shown');
  assert.equal(hasNode(measurement, 'div.gone'), false, 'display none is not in the tree');

  assert.equal(getNode(measurement, 'div.ghost').visibility, 'unpainted-visibility');
  assert.equal(getNode(measurement, 'span.seen').visibility, 'shown');

  const allHidden = getNode(measurement, 'div.all-hidden');

  assert.equal(allHidden.visibility, 'unpainted-visibility');
  assert.equal(allHidden.skippedChildCount, 2);
  assert.equal(allHidden.subtreeEnd, allHidden.index);

  const menu = getNode(measurement, 'ul.menu');

  assert.equal(menu.visibility, 'unpainted-opacity');
  assert.equal(menu.skippedChildCount, 3);

  assert.equal(getNode(measurement, 'div.parked').visibility, 'offscreen');
  assert.equal(getNode(measurement, 'span.sr-only').visibility, 'sr-only');
  assert.equal(getNode(measurement, 'span.thin-label').visibility, 'sr-only', 'a 1x44 clipped box is sr-only');
  assert.equal(getNode(measurement, 'p.labelled').textInfo!.lineCount, 1, 'sr-only text adds no line');

  const window = getNode(measurement, 'div.window');
  const outside = getNode(measurement, 'div.outside');

  assert.equal(outside.visibility, 'clipped-out');
  assert.equal(outside.clippedOutByIndex, window.index);
  assert.equal(getNode(measurement, 'div.inside').visibility, 'shown');

  assert.equal(getNode(measurement, 'div.anchor').visibility, 'shown', 'a zero-size anchor is not sr-only');
  assert.equal(getNode(measurement, 'span.badge').visibility, 'shown');

  assert.equal(hasNode(measurement, 'details'), true);
  assert.equal(hasNode(measurement, 'p.collapsed'), false, 'closed details content has no box');
  assert.equal(getNode(measurement, 'section.lazy').visibility, 'content-skipped');

  await page.context().close();
});

test('text colors and backgrounds', async () => {
  const lightPage = await openFixture('contrast');
  const light = await measurePage(lightPage);

  assert.deepEqual(
    [getNode(light, 'p.meta').textInfo!.color, getNode(light, 'p.meta').textInfo!.background],
    ['#9ca3af', '#ffffff'],
  );
  assert.equal(getNode(light, 'p.on-gradient').textInfo!.background, null, 'text on a gradient has an unknown background');
  assert.deepEqual(
    [getNode(light, 'p.faint').textInfo!.color, getNode(light, 'p.faint').textInfo!.background],
    ['#808080', '#000000'],
  );
  assert.deepEqual(
    [getNode(light, 'p.dimmed').textInfo!.color, getNode(light, 'p.dimmed').textInfo!.background],
    ['#808080', '#000000'],
  );
  assert.equal(getNode(light, 'p.bare').textInfo!.background, '#ffffff');

  const gradientText = getNode(light, 'h2.gradient-text');
  const clearText = getNode(light, 'p.clear');

  assert.equal(gradientText.textInfo!.color, null, 'gradient text has a transparent fill');
  assert.equal(clearText.textInfo!.color, null, 'color transparent has a transparent fill');

  const contrastIndexes = analyze(light)
    .findings.filter((finding) => finding.kind === 'contrast')
    .map((finding) => finding.nodeIndex);

  assert.ok(contrastIndexes.includes(getNode(light, 'p.meta').index));
  assert.ok(!contrastIndexes.includes(gradientText.index), 'no contrast for gradient text');
  assert.ok(!contrastIndexes.includes(clearText.index), 'no contrast for transparent text');
  assert.deepEqual(
    [getNode(light, 'p.below').textInfo!.color, getNode(light, 'p.below').textInfo!.background],
    ['#333333', '#f0f0f0'],
  );

  await lightPage.context().close();

  const darkPage = await openFixture('contrast', { colorScheme: 'dark' });
  const dark = await measurePage(darkPage);

  assert.equal(dark.colorScheme, 'dark');
  assert.deepEqual(
    [getNode(dark, 'p.bare').textInfo!.color, getNode(dark, 'p.bare').textInfo!.background],
    ['#ffffff', '#121212'],
  );
  assert.equal(getNode(dark, 'p.meta').textInfo!.background, '#ffffff');

  await darkPage.context().close();
});

test('settling finishes time-based animations and leaves scroll-driven ones alone', async () => {
  const page = await openFixture('animations');
  const halfScroll = await page.evaluate(() => (document.documentElement.scrollHeight - window.innerHeight) / 2);
  await scrollPage(page, halfScroll);
  await settlePage(page);

  const measurement = await measurePage(page);
  const heading = getNode(measurement, 'h1.fade');

  assert.equal(heading.visibility, 'shown');
  assert.equal(heading.ink.opacity, 1);
  assert.equal(getNode(measurement, 'div.grower.wide').rect.width, 300);
  assert.equal(getNode(measurement, 'div.spinner').rotateDegrees, 0);
  assert.ok(Math.abs(getNode(measurement, 'div.progress').scale - 0.5) < 0.05, 'the progress bar follows the scroll');

  const animationStates = await page.evaluate(() =>
    document.getAnimations().map((animation) => ({
      name: (animation as CSSAnimation).animationName ?? 'transition',
      playState: animation.playState,
      currentTime: animation.currentTime,
    })),
  );
  const spinnerState = animationStates.find((state) => state.name === 'spin')!;

  assert.equal(animationStates.find((state) => state.name === 'fade-in')!.playState, 'finished');
  assert.deepEqual([spinnerState.playState, spinnerState.currentTime], ['paused', 0]);
  assert.equal(animationStates.find((state) => state.name === 'grow')!.playState, 'running');

  await page.context().close();
});

test('reveal pass shows sections that wait for an IntersectionObserver', async () => {
  const hiddenPage = await openFixture('reveal');
  await settlePage(hiddenPage);

  const withoutReveal = await measurePage(hiddenPage);

  assert.equal(getNode(withoutReveal, 'section.reveal.feature-two').visibility, 'unpainted-opacity');

  await hiddenPage.context().close();

  const revealedPage = await openFixture('reveal');
  await revealedPage.evaluate(() => globalThis.__pxtree!.revealByScrolling({ maxSteps: 30, maxImageWaitMs: 2000 }));
  await settlePage(revealedPage);

  const withReveal = await measurePage(revealedPage);

  assert.equal(withReveal.scroll.y, 0, 'the reveal pass scrolls back');

  for (const name of ['feature-one', 'feature-two', 'feature-three']) {
    const section = withReveal.nodes.find((node) => node.name.includes(name))!;
    assert.equal(section.visibility, 'shown', name);
  }

  await revealedPage.context().close();
});

test('measurePage on 3000 elements takes under 400 ms and leaves the DOM unchanged', async (context) => {
  const page = await openPage();
  const cardMarkup = (cardNumber: number) => `
    <div class="card"><h3>Plan ${cardNumber}</h3><p class="lead">Short description of plan number ${cardNumber}</p>
      <ul class="features"><li>Feature one</li><li>Feature two</li></ul>
      <div class="row"><span class="price">$${cardNumber}</span><a class="button" href="#">Buy</a></div></div>`;
  const cards = Array.from({ length: 340 },(_unused, cardNumber) => cardMarkup(cardNumber)).join('');

  await page.setContent(`<!doctype html><html><head><style>
    body { margin: 0; font-family: sans-serif; }
    header { position: sticky; top: 0; height: 56px; background: #fff; border-bottom: 1px solid #ddd; }
    main { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; padding: 16px; }
    .card { padding: 16px; background: #fafafa; border: 1px solid #eee; border-radius: 8px; }
    .row { display: flex; justify-content: space-between; }
    .button { padding: 4px 12px; background: #06c; color: #fff; }
  </style></head><body><header><a href="#">Logo</a></header><main>${cards}</main></body></html>`);

  const elementCount = await page.evaluate(() => document.querySelectorAll('body *').length);

  assert.ok(elementCount >= 3000, `${elementCount} elements`);

  const domBefore = await getDomFingerprint(page);
  const timing = await page.evaluate(() => {
    const startTime = performance.now();
    const measurement = globalThis.__pxtree!.measurePage({ elementSelector: null, maxNodes: 20000, maxSamples: 21000 });
    return { durationMs: performance.now() - startTime, nodeCount: measurement.nodes.length };
  });
  const domAfter = await getDomFingerprint(page);

  context.diagnostic(`${elementCount} elements, ${timing.nodeCount} nodes, measurePage ${timing.durationMs.toFixed(0)} ms`);

  assert.ok(timing.durationMs < 400, `measurePage took ${timing.durationMs.toFixed(0)} ms`);
  assert.equal(domAfter, domBefore);

  await page.context().close();
});

test('browser sources import nothing from Node', () => {
  const browserDirectory = new URL('../src/browser/', import.meta.url);

  for (const fileName of readdirSync(browserDirectory)) {
    const source = readFileSync(new URL(fileName, browserDirectory), 'utf8');
    const importSpecifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);

    for (const importSpecifier of importSpecifiers) {
      assert.ok(importSpecifier.startsWith('./') || importSpecifier === '../types.ts', `${fileName} imports ${importSpecifier}`);
    }
  }
});
