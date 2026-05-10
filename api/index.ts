import app from '../src/index.js';

// Error boundary wrapper for Vercel deployment
const handler = (req: any, res: any) => {
  try {
    if (!app) {
      res.status(503).json({ error: 'Service not available' });
      return;
    }
    return app(req, res);
  } catch (error) {
    console.error('API handler error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export default handler;