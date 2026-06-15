import type { VercelRequest, VercelResponse } from '@vercel/node';
import app from '../src/index.js';

export default (req: VercelRequest, res: VercelResponse) => {
  return app(req, res);
};