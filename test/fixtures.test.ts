import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { createSession, type Session } from 'pxtree';

import { findLine, formatFixture } from './helpers.ts';

let session: Session;

before(async () => {
  session = await createSession();
});

after(async () => {
  await session.close();
});

test('simple.html prints positions, padding, gaps and text with no findings', async () => {
  const reportLines = await formatFixture(session, 'simple.html');

  assert.ok(reportLines[0].startsWith('1280x800 light dpr 1 ltr scroll 0/'), reportLines[0]);
  assert.ok(!reportLines.some((line) => line.startsWith('since last run')), 'cache is off');
  assert.equal(findLine(reportLines, 'summary:'), 'summary: no findings');
  assert.ok(!reportLines.some((line) => line.includes('[!!')), reportLines.join('\n'));

  const headerLine = findLine(reportLines, 'header.site ');

  assert.ok(headerLine.includes('[pad 12 24]'), headerLine);
  assert.ok(headerLine.includes('[gaps across 48'), headerLine);
  assert.ok(headerLine.includes('[renders background, border-bottom]'), headerLine);
  assert.match(findLine(reportLines, 'nav '), /@\d+,0 \[gaps across 24/);

  assert.ok(findLine(reportLines, 'section.hero ').includes('[pad 64 120][gaps 16]'));
  assert.ok(findLine(reportLines, 'h1 "Ship faster"').includes('[text 40/48]'));

  const leadLine = findLine(reportLines, 'p.lead ');

  assert.ok(leadLine.includes('@0,64'), leadLine);
  assert.ok(leadLine.includes('[text 18/28]'), leadLine);

  const cardLine = findLine(reportLines, 'li.card ');

  assert.ok(cardLine.includes('[pad 16][gaps 8][renders background, border]'), cardLine);
  assert.ok(cardLine.endsWith(' ×3'), cardLine);
});

test('dedup.html folds identical, similar and wrapper lines but never a finding', async () => {
  const reportLines = await formatFixture(session, 'dedup.html');

  assert.ok(findLine(reportLines, 'li.tile ').endsWith(' ×12'));
  assert.ok(findLine(reportLines, 'li.row "Row 1"'));
  assert.ok(findLine(reportLines, '…×29 similar li.row '));
  assert.ok(findLine(reportLines, 'div.outer › div.inner › a.cta "Get started" 200x40'));

  assert.ok(findLine(reportLines, 'li.badge "New"'));
  assert.ok(findLine(reportLines, 'li.badge "Beta"').includes('[!! contrast '));
  assert.ok(findLine(reportLines, '…×3 similar li.badge '));

  assert.equal(findLine(reportLines, 'summary:'), 'summary: 1 finding');
  assert.ok(!reportLines.some((line) => line.trimStart().startsWith('div.inner')), 'the wrapper has no line of its own');
});
