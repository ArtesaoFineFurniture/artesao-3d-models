/** 3 MB. Netlify base64-encodes a binary function body, so the practical request cap is about 4.5 MB. */
export const CHUNK_BYTES = 3145728;

/** 18 MB. A streamed Netlify function response caps at 20 MB. */
export const MAX_FILE_BYTES = 18874368;

export const MAX_CHUNKS = 8;
