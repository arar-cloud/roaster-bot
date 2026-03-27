import app from '../src/index.js';

// Error handling wrapper for debugging and API resilience
const wrappedApp = (req, res, next) => {
  try {
    if (typeof app === 'function') {
      return app(req, res, next);
    }
    res.status(500).json({ error: 'API initialization failed' });
  } catch (err) {
    console.error('[API Error]', {
      timestamp: new Date().toISOString(),
      message: err.message,
      stack: err.stack,
      path: req?.path,
      method: req?.method
    });
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

export default wrappedApp;