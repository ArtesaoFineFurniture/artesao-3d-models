import { handleModel } from '../../lib/handlers.mjs';

export default handleModel;

export const config = {
  path: [
    '/api/view/:token',
    '/m/:token/model.glb',
    '/m/:token/model.usdz',
  ],
};
