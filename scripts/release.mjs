import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const packageJson = JSON.parse(readFileSync(join(projectDirectory, 'package.json'), 'utf8'));
const registryServerName = 'io.github.alabsi91/pxtree';
const publisherReleaseUrl = 'https://api.github.com/repos/modelcontextprotocol/registry/releases/latest';

const commandLineArguments = process.argv.slice(2);
const isRegistryOnly = commandLineArguments.includes('--registry-only');
const isNpmOnly = commandLineArguments.includes('--npm-only');
const isDryRun = commandLineArguments.includes('--dry-run');
const isWindows = process.platform === 'win32';

function exitWithMessage(message) {
  console.error(message);
  process.exit(1);
}

/** Runs a command with its output shown live. Resolves with the exit code and the combined output text. */
function runCommand(command, commandArguments, { shouldInheritAllOutput = false } = {}) {
  return new Promise((resolvePromise) => {
    const stdio = shouldInheritAllOutput ? 'inherit' : ['inherit', 'pipe', 'pipe'];
    const childProcess = spawn(command, commandArguments, { cwd: projectDirectory, stdio, shell: isWindows });
    let outputText = '';

    childProcess.stdout?.on('data', (chunk) => {
      outputText += chunk;
      process.stdout.write(chunk);
    });

    childProcess.stderr?.on('data', (chunk) => {
      outputText += chunk;
      process.stderr.write(chunk);
    });

    childProcess.on('error', (error) => resolvePromise({ exitCode: 1, outputText: error.message }));
    childProcess.on('close', (exitCode) => resolvePromise({ exitCode, outputText }));
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

  const { exitCode } = await runCommand('npm', ['publish'], { shouldInheritAllOutput: true });
  if (exitCode !== 0) {
    exitWithMessage('npm publish failed');
  }
}

function getPublisherFileName() {
  return isWindows ? 'mcp-publisher.exe' : 'mcp-publisher';
}

function getPublisherPathOnPath() {
  const pathDirectories = (process.env.PATH ?? '').split(delimiter).filter(Boolean);

  for (const pathDirectory of pathDirectories) {
    const candidatePath = join(pathDirectory, getPublisherFileName());
    if (existsSync(candidatePath)) {
      return candidatePath;
    }
  }
}

function getCacheBinDirectory() {
  const cacheDirectory = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(cacheDirectory, 'pxtree', 'bin');
}

function getReleaseAssetName() {
  const operatingSystemNames = { linux: 'linux', darwin: 'darwin', win32: 'windows' };
  const architectureNames = { x64: 'amd64', arm64: 'arm64' };
  const operatingSystemName = operatingSystemNames[process.platform];
  const architectureName = architectureNames[process.arch];

  if (!operatingSystemName || !architectureName) {
    exitWithMessage(`no mcp-publisher release for ${process.platform} ${process.arch}`);
  }

  return `mcp-publisher_${operatingSystemName}_${architectureName}.tar.gz`;
}

async function fetchOrExit(url) {
  const response = await fetch(url);
  if (!response.ok) {
    exitWithMessage(`download failed: ${url} returned ${response.status}`);
  }

  return response;
}

/** Resolves with the latest mcp-publisher release, or undefined when the GitHub API cannot be reached. */
async function fetchLatestPublisherRelease() {
  try {
    const response = await fetch(publisherReleaseUrl);
    if (response.ok) {
      return await response.json();
    }
  } catch {
    return;
  }
}

/** Reads the version from `mcp-publisher --version`, which may print it after a log timestamp on stderr. */
function getPublisherVersion(publisherPath) {
  const versionResult = spawnSync(publisherPath, ['--version'], { encoding: 'utf8', shell: isWindows });
  const versionText = `${versionResult.stdout ?? ''}${versionResult.stderr ?? ''}`;
  return versionText.match(/mcp-publisher v?(\d+\.\d+\.\d+)/)?.[1];
}

function getVersionFromTag(tagName) {
  return tagName.replace(/^v/, '');
}

function isVersionAtLeast(version, minimumVersion) {
  if (!version) return false;

  const versionParts = version.split('.').map(Number);
  const minimumVersionParts = minimumVersion.split('.').map(Number);

  for (let index = 0; index < 3; index++) {
    if (versionParts[index] !== minimumVersionParts[index]) {
      return versionParts[index] > minimumVersionParts[index];
    }
  }

  return true;
}

function getDisplayPath(filePath) {
  const homeDirectory = homedir();
  return filePath.startsWith(homeDirectory) ? `~${filePath.slice(homeDirectory.length)}` : filePath;
}

async function downloadPublisher(release) {
  const assetName = getReleaseAssetName();
  const asset = release.assets.find((releaseAsset) => releaseAsset.name === assetName);
  if (!asset) {
    exitWithMessage(`mcp-publisher ${release.tag_name} has no asset named ${assetName}`);
  }

  console.log(`downloading ${assetName} from mcp-publisher ${release.tag_name}`);
  const archiveBytes = Buffer.from(await (await fetchOrExit(asset.browser_download_url)).arrayBuffer());

  const checksumsAsset = release.assets.find((releaseAsset) => releaseAsset.name.endsWith('checksums.txt'));
  if (checksumsAsset) {
    const checksumsText = await (await fetchOrExit(checksumsAsset.browser_download_url)).text();
    const checksumLine = checksumsText.split('\n').find((line) => line.trim().endsWith(`  ${assetName}`));
    const expectedChecksum = checksumLine?.split(/\s+/)[0];
    const actualChecksum = createHash('sha256').update(archiveBytes).digest('hex');

    if (expectedChecksum !== actualChecksum) {
      exitWithMessage(`checksum mismatch for ${assetName}: expected ${expectedChecksum}, got ${actualChecksum}`);
    }

    console.log(`sha256 verified: ${actualChecksum}`);
  }

  const cacheBinDirectory = getCacheBinDirectory();
  const archivePath = join(cacheBinDirectory, assetName);
  mkdirSync(cacheBinDirectory, { recursive: true });
  writeFileSync(archivePath, archiveBytes);

  const { exitCode } = await runCommand('tar', ['-xzf', archivePath, '-C', cacheBinDirectory, getPublisherFileName()]);
  rmSync(archivePath);
  if (exitCode !== 0) {
    exitWithMessage(`could not extract ${assetName}`);
  }

  const publisherPath = join(cacheBinDirectory, getPublisherFileName());
  chmodSync(publisherPath, 0o755);
  return publisherPath;
}

async function getPublisherPath() {
  const latestRelease = await fetchLatestPublisherRelease();

  const publisherPathOnPath = getPublisherPathOnPath();
  const pathVersion = publisherPathOnPath ? getPublisherVersion(publisherPathOnPath) : undefined;
  const pathDescription = publisherPathOnPath ? `PATH has ${pathVersion ?? 'an unknown version'}` : 'PATH has none';

  const cachedPublisherPath = join(getCacheBinDirectory(), getPublisherFileName());
  const hasCachedPublisher = existsSync(cachedPublisherPath);
  const cachedVersion = hasCachedPublisher ? getPublisherVersion(cachedPublisherPath) : undefined;

  if (!latestRelease) {
    if (hasCachedPublisher) {
      console.log(`GitHub API unreachable, using cached ${getDisplayPath(cachedPublisherPath)} ${cachedVersion ?? 'of unknown version'}`);
      return cachedPublisherPath;
    }

    if (publisherPathOnPath) {
      console.log(`GitHub API unreachable and no cached binary, using ${publisherPathOnPath} ${pathVersion ?? 'of unknown version'}`);
      return publisherPathOnPath;
    }

    exitWithMessage('GitHub API unreachable and no mcp-publisher on PATH or in the cache');
  }

  const latestVersion = getVersionFromTag(latestRelease.tag_name);

  if (isVersionAtLeast(pathVersion, latestVersion)) {
    console.log(`using ${publisherPathOnPath} ${pathVersion}, latest release is ${latestVersion}`);
    return publisherPathOnPath;
  }

  if (isVersionAtLeast(cachedVersion, latestVersion)) {
    console.log(`using ${getDisplayPath(cachedPublisherPath)} ${cachedVersion}, ${pathDescription}`);
    return cachedPublisherPath;
  }

  const cacheDescription = hasCachedPublisher ? `cache had ${cachedVersion ?? 'an unknown version'}` : 'cache was empty';
  const downloadedPublisherPath = await downloadPublisher(latestRelease);
  console.log(`using ${getDisplayPath(downloadedPublisherPath)} ${latestVersion}, ${pathDescription}, ${cacheDescription}`);
  return downloadedPublisherPath;
}

async function publishToRegistry() {
  const publisherPath = await getPublisherPath();

  if (isDryRun) {
    const { exitCode } = await runCommand(publisherPath, ['--help']);
    if (exitCode !== 0) {
      exitWithMessage(`${publisherPath} --help failed`);
    }

    console.log(`would run: ${publisherPath} publish`);
    return;
  }

  const firstAttempt = await runCommand(publisherPath, ['publish']);
  if (firstAttempt.exitCode === 0) return;

  const hasNoSession = /not authenticated|status 401/.test(firstAttempt.outputText);
  if (!hasNoSession) {
    exitWithMessage('mcp-publisher publish failed');
  }

  const loginAttempt = await runCommand(publisherPath, ['login', 'github'], { shouldInheritAllOutput: true });
  if (loginAttempt.exitCode !== 0) {
    exitWithMessage('mcp-publisher login github failed');
  }

  const secondAttempt = await runCommand(publisherPath, ['publish']);
  if (secondAttempt.exitCode !== 0) {
    exitWithMessage('mcp-publisher publish failed after login');
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
