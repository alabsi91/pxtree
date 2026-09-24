import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readingGuideText } from '../src/guide.ts';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));

let client: Client;

before(async () => {
  client = new Client({ name: 'pxtree-test', version: '0.0.0' });

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

function getResultText(result: Awaited<ReturnType<Client['callTool']>>): string {
  const textContent = (result.content as Array<{ type: string; text: string }>).filter((contentItem) => contentItem.type === 'text');

  return textContent.map((contentItem) => contentItem.text).join('\n');
}

test('lists a short measure tool and a guide tool', async () => {
  const { tools } = await client.listTools();
  const measureTool = tools.find((tool) => tool.name === 'measure')!;

  assert.deepEqual(tools.map((tool) => tool.name), ['measure', 'guide']);
  assert.ok(Buffer.byteLength(measureTool.description ?? '') < 1500, measureTool.description);
  assert.match(measureTool.description ?? '', /call the guide tool once before the first measure/i);
  assert.match(measureTool.description ?? '', /If the pxtree skill is loaded, skip the guide tool/);
  assert.ok('target' in (measureTool.inputSchema.properties ?? {}));
});

test('the guide tool returns the reading guide', async () => {
  const result = await client.callTool({ name: 'guide', arguments: {} });

  assert.equal(getResultText(result), readingGuideText);
});

test('measure returns the formatted report', async () => {
  const result = await client.callTool({ name: 'measure', arguments: { target: 'test/fixtures/state.html', viewports: [{ width: 390, height: 844 }], diff: false } });
  const reportLines = getResultText(result).split('\n');

  assert.notEqual(result.isError, true, getResultText(result));
  assert.ok(reportLines[0].startsWith('390x844 light dpr 1 ltr'), reportLines[0]);
  assert.ok(reportLines.some((line) => line.startsWith('body ')), reportLines.join('\n'));
  assert.ok(!reportLines.some((line) => line.startsWith('since last run:')), reportLines.join('\n'));
});

test('measure with report summary and aria returns the summary and the aria tree without the tree', async () => {
  const result = await client.callTool({ name: 'measure', arguments: { target: 'test/fixtures/state.html', diff: false, report: 'summary', aria: true } });
  const reportLines = getResultText(result).split('\n');
  const summaryPosition = reportLines.findIndex((line) => line.startsWith('summary:'));
  const ariaPosition = reportLines.indexOf('aria:');

  assert.ok(summaryPosition > 0, reportLines.join('\n'));
  assert.ok(ariaPosition > summaryPosition, reportLines.join('\n'));
  assert.equal(reportLines[ariaPosition + 1], '- button "Menu"');
  assert.ok(!reportLines.some((line) => line.startsWith('body ')), reportLines.join('\n'));
});

test('measure with report none and neither aria nor screenshot returns a tool error', async () => {
  const result = await client.callTool({ name: 'measure', arguments: { target: 'test/fixtures/state.html', report: 'none' } });

  assert.equal(result.isError, true);
});

test('the server carries standing instructions', () => {
  const instructions = client.getInstructions() ?? '';

  assert.match(instructions, /after every CSS or markup change/);
  assert.match(instructions, /\nNothing to change: one line like /);
  assert.match(instructions, /\nChanges made: one line per change, what and where, then one line per decision the user must make\.\n/);
  assert.match(instructions, /\nNever explain why a finding was fine\./);
  assert.match(instructions, /If the pxtree skill is loaded, skip the guide tool/);
});

test('measure takes an array of scroll stops and returns one run per stop', async () => {
  const result = await client.callTool({ name: 'measure', arguments: { target: 'test/fixtures/reveal.html', diff: false, report: 'summary', scroll: [0, 'end'] } });
  const runBlocks = getResultText(result).split('\n\n');

  assert.notEqual(result.isError, true, getResultText(result));
  assert.deepEqual(
    runBlocks.map((runBlock) => runBlock.match(/scroll \d+\/\d+/)?.[0]),
    ['scroll 0/2800', 'scroll 2800/2800'],
  );
});

test('inputs are bounded: viewport sides, viewport count and timeout', async () => {
  const tooWide = await client.callTool({ name: 'measure', arguments: { target: 'test/fixtures/state.html', viewports: [{ width: 10001, height: 800 }] } });
  const tooMany = await client.callTool({
    name: 'measure',
    arguments: { target: 'test/fixtures/state.html', viewports: Array.from({ length: 11 }, () => ({ width: 400, height: 300 })) },
  });
  const tooLong = await client.callTool({ name: 'measure', arguments: { target: 'test/fixtures/state.html', timeout: 120001 } });

  assert.equal(tooWide.isError, true);
  assert.equal(tooMany.isError, true);
  assert.equal(tooLong.isError, true);
});

test('a file target outside the working directory returns a tool error', async () => {
  const outsidePath = await client.callTool({ name: 'measure', arguments: { target: '../outside.html', diff: false } });
  const outsideUrl = await client.callTool({ name: 'measure', arguments: { target: 'file:///etc/hostname', diff: false } });

  assert.equal(outsidePath.isError, true);
  assert.equal(getResultText(outsidePath), 'file target outside the working directory: ../outside.html');
  assert.equal(outsideUrl.isError, true);
});

test('report findings prints only lines with findings and their ancestors', async () => {
  const result = await client.callTool({ name: 'measure', arguments: { target: 'test/fixtures/dedup.html', diff: false, report: 'findings' } });
  const reportLines = getResultText(result).split('\n');

  assert.notEqual(result.isError, true, getResultText(result));
  assert.ok(reportLines.includes('body'), reportLines.join('\n'));
  assert.ok(!reportLines.some((line) => line.includes('li.tile')), reportLines.join('\n'));
});

test('a bad target returns a tool error with the CLI message', async () => {
  const result = await client.callTool({ name: 'measure', arguments: { target: 'test/fixtures/no-such-page.html', diff: false } });

  assert.equal(result.isError, true);
  assert.ok(getResultText(result).startsWith('could not load file://'), getResultText(result));
});
