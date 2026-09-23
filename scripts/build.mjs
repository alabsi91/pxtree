import { rmSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import typescript from 'typescript';
import { createSkillText, skillFileUrl } from './skill.ts';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const distDirectory = `${projectDirectory}dist`;
const nodeEntryPaths = ['src/index.ts', 'src/cli.ts', 'src/mcp.ts'];
const nodeEntryAbsolutePaths = nodeEntryPaths.map((entryPath) => resolve(projectDirectory, entryPath));

let hasFailed = false;

async function bundle(entryPath, buildOptions) {
  try {
    await esbuild.build({ entryPoints: [`${projectDirectory}${entryPath}`], bundle: true, logLevel: 'silent', ...buildOptions });
  } catch (error) {
    console.error(`failed ${entryPath}: ${error.message}`);
    hasFailed = true;
  }
}

/** Keeps an import of another node entry as an import of its built file. Each entry then bundles only its own code. */
const importOtherEntriesPlugin = {
  name: 'import-other-entries',
  setup(build) {
    build.onResolve({ filter: /\.ts$/ }, (resolveArguments) => {
      const absolutePath = resolve(resolveArguments.resolveDir, resolveArguments.path);
      const isOtherEntry = resolveArguments.kind !== 'entry-point' && nodeEntryAbsolutePaths.includes(absolutePath);
      if (isOtherEntry) {
        return { path: `./${basename(absolutePath, '.ts')}.js`, external: true };
      }
    });
  },
};

function emitDeclarations() {
  const configPath = `${projectDirectory}tsconfig.json`;
  const parsedConfig = typescript.getParsedCommandLineOfConfigFile(configPath, {}, { ...typescript.sys, onUnRecoverableConfigFileDiagnostic: () => {} });

  const declarationOptions = {
    ...parsedConfig.options,
    noEmit: false,
    declaration: true,
    emitDeclarationOnly: true,
    rootDir: `${projectDirectory}src`,
    outDir: `${distDirectory}/types`,
  };

  const program = typescript.createProgram([`${projectDirectory}src/index.ts`], declarationOptions);
  const emitDiagnostics = program.emit().diagnostics;
  if (emitDiagnostics.length === 0) return;

  const formatHost = { getCanonicalFileName: (fileName) => fileName, getCurrentDirectory: () => projectDirectory, getNewLine: () => '\n' };
  console.error(typescript.formatDiagnostics(emitDiagnostics, formatHost).trimEnd());
  hasFailed = true;
}

rmSync(distDirectory, { recursive: true, force: true });

await bundle('src/browser/index.ts', {
  format: 'iife',
  target: 'chrome120',
  outfile: `${distDirectory}/browser.js`,
});

const nodeBuildOptions = {
  format: 'esm',
  platform: 'node',
  target: 'node20',
  packages: 'external',
  plugins: [importOtherEntriesPlugin],
};

for (const entryPath of nodeEntryPaths) {
  await bundle(entryPath, { ...nodeBuildOptions, outfile: `${distDirectory}/${basename(entryPath, '.ts')}.js` });
}

emitDeclarations();
writeFileSync(skillFileUrl, createSkillText());

if (hasFailed) {
  process.exitCode = 1;
}
