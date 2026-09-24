import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import type { Page } from 'playwright-core';
import { createSession, type Session } from 'pxtree';

import { findLine, formatFixture } from './helpers.ts';

// landing-bugs.html is a landing page with six planted bugs.
// 1. The price card buttons sit at different heights.
// 2. The hero h1 does not wrap on mobile.
// 3. The nav CTA runs off the viewport on mobile.
// 4. One footer column has low contrast in dark.
// 5. The sticky nav covers the #pricing heading.
// 6. The demo dialog body cuts off its form.

let session: Session;
let temporaryDirectory: string;

before(async () => {
  session = await createSession();
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'pxtree-landing-'));
});

after(async () => {
  await session.close();
  await rm(temporaryDirectory, { recursive: true, force: true });
});

function getSummaryLines(reportLines: string[]): string[] {
  return reportLines.filter((line) => line.startsWith('  ') && !line.startsWith('    '));
}

describe('landing-bugs.html at two viewports and two schemes, scrolled to #pricing', () => {
  let reportLines: string[];
  let output: string;

  before(async () => {
    reportLines = await formatFixture(session, 'landing-bugs', {
      viewports: [
        { width: 390, height: 844 },
        { width: 1280, height: 800 },
      ],
      colorSchemes: ['light', 'dark'],
      scroll: '#pricing',
    });
    output = reportLines.join('\n');
  });

  test('the price card buttons have tops that spread across the cards, and the top-aligned cards are not off center', () => {
    assert.match(output, /\n {2}a\.button\.button-secondary tops \d+\.\.\d+ across siblings: div\.pricing-grid\n/);
    assert.doesNotMatch(output, /off center/);
  });

  test('the facts line names the widest cause of sideways scroll, and text ink counts as past viewport', () => {
    assert.match(findLine(reportLines, '390x844 light'), / sideways 150 by section#features\.hero h1( |$)/);
    assert.match(output, /\n {2}past viewport end 42\.\.150 ×2: a\.button-primary\.nav-cta, section#features\.hero h1\n/);
  });

  test('the sticky nav covers the heading once, and its own links do not repeat it', () => {
    assert.match(output, /\n {2}covered 100% by header\.site-nav: h2#pricing\n/);
    assert.doesNotMatch(output, /translucent/);
    assert.doesNotMatch(output, /covered \S+ by a[ .]/);
  });

  test('the dark footer column has low contrast, named with its context', () => {
    assert.match(output, /\n {2}contrast 2\.1 ×3, text #4a4f58: div\.footer-legal li\n/);
  });

  test('the nav CTA overflows top and bottom as one fact', () => {
    assert.match(output, /\n {2}overflows parent top and bottom 13: a\.button-primary\.nav-cta\n/);
    assert.doesNotMatch(output, /overflows parent top 13/);
  });

  test('a dark run whose tree matches light prints only the lines whose findings differ', () => {
    const darkStart = reportLines.findIndex((line) => line.startsWith('390x844 dark'));
    const nextRunStart = reportLines.findIndex((line, position) => position > darkStart && line.startsWith('1280x800 light'));
    const darkLines = reportLines.slice(darkStart, nextRunStart - 1);

    assert.ok(darkLines.includes('tree: same as light, differences:'), darkLines.join('\n'));
    assert.deepEqual(
      darkLines.slice(darkLines.indexOf('tree: same as light, differences:') + 1).map((line) => line.trim().split(' ')[0]),
      ['li', 'li', 'li'],
    );
  });

  test('each run keeps its own summary and there is no across block', () => {
    const darkContrastLines = reportLines.filter((line) => line === '  contrast 2.1 ×3, text #4a4f58: div.footer-legal li');

    assert.ok(!reportLines.includes('across runs:'), reportLines.join('\n'));
    assert.equal(darkContrastLines.length, 2, reportLines.join('\n'));
  });

  test('every planted bug outside the dialog reaches a summary', () => {
    const summaryLines = getSummaryLines(reportLines);
    const plantedSummaryPatterns = [/^ {2}a\.button\.button-secondary tops/,/^ {2}text overflows end \d+: section#features\.hero h1/, /^ {2}past viewport end/, /^ {2}contrast/, /^ {2}covered 100% by header\.site-nav/];

    for (const pattern of plantedSummaryPatterns) {
      assert.ok(summaryLines.some((line) => pattern.test(line)), `${pattern} in:\n${output}`);
    }
  });
});

describe('landing-bugs.html with the demo dialog open', () => {
  let reportLines: string[];

  before(async () => {
    reportLines = await formatFixture(session, 'landing-bugs', {
      viewports: [{ width: 390, height: 844 }],
      script: "await page.click('#open-demo')",
    });
  });

  test('the dialog body cutting its form reaches the summary', () => {
    assert.ok(reportLines.includes('  clipped bottom 34 by form.modal-body: input#demo-email'), reportLines.join('\n'));
    assert.ok(reportLines.includes('  clipped out by form.modal-body ×3: form.modal-body label, input#demo-size, div.modal-actions'), reportLines.join('\n'));
  });

  test('the clipper counts the children it cuts, and a clipped-out line carries the finding instead of the tag', () => {
    assert.match(findLine(reportLines, 'form.modal-body '), /\[clips 4 of 9 children\]/);
    assert.equal(findLine(reportLines, 'div.modal-actions ').includes('[clipped out by'), false);
  });
});

describe('landing-bugs.html screenshot and since last run', () => {
  test('the facts line names the screenshot and its size', async () => {
    const screenshotPath = join(temporaryDirectory, 'landing.png');
    const reportLines = await formatFixture(session, 'landing-bugs', { viewports: [{ width: 390, height: 844 }], screenshotPath });

    assert.ok(findLine(reportLines, '390x844 light').endsWith(` screenshot ${screenshotPath} 390x844`), reportLines[0]);
  });

  test('a fix prints fixed:, and the boxes it pushes down collapse into one line', async () => {
    const options = {
      viewports: [{ width: 390, height: 844 }],
      cacheDirectory: join(temporaryDirectory, 'cache'),
      scriptCacheText: 'landing diff',
    };
    const wrapHeading = async (page: Page) => {
      await page.addStyleTag({ content: '.hero h1 { white-space: normal; }' });
    };

    await formatFixture(session, 'landing-bugs', { ...options, script: async () => {} });

    const reportLines = await formatFixture(session, 'landing-bugs', { ...options, script: wrapHeading });
    const output = reportLines.join('\n');

    assert.match(findLine(reportLines, '~ body>main>section#features.hero>div.container>h1 '), /findings gone: text overflows end 166; past viewport end 150/);
    assert.match(output, /\n {2}~ \d+ boxes from \S+ down moved \d+ down\n/);
    assert.doesNotMatch(output, /none was \[!!/);
  });
});
