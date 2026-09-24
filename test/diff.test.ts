import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import type { Page } from 'playwright-core';
import { createSession, type Session } from 'pxtree';

import { findLine, formatFixture } from './helpers.ts';

let session: Session;
let cacheDirectory: string;

before(async () => {
  session = await createSession();
  cacheDirectory = await mkdtemp(join(tmpdir(), 'pxtree-diff-'));
});

after(async () => {
  await session.close();
  await rm(cacheDirectory, { recursive: true, force: true });
});

async function leavePageAsIs(): Promise<void> {}

async function changePage(page: Page): Promise<void> {
  await page.evaluate(() => {
    const lead = document.querySelector<HTMLElement>('.lead')!;
    const note = document.createElement('aside');

    lead.style.width = '300px';
    note.className = 'note';
    note.textContent = 'Changed';
    document.body.append(note);
  });
}

test('since last run reports first run, no changes, then what the script changed', async () => {
  const options = { cacheDirectory, scriptCacheText: 'diff test' };

  const firstLines = await formatFixture(session, 'simple.html', { ...options, script: leavePageAsIs });

  assert.equal(findLine(firstLines, 'since last run:'), 'since last run: first run');

  const secondLines = await formatFixture(session, 'simple.html', { ...options, script: leavePageAsIs });

  assert.equal(findLine(secondLines, 'since last run:'), 'since last run: no changes');

  const thirdLines = await formatFixture(session, 'simple.html', { ...options, script: changePage });

  assert.ok(findLine(thirdLines, 'since last run:').includes('1 new'), thirdLines.join('\n'));
  assert.ok(findLine(thirdLines, '+ body>aside.note '));
  assert.ok(findLine(thirdLines, '~ body>main>section.hero>p.lead 300x'));
});

test('a diff key lets a scripted run with a wait compare with a plain run of the same key', async () => {
  const plainLines = await formatFixture(session, 'simple.html', { cacheDirectory, diffKey: 'baseline' });
  const scriptedLines = await formatFixture(session, 'simple.html', { cacheDirectory, diffKey: 'baseline', script: changePage, wait: 10 });
  const otherKeyLines = await formatFixture(session, 'simple.html', { cacheDirectory, diffKey: 'other', script: changePage });

  assert.equal(findLine(plainLines, 'since last run:'), 'since last run: first run');
  assert.ok(findLine(scriptedLines, '+ body>aside.note '), scriptedLines.join('\n'));
  assert.equal(findLine(otherKeyLines, 'since last run:'), 'since last run: first run');
});
