import app from '../src/index.js';

// Export default app with error handling and validation wrapper
const wrappedApp = (req: any, res: any) => {
  // Validate request has required properties
  if (!req || !res) {
    return res?.status?.(400).json?.({ error: 'Invalid request or response object' });
  }
  try {
    return app(req, res);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error', details: error instanceof Error ? error.message : String(error) });
  }
};

export default wrappedApp;