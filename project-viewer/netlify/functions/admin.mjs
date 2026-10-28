import { handleAdmin } from '../../lib/handlers.mjs';

export default handleAdmin;

export const config = {
  path: [
    '/api/admin/projects',
    '/api/admin/projects/:token',
    '/api/admin/projects/:token/complete',
    '/api/admin/projects/:token/chunks/:kind/:index',
  ],
};
