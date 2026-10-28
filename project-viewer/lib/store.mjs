import { getStore } from '@netlify/blobs';

import { LocalBlobStore } from './local-blob-store.mjs';

/**
 * Production uses one site-wide store so a new deploy does not drop models.
 * Deploy previews use a different store so a preview cannot overwrite a
 * client's file. `npm run dev` sets PROJECT_VIEWER_BLOB_DIR and stays on disk.
 */
export function storeName() {
  const context = process.env.CONTEXT || 'production';
  return context === 'production' ? 'project-viewer' : 'project-viewer-preview';
}

export function openStore() {
  if (process.env.PROJECT_VIEWER_BLOB_DIR) {
    return new LocalBlobStore(process.env.PROJECT_VIEWER_BLOB_DIR);
  }
  return getStore({ name: storeName(), consistency: 'strong' });
}
