/** Accept an origin (and harmless trailing slash), never a URL path or credentials. */
export function normalizeOrigin(value: string) {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('APP_ORIGIN must be an HTTP(S) origin without a path, query or credentials');
  return url.origin;
}
