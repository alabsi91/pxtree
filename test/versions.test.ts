import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8'));
}

test('package.json, server.json and the plugin manifest carry the same version', () => {
  const packageVersion = readJson('package.json').version;
  const serverJson = readJson('server.json') as { version: string; packages: Array<{ version: string }> };
  const pluginVersion = readJson('.claude-plugin/plugin.json').version;

  assert.equal(serverJson.version, packageVersion);
  assert.deepEqual(
    serverJson.packages.map((serverPackage) => serverPackage.version),
    serverJson.packages.map(() => packageVersion),
  );
  assert.equal(pluginVersion, packageVersion);
});
