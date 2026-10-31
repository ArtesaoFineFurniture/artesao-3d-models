import { createHash, timingSafeEqual } from 'node:crypto';

const HEADER = 'x-admin-password';

export function decodePasswordHeader(value) {
  const raw = typeof value === 'string' ? value : '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function passwordFromRequest(request) {
  return decodePasswordHeader(request.headers.get(HEADER) ?? '');
}

/**
 * Compare the typed password with ADMIN_PASSWORD.
 * Both sides are hashed to a fixed length first so a different length
 * does not leave timingSafeEqual early.
 */
export function passwordMatches(provided) {
  const expected = process.env.ADMIN_PASSWORD ?? '';
  if (!expected) return false;
  const given = typeof provided === 'string' && provided.length <= 256 ? provided : '';
  const actual = createHash('sha256').update(given, 'utf8').digest();
  const wanted = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(actual, wanted) && given.length > 0;
}
