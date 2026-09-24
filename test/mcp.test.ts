import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createSkillText } from '../scripts/skill.ts';
import { reportingRulesText, skillBodyText } from '../src/guide.ts';

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

test('lists a short measure tool and a read_me_first tool', async () => {
  const { tools } = await client.listTools();
  const measureTool = tools.find((tool) => tool.name === 'measure')!;
  const readMeFirstTool = tools.find((tool) => tool.name === 'read_me_first')!;
  const measureDescription = measureTool.description ?? '';

  assert.deepEqual(tools.map((tool) => tool.name), ['measure', 'read_me_first']);
  assert.ok(measureDescription.length < 800, `${measureDescription.length} characters`);
  assert.match(measureDescription, /Call read_me_first once per session before the first measure/);
  assert.doesNotMatch(measureDescription, /skill/);
  assert.equal(readMeFirstTool.description, 'Read once per session before the first measure. How to use pxtree and how to read its output.');
  assert.ok('target' in (measureTool.inputSchema.properties ?? {}));
});

test('the read_me_first tool returns the skill body without its frontmatter', async () => {
  const result = await client.callTool({ name: 'read_me_first', arguments: {} });
  const resultText = getResultText(result);

  assert.equal(resultText, skillBodyText);
  assert.equal(createSkillText().replace(/^---\n[\s\S]*?\n---\n\n/, ''), resultText);
  assert.ok(resultText.includes(reportingRulesText), 'carries the reporting shapes');
  assert.match(resultText, /\| CLI flag \| MCP input \| meaning \|/);
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

  assert.match(instructions, /^pxtree measures how a webpage actually renders/);
  assert.match(instructions, /Call read_me_first once per session before measuring\.$/);
  assert.doesNotMatch(instructions, /skill/);
  assert.ok(instructions.length < 300, `${instructions.length} characters`);
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

test('measure takes a digit string scroll stop as a y offset', async () => {
  const result = await client.callTool({ name: 'measure', arguments: { target: 'test/fixtures/reveal.html', diff: false, report: 'summary', scroll: '900' } });

  assert.notEqual(result.isError, true, getResultText(result));
  assert.match(getResultText(result), /scroll 900\/2800/);
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
  const upperCaseUrl = await client.callTool({ name: 'measure', arguments: { target: 'FILE:///etc/hostname', diff: false } });

  assert.equal(outsidePath.isError, true);
  assert.equal(getResultText(outsidePath), 'file target outside the working directory: ../outside.html');
  assert.equal(outsideUrl.isError, true);
  assert.equal(getResultText(upperCaseUrl), 'file target outside the working directory: FILE:///etc/hostname');
});

test('report findings prints only lines with findings and their ancestors', async () => {
  const result = await client.callTool({ name: 'measure', arguments: { target: 'test/fixtures/dedup.html', diff: false, report: 'findings' } });
  const reportLines = getResultText(result).split('\n');

  assert.notEqual(result.isError, true, getResultText(result));
  assert.ok(reportLines.includes('body'), reportLines.join('\n'));
  assert.ok(!reportLines.some((line) => line.includes('li.tile')), reportLines.join('\n'));
});

test('parallel measure calls run one at a time and each returns its own result', async () => {
  const countOpenContextsScript = `
    await page.waitForTimeout(300);
    const openContextCount = page.context().browser().contexts().length;
    await page.evaluate((text) => document.body.append(Object.assign(document.createElement('p'), { textContent: text })), 'contexts ' + openContextCount);
  `;
  const viewportWidths = [390, 768, 1280];

  const results = await Promise.all(
    viewportWidths.map((width) =>
      client.callTool({
        name: 'measure',
        arguments: { target: 'test/fixtures/state.html', viewports: [{ width, height: 800 }], script: countOpenContextsScript, element: 'p', diff: false },
      }),
    ),
  );

  for (const [index, result] of results.entries()) {
    const resultText = getResultText(result);

    assert.notEqual(result.isError, true, resultText);
    assert.ok(resultText.startsWith(`${viewportWidths[index]}x800 light`), resultText);
    assert.match(resultText, /p "contexts 1"/);
  }
});

test('a page that hangs times out and the next call still measures', async () => {
  const hangResult = await client.callTool({ name: 'measure', arguments: { target: 'test/fixtures/node-hang.html', diff: false, timeout: 3000 } });
  const nextResult = await client.callTool({ name: 'measure', arguments: { target: 'test/fixtures/state.html', diff: false, report: 'none', aria: true } });

  assert.equal(hangResult.isError, true);
  assert.match(getResultText(hangResult), /^measurement timed out after 3000 ms during \w+$/);
  assert.notEqual(nextResult.isError, true, getResultText(nextResult));
});

test('SIGTERM closes the browser, removes the screenshot directory and exits 143', async () => {
  const signalClient = new Client({ name: 'pxtree-signal-test', version: '0.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectDirectory, 'dist', 'cli.js'), 'mcp'], cwd: projectDirectory });
  await signalClient.connect(transport);

  const result = await signalClient.callTool({ name: 'measure', arguments: { target: 'test/fixtures/state.html', diff: false, report: 'summary', screenshot: true } });
  const screenshotPath = getResultText(result).match(/screenshot: (\S+)/)![1];
  const serverProcessId = transport.pid!;
  const browserProcessIds = execFileSync('pgrep', ['-P', String(serverProcessId)], { encoding: 'utf8' }).trim().split('\n');

  process.kill(serverProcessId, 'SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 3000));

  const isRunning = (processId: number) => {
    try {
      process.kill(processId, 0);
      return true;
    } catch {
      return false;
    }
  };

  assert.equal(isRunning(serverProcessId), false);
  assert.ok(browserProcessIds.every((processId) => !isRunning(Number(processId))), browserProcessIds.join(' '));
  assert.equal(existsSync(dirname(screenshotPath)), false);
  await signalClient.close();
});

test('a bad target returns a tool error with the CLI message', async () => {
  const result = await client.callTool({ name: 'measure', arguments: { target: 'test/fixtures/no-such-page.html', diff: false } });

  assert.equal(result.isError, true);
  assert.ok(getResultText(result).startsWith('could not load file://'), getResultText(result));
});
