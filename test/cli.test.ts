import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createSkillText, skillFileUrl } from '../scripts/skill.ts';
import { readingGuideText } from '../src/guide.ts';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const cliPath = join(projectDirectory, 'dist', 'cli.js');
const stateFixturePath = 'test/fixtures/state.html';

interface CommandOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

let temporaryDirectory: string;
let notFoundServer: Server;
let notFoundUrl: string;

before(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'pxtree-cli-'));

  notFoundServer = createServer((_request, response) => {
    response.writeHead(404, { 'content-type': 'text/html' });
    response.end('<!doctype html><body><h1>Not found</h1></body>');
  });

  await new Promise<void>((resolve) => notFoundServer.listen(0, '127.0.0.1', resolve));
  notFoundUrl = `http://127.0.0.1:${(notFoundServer.address() as AddressInfo).port}/missing`;
});

after(async () => {
  notFoundServer.close();
  await rm(temporaryDirectory, { recursive: true, force: true });
});

function runCli(commandArguments: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<CommandOutput> {
  const executionOptions = {
    cwd: options.cwd ?? projectDirectory,
    env: { ...process.env, ...options.env },
    maxBuffer: 64 * 1024 * 1024,
  };

  return new Promise((resolve) => {
    execFile(process.execPath, [cliPath, ...commandArguments], executionOptions, (error, stdout, stderr) => {
      const exitCode = error === null ? 0 : Number(error.code);
      resolve({ exitCode, stdout, stderr });
    });
  });
}

function assertSingleErrorLine(output: CommandOutput, expectedExitCode: number, expectedStart: string): void {
  assert.equal(output.exitCode, expectedExitCode, output.stderr);
  assert.equal(output.stdout, '');
  assert.equal(output.stderr.trimEnd().split('\n').length, 1, output.stderr);
  assert.ok(output.stderr.startsWith(expectedStart), output.stderr);
}

test('an unknown flag exits 1 with one error line', async () => {
  assertSingleErrorLine(await runCli([stateFixturePath, '--bogus']), 1, "Unknown option '--bogus'");
});

test('a bad viewport exits 1', async () => {
  assertSingleErrorLine(await runCli([stateFixturePath, '--viewport', '1280by800']), 1, 'bad viewport: 1280by800');
});

test('a zero viewport exits 1 and says the size must be positive', async () => {
  assertSingleErrorLine(await runCli([stateFixturePath, '--viewport', '0x0']), 1, 'bad viewport: 0x0, width and height must be positive');
});

test('a viewport with a capital X measures', async () => {
  const output = await runCli([stateFixturePath, '--no-diff', '--viewport', '400X300']);

  assert.equal(output.exitCode, 0, output.stderr);
  assert.ok(output.stdout.startsWith('400x300 light'), output.stdout);
});

test('a width alone gets its device height, or 800', async () => {
  const output = await runCli([stateFixturePath, '--no-diff', '--report', 'none', '--aria', '--viewport', '390,1000']);
  const factsLines = output.stdout.split('\n').filter((line) => /^\d+x\d+ light/.test(line));

  assert.equal(output.exitCode, 0, output.stderr);
  assert.deepEqual(factsLines.map((line) => line.split(' ')[0]), ['390x844', '1000x800']);
});

test('a directory target exits 1 with one line', async () => {
  assertSingleErrorLine(await runCli(['test/fixtures']), 1, 'target is a directory: test/fixtures');
});

test('a file path with a query measures the file', async () => {
  const output = await runCli([`${stateFixturePath}?tab=2`, '--no-diff', '--report', 'findings']);

  assert.equal(output.exitCode, 0, output.stderr);
  assert.ok(output.stdout.startsWith('1280x800 light dpr 1 ltr'), output.stdout);
});

test('--element with no match prints the report and exits 2 with the no match line last', async () => {
  const output = await runCli([stateFixturePath, '--no-diff', '--element', '.no-such-element']);

  assert.equal(output.exitCode, 2, output.stderr);
  assert.ok(output.stdout.startsWith('1280x800 light'), output.stdout);
  assert.ok(output.stdout.trimEnd().endsWith('no element matches .no-such-element'), output.stdout);
  assert.equal(output.stderr, 'no element matches .no-such-element\n');
});

test('--screenshot with several element matches captures the viewport and says why', async () => {
  const screenshotPath = join(temporaryDirectory, 'buttons.png');
  const output = await runCli([stateFixturePath, '--no-diff', '--element', 'button', '--screenshot', screenshotPath]);

  assert.equal(output.exitCode, 0, output.stderr);
  assert.equal(output.stderr, '');
  assert.ok(output.stdout.split('\n')[0].endsWith(` screenshot ${screenshotPath} 1280x800 (viewport, selector matched 2)`), output.stdout);
});

test('a missing script file exits 1', async () => {
  assertSingleErrorLine(await runCli([stateFixturePath, '--script', './no-such-script.mjs']), 1, 'script file not found: ./no-such-script.mjs');
});

test('a missing target file exits 2 with could not load', async () => {
  assertSingleErrorLine(await runCli(['test/fixtures/no-such-page.html']), 2, 'could not load file://');
});

test('a throwing inline script exits 2 with script failed', async () => {
  assertSingleErrorLine(await runCli([stateFixturePath, '--no-diff', '--script', "throw new Error('nope')"]), 2, 'script failed: Error: nope');
});

test('a missing browser exits 3 with the install hint', async () => {
  const emptyBrowsersDirectory = join(temporaryDirectory, 'no-browsers');
  const output = await runCli([stateFixturePath, '--no-diff'], { env: { PLAYWRIGHT_BROWSERS_PATH: emptyBrowsersDirectory } });

  const playwrightVersion = JSON.parse(readFileSync(join(projectDirectory, 'node_modules/playwright-core/package.json'), 'utf8')).version;
  assertSingleErrorLine(output, 3, `could not launch chromium, run: npx -y playwright@${playwrightVersion} install chromium`);
});

test('--json prints the MeasureResult', async () => {
  const output = await runCli([stateFixturePath, '--no-diff', '--json']);
  assert.equal(output.exitCode, 0, output.stderr);

  const result = JSON.parse(output.stdout);
  assert.equal(result.error, null);
  assert.equal(result.runs.length, 1);
  assert.ok(result.target.startsWith('file://'));
  assert.ok(result.target.endsWith('/test/fixtures/state.html'));
});

test('a relative file path measures and prints the report', async () => {
  const output = await runCli([stateFixturePath, '--no-diff']);

  assert.equal(output.exitCode, 0, output.stderr);
  assert.equal(output.stderr, '');
  assert.ok(output.stdout.startsWith('1280x800 light dpr 1 ltr'), output.stdout);
  assert.doesNotMatch(output.stdout.split('\n')[0], / status /);
});

test('an HTTP 404 page measures with status 404 on the facts line', async () => {
  const output = await runCli([notFoundUrl, '--no-diff']);

  assert.equal(output.exitCode, 0, output.stderr);
  assert.match(output.stdout.split('\n')[0], / status 404/);
});

test('--out writes both files and prints only facts, summary and paths', async () => {
  const outDirectory = join(temporaryDirectory, 'out');
  const output = await runCli([stateFixturePath, '--no-diff', '--out', outDirectory]);
  assert.equal(output.exitCode, 0, output.stderr);

  const textPath = join(outDirectory, 'pxtree.txt');
  const jsonPath = join(outDirectory, 'pxtree.json');
  const stdoutLines = output.stdout.trimEnd().split('\n');

  assert.ok(stdoutLines[0].startsWith('1280x800 light'), output.stdout);
  assert.ok(stdoutLines.some((line) => line.startsWith('summary:')), output.stdout);
  assert.equal(stdoutLines.some((line) => line.startsWith('body ')), false, output.stdout);
  assert.deepEqual(stdoutLines.slice(-2), [textPath, jsonPath]);
  assert.ok(readFileSync(textPath, 'utf8').includes('\nbody '));
  assert.equal(JSON.parse(readFileSync(jsonPath, 'utf8')).runs.length, 1);
});

test('--report tree is the default and prints the tree', async () => {
  const defaultOutput = await runCli([stateFixturePath, '--no-diff']);
  const treeOutput = await runCli([stateFixturePath, '--no-diff', '--report', 'tree']);

  assert.equal(treeOutput.exitCode, 0, treeOutput.stderr);
  assert.ok(treeOutput.stdout.split('\n').some((line) => line.startsWith('body ')), treeOutput.stdout);
  assert.equal(treeOutput.stdout, defaultOutput.stdout);
});

test('--report summary prints no tree and --report changes prints only the facts line and since last run', async () => {
  const summaryOutput = await runCli([stateFixturePath, '--no-diff', '--report', 'summary']);
  const summaryLines = summaryOutput.stdout.trimEnd().split('\n');
  const changesOutput = await runCli([stateFixturePath, '--no-diff', '--report', 'changes']);

  assert.equal(summaryOutput.exitCode, 0, summaryOutput.stderr);
  assert.ok(summaryLines[0].startsWith('1280x800 light'), summaryOutput.stdout);
  assert.ok(summaryLines.some((line) => line.startsWith('summary:')), summaryOutput.stdout);
  assert.equal(summaryLines.some((line) => line.startsWith('body ')), false, summaryOutput.stdout);
  assert.equal(changesOutput.exitCode, 0, changesOutput.stderr);
  assert.deepEqual(changesOutput.stdout.trimEnd().split('\n'), [summaryLines[0]]);
});

test('--report none --aria prints only the facts line and the aria tree', async () => {
  const output = await runCli([stateFixturePath, '--no-diff', '--report', 'none', '--aria']);
  const outputLines = output.stdout.trimEnd().split('\n');

  assert.equal(output.exitCode, 0, output.stderr);
  assert.equal(outputLines[0], '1280x800 light dpr 1 not measured');
  assert.deepEqual(outputLines.slice(1, 3), ['aria:', '- button "Menu"']);
  assert.ok(outputLines.slice(3).every((line) => line.startsWith('- ') || line.startsWith('  ')), output.stdout);
});

test('--report none without --aria or --screenshot exits 1', async () => {
  assertSingleErrorLine(await runCli([stateFixturePath, '--report', 'none']), 1, '--report none prints nothing without --aria or --screenshot');
});

test('a bad --report exits 1', async () => {
  assertSingleErrorLine(await runCli([stateFixturePath, '--report', 'full']), 1, 'bad --report: full');
});

test('guide prints the reading guide and writes no files', async () => {
  const guideDirectory = await mkdtemp(join(temporaryDirectory, 'guide-'));
  const output = await runCli(['guide'], { cwd: guideDirectory });

  assert.equal(output.exitCode, 0, output.stderr);
  assert.equal(output.stdout, readingGuideText);
  assert.ok(readingGuideText.split('\n').length <= 120);
  assert.deepEqual(readdirSync(guideDirectory), []);
});

test('--help lists flags and points to the guide', async () => {
  const output = await runCli(['--help']);

  assert.equal(output.exitCode, 0, output.stderr);
  assert.ok(output.stdout.trimEnd().endsWith('run: pxtree guide'), output.stdout);
});

test('the skill file is current with the guide', () => {
  assert.equal(readFileSync(skillFileUrl, 'utf8'), createSkillText());
});
