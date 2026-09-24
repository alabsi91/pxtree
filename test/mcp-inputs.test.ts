import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const revealFixturePath = 'test/fixtures/reveal.html';

let client: Client;

before(async () => {
  client = new Client({ name: 'pxtree-inputs-test', version: '0.0.0' });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(projectDirectory, 'dist', 'cli.js'), 'mcp'],
    cwd: projectDirectory,
    stderr: 'inherit',
  });

  await client.connect(transport);
});

after(async () => {
  await client.close();
});

interface MeasureCallOutcome {
  isError: boolean;
  text: string;
}

async function callMeasure(measureArguments: Record<string, unknown>): Promise<MeasureCallOutcome> {
  const result = await client.callTool({ name: 'measure', arguments: { target: revealFixturePath, diff: false, ...measureArguments } });
  const textContent = (result.content as Array<{ type: string; text: string }>).filter((contentItem) => contentItem.type === 'text');
  const text = textContent.map((contentItem) => contentItem.text).join('\n');

  return { isError: result.isError === true, text };
}

async function assertMeasureSucceeds(measureArguments: Record<string, unknown>, expectedPattern: RegExp): Promise<string> {
  const { isError, text } = await callMeasure(measureArguments);

  assert.equal(isError, false, text);
  assert.match(text, expectedPattern);

  return text;
}

async function assertMeasureFailsNamingInput(measureArguments: Record<string, unknown>, inputName: string): Promise<void> {
  const { isError, text } = await callMeasure(measureArguments);

  assert.equal(isError, true, text);
  assert.match(text, new RegExp(inputName));
}

function getScrollFacts(reportText: string): Array<string | undefined> {
  return reportText
    .split('\n')
    .filter((reportLine) => /^\d+x\d+ /.test(reportLine))
    .map((factsLine) => factsLine.match(/scroll \d+\/\d+/)?.[0]);
}

test('viewports as width and height numbers', async () => {
  await assertMeasureSucceeds({ viewports: [{ width: 390, height: 844 }], report: 'none', aria: true }, /^390x844 light/);
});

test('viewports without a height, or with digit strings, fail naming viewports', async () => {
  await assertMeasureFailsNamingInput({ viewports: [{ width: 390 }] }, 'viewports');
  await assertMeasureFailsNamingInput({ viewports: [{ width: '390', height: '844' }] }, 'viewports');
});

test('schemes light and dark give one run each', async () => {
  await assertMeasureSucceeds({ schemes: ['light', 'dark'], report: 'summary' }, /^1280x800 light[\s\S]*\n1280x800 dark/);
});

test('scroll as a digit string, a number, a selector, end, and a mixed array', async () => {
  const digitStringText = await assertMeasureSucceeds({ scroll: '900', report: 'summary' }, /scroll 900\/2800/);
  const numberText = await assertMeasureSucceeds({ scroll: 900, report: 'summary' }, /scroll 900\/2800/);
  const selectorText = await assertMeasureSucceeds({ scroll: '.feature-two', report: 'summary' }, /scroll 1800\/2800/);
  const endText = await assertMeasureSucceeds({ scroll: 'end', report: 'summary' }, /scroll 2800\/2800/);
  const mixedText = await assertMeasureSucceeds({ scroll: ['0', 900, '.feature-two', 'end'], report: 'summary' }, /scroll/);

  assert.deepEqual(getScrollFacts(digitStringText), ['scroll 900/2800']);
  assert.deepEqual(getScrollFacts(numberText), ['scroll 900/2800']);
  assert.deepEqual(getScrollFacts(selectorText), ['scroll 1800/2800']);
  assert.deepEqual(getScrollFacts(endText), ['scroll 2800/2800']);
  assert.deepEqual(getScrollFacts(mixedText), ['scroll 0/2800', 'scroll 900/2800', 'scroll 1800/2800', 'scroll 2800/2800']);
});

test('scroll with a selector that is not valid CSS fails with one line', async () => {
  const { isError, text } = await callMeasure({ scroll: '9px0' });

  assert.equal(isError, true);
  assert.equal(text, 'scroll failed: 9px0 is not a valid selector');
});

test('element with children false prints the match without its content', async () => {
  const reportText = await assertMeasureSucceeds({ element: '.feature-two', children: false }, /section\.reveal\.feature-two/);

  assert.doesNotMatch(reportText, /Second feature/);
});

test('colors adds hex colors to text', async () => {
  await assertMeasureSucceeds({ element: 'h1', colors: true }, /#000000 on #ffffff/);
});

test('wait as a number, a digit string and a selector', async () => {
  await assertMeasureSucceeds({ wait: 500, report: 'summary' }, /^1280x800 light/);
  await assertMeasureSucceeds({ wait: '500', report: 'summary' }, /^1280x800 light/);
  await assertMeasureSucceeds({ wait: 'h2', report: 'summary' }, /^1280x800 light/);
});

test('script runs before measuring', async () => {
  await assertMeasureSucceeds({ script: 'await page.evaluate(() => window.scrollTo(0, 900));', report: 'summary' }, /^1280x800 light/);
});

test('screenshot returns a PNG path', async () => {
  await assertMeasureSucceeds({ screenshot: true, report: 'summary' }, /screenshot: .+\.png/);
});

test('timeout as a number, and as a digit string fails naming timeout', async () => {
  await assertMeasureSucceeds({ timeout: 20000, report: 'summary' }, /^1280x800 light/);
  await assertMeasureFailsNamingInput({ timeout: '20000' }, 'timeout');
});

test('diffKey is accepted with diff on', async () => {
  await assertMeasureSucceeds({ diff: true, diffKey: 'mcp-inputs', report: 'summary' }, /^1280x800 light/);
});

test('report takes each of its five values', async () => {
  await assertMeasureSucceeds({ report: 'tree' }, /\nbody 1280x3600/);
  await assertMeasureSucceeds({ report: 'findings' }, /^1280x800 light[\s\S]*summary:/);
  await assertMeasureSucceeds({ report: 'summary' }, /summary: /);
  await assertMeasureSucceeds({ report: 'changes' }, /^1280x800 light/);
  await assertMeasureSucceeds({ report: 'none', aria: true }, /^1280x800 light/);
});

test('aria adds the aria tree after the report', async () => {
  await assertMeasureSucceeds({ aria: true, report: 'summary' }, /aria:\n- heading "Top of the page"/);
});
