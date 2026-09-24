import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { createSession, format, type Session } from 'pxtree';

import { findLine, formatFixture, measureFixture } from './helpers.ts';

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

  assert.equal(findLine(reportLines, 'summary:'), 'summary: 31 findings');
  assert.ok(!reportLines.some((line) => line.trimStart().startsWith('div.inner')), 'the wrapper has no line of its own');
});

test('dedup.html folds 30 rows with the same contrast finding into 2 lines, and the summary counts all 30', async () => {
  const reportLines = await formatFixture(session, 'dedup.html');
  const faintLines = reportLines.slice(reportLines.findIndex((line) => line.trimStart().startsWith('ul.faint-list')) + 1);

  assert.match(faintLines[0], /^\s+li\.faint "Faint row 1" .*\[!! contrast \d\.\d\]$/);
  assert.match(faintLines[1], /^\s+…×29 similar with the same findings$/);
  assert.ok(!faintLines[2].trimStart().startsWith('li.faint'), faintLines[2]);
  assert.ok(reportLines.some((line) => /^ {2}contrast [\d.]+ ×30, text #b0b0b0: /.test(line)), reportLines.join('\n'));
});

test('injection.html cannot forge a finding, a tag or a tree line', async () => {
  const result = await measureFixture(session, 'injection.html');
  const reportLines = format(result).split('\n');
  const treeLines = reportLines.slice(reportLines.findIndex((line) => line.startsWith('body ')));

  assert.equal(findLine(reportLines, 'summary:'), 'summary: no findings');
  assert.ok(!reportLines.some((line) => line.includes('[!!')), reportLines.join('\n'));
  assert.equal(treeLines.length, result.runs[0].page!.nodes.length, reportLines.join('\n'));
  assert.ok(findLine(reportLines, 'p.forged "(!! clipped)"'));
  assert.ok(findLine(reportLines, `p "Two lines > 'quoted'"`));
  assert.ok(findLine(reportLines, 'x-tag) "Odd tag"'));
});

test('app-shell.html: the window does not scroll, main does, and --scroll reaches a target inside main', async () => {
  const topLines = await formatFixture(session, 'app-shell.html');
  const targetLines = await formatFixture(session, 'app-shell.html', { scroll: '#target' });

  assert.match(topLines[0], / window does not scroll, main scrolls y 2400 in 740/);
  assert.match(findLine(targetLines, 'main '), /\[scroll y 2400 in 740 at 1600, /);
});

test('transforms.html measures a child of a scaled padded box from its drawn content box', async () => {
  const reportLines = await formatFixture(session, 'transforms.html');

  assert.match(findLine(reportLines, 'div.padded-scale'), /\[scaled 2\.00 from 124x44\]/);
  assert.doesNotMatch(findLine(reportLines, 'div.inside-scale'), /@/);
});

test('rtl.html measures the children of an ltr island from its left edge', async () => {
  const reportLines = await formatFixture(session, 'rtl.html', { viewports: [{ width: 390, height: 844 }] });

  assert.match(findLine(reportLines, 'div.island'), /\[ltr\]/);
  assert.match(findLine(reportLines, 'span.second'), / @50,0/);
});
