/** A redirect location without its flash/error signatures (see src/core/http/notice.ts),
 *  so a test can compare it with a readable literal. */
export function unsigned(location: string | null | undefined): string {
  return (location ?? '').replace(/&(?:flash|error)_sig=[A-Za-z0-9_-]+/g, '');
}
