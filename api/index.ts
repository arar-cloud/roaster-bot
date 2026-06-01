import app from '../src/index.js';

// Health check endpoint for serverless warm-up
app.get('/health', (req, res) => {
  res.set('Cache-Control', 'public, max-age=60');
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

export default app;