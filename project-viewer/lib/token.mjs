/** 16 bytes is 128 bits. base64url without padding is 22 characters. */
export const TOKEN_BYTES = 16;

export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export function bytesToBase64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function createToken() {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export function isToken(value) {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}
