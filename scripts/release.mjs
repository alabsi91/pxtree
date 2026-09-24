import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const packageJson = JSON.parse(readFileSync(join(projectDirectory, 'package.json'), 'utf8'));
const serverJsonText = readFileSync(join(projectDirectory, 'server.json'), 'utf8');
const registryServerName = JSON.parse(serverJsonText).name;
const registryApiUrl = 'https://registry.modelcontextprotocol.io/v0.1';

const commandLineArguments = process.argv.slice(2);
const isRegistryOnly = commandLineArguments.includes('--registry-only');
const isNpmOnly = commandLineArguments.includes('--npm-only');
const isDryRun = commandLineArguments.includes('--dry-run');
const isWindows = process.platform === 'win32';

function exitWithMessage(message) {
  console.error(message);
  process.exit(1);
}

function runCommand(command, commandArguments) {
  return new Promise((resolvePromise) => {
    const childProcess = spawn(command, commandArguments, { cwd: projectDirectory, stdio: 'inherit', shell: isWindows });

    childProcess.on('error', () => resolvePromise(1));
    childProcess.on('close', (exitCode) => resolvePromise(exitCode));
  });
}

function runQuietCommand(command, commandArguments) {
  return new Promise((resolvePromise) => {
    const childProcess = spawn(command, commandArguments, { cwd: projectDirectory, stdio: ['ignore', 'pipe', 'ignore'], shell: isWindows });
    let outputText = '';

    childProcess.stdout.on('data', (chunk) => {
      outputText += chunk;
    });

    childProcess.on('error', () => resolvePromise(''));
    childProcess.on('close', () => resolvePromise(outputText.trim()));
  });
}

async function checkGitState() {
  const gitStatusText = await runQuietCommand('git', ['status', '--porcelain']);
  if (gitStatusText !== '') {
    exitWithMessage('refusing to release: the git working tree has uncommitted changes');
  }

  const branchName = await runQuietCommand('git', ['branch', '--show-current']);
  if (branchName !== 'main') {
    exitWithMessage(`refusing to release: on branch "${branchName}", not main`);
  }
}

async function publishToNpm() {
  const packageSpecifier = `${packageJson.name}@${packageJson.version}`;
  const publishedVersion = await runQuietCommand('npm', ['view', packageSpecifier, 'version']);
  if (publishedVersion !== '') {
    exitWithMessage(`refusing to release: ${packageSpecifier} is already on npm`);
  }

  if (isDryRun) {
    console.log('would run: npm publish');
    return;
  }

  const exitCode = await runCommand('npm', ['publish']);
  if (exitCode !== 0) {
    exitWithMessage('npm publish failed');
  }
}

async function getGitHubToken() {
  const githubToken = process.env.GITHUB_TOKEN || (await runQuietCommand('gh', ['auth', 'token']));
  if (!githubToken) {
    exitWithMessage('no GitHub token for the MCP Registry: install gh and run "gh auth login", or set GITHUB_TOKEN');
  }

  return githubToken;
}

/** Reads the error detail from a registry response, which is problem+json on failure. */
async function getResponseErrorText(response) {
  const responseText = await response.text();

  try {
    const problem = JSON.parse(responseText);
    const errorMessages = (problem.errors ?? []).map((error) => error.message).filter(Boolean);
    const detailText = problem.detail ?? responseText;

    return errorMessages.length === 0 ? detailText : `${detailText}: ${errorMessages.join('; ')}`;
  } catch {
    return responseText;
  }
}

async function getRegistryToken() {
  const githubToken = await getGitHubToken();

  const response = await fetch(`${registryApiUrl}/auth/github-at`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ github_token: githubToken }),
  });

  if (!response.ok) {
    exitWithMessage(`MCP Registry login failed with ${response.status}: ${await getResponseErrorText(response)}`);
  }

  const { registry_token: registryToken, expires_at: expiresAtSeconds } = await response.json();
  const expiryTimeText = new Date(expiresAtSeconds * 1000).toISOString();
  console.log(`MCP Registry token obtained, expires ${expiryTimeText}`);

  return registryToken;
}

async function publishToRegistry() {
  const packageSpecifier = `${packageJson.name}@${packageJson.version}`;
  const publishedVersion = await runQuietCommand('npm', ['view', packageSpecifier, 'version']);
  if (publishedVersion === '') {
    exitWithMessage(`refusing to publish to the MCP Registry: ${packageSpecifier} is not on npm yet, run \`npm run release\` without --registry-only`);
  }

  const registryToken = await getRegistryToken();
  const publishUrl = `${registryApiUrl}/publish`;

  if (isDryRun) {
    console.log(`would POST ${publishUrl}`);
    console.log('with headers: Content-Type: application/json, Authorization: Bearer <registry token>');
    console.log(`with body server.json:\n${serverJsonText}`);
    return;
  }

  const response = await fetch(publishUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${registryToken}` },
    body: serverJsonText,
  });

  if (!response.ok) {
    exitWithMessage(`MCP Registry publish failed with ${response.status}: ${await getResponseErrorText(response)}`);
  }
}

if (isRegistryOnly && isNpmOnly) {
  exitWithMessage('pick one of --registry-only and --npm-only');
}

await checkGitState();

if (!isRegistryOnly) {
  await publishToNpm();
}

if (!isNpmOnly) {
  await publishToRegistry();
}

const doneLabel = isDryRun ? 'dry run done' : 'released';
console.log(`${doneLabel}: https://www.npmjs.com/package/${packageJson.name}/v/${packageJson.version}`);
console.log(`MCP Registry: ${registryServerName}`);
