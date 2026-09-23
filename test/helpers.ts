import { fileURLToPath, pathToFileURL } from 'node:url';

import { format } from '../src/format/format.ts';
import type { FormatOptions, MeasureOptions, MeasureResult, Session } from '../src/types.ts';

const fixturesDirectory = fileURLToPath(new URL('./fixtures/', import.meta.url));

/** File URL of a fixture in test/fixtures. The `.html` extension is optional. */
export function getFixtureUrl(fixtureName: string): string {
  const fileName = fixtureName.endsWith('.html') ? fixtureName : `${fixtureName}.html`;

  return pathToFileURL(fixturesDirectory + fileName).href;
}

/** Measures a fixture with the cache off unless options set a cache directory. Throws when the run failed. */
export async function measureFixture(session: Session, fixtureName: string, options: MeasureOptions = {}): Promise<MeasureResult> {
  const result = await session.measure(getFixtureUrl(fixtureName), { cacheDirectory: null, ...options });
  if (result.error) {
    throw new Error(`${fixtureName}: ${result.error.kind} error: ${result.error.message}`);
  }

  return result;
}

/** Measures a fixture and returns the formatted report as lines. */
export async function formatFixture(
  session: Session,
  fixtureName: string,
  options: MeasureOptions & FormatOptions = {},
): Promise<string[]> {
  const result = await measureFixture(session, fixtureName, options);

  return format(result, options).split('\n');
}

/** The first line that starts with `lineStart` after its indent is trimmed. Throws with the full report when none does. */
export function findLine(reportLines: string[], lineStart: string): string {
  const matchingLine = reportLines.find((line) => line.trimStart().startsWith(lineStart));
  if (matchingLine === undefined) {
    throw new Error(`no line starts with ${JSON.stringify(lineStart)} in:\n${reportLines.join('\n')}`);
  }

  return matchingLine;
}
