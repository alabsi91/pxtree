export function getFirstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  return message.split('\n')[0].trim();
}
