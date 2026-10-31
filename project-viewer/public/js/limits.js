/**
 * 3 MB and 18 MB. Keep these numbers identical to lib/limits.mjs.
 * Netlify's buffered request cap is 6 MB, and binary bodies are base64-encoded
 * on the way in, so each part stays at 3 MB. Streamed responses cap at 20 MB,
 * so a stored model stays at 18 MB.
 */
export const CHUNK_BYTES = 3145728;
export const MAX_FILE_BYTES = 18874368;
