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

test('measure with summary drops the tree', async () => {
  const result = await client.callTool({ name: 'measure', arguments: { target: 'test/fixtures/state.html', diff: false, summary: true } });
  const reportLines = getResultText(result).split('\n');

  assert.ok(reportLines.some((line) => line.startsWith('summary:')), reportLines.join('\n'));
  assert.ok(!reportLines.some((line) => line.startsWith('body ')), reportLines.join('\n'));
});

test('a bad target returns a tool error with the CLI message', async () => {
  const result = await client.callTool({ name: 'measure', arguments: { target: 'test/fixtures/no-such-page.html', diff: false } });

  assert.equal(result.isError, true);
  assert.ok(getResultText(result).startsWith('could not load file://'), getResultText(result));
});
