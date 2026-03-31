import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Security middleware
app.use(helmet());
app.use(express.json());

// Async error handler wrapper
const asyncHandler = (fn: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<void>) =>
  (req: express.Request, res: express.Response, next: express.NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  skip: () => false,
  onLimitReached: (req, res, options) => {
    console.error('Rate limit reached for IP:', req.ip);
  },
});
app.use((req, res, next) => {
  try {
    limiter(req, res, next);
  } catch (err) {
    console.error('Rate limiter error:', err);
    next();
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  try {
    const timeout = setTimeout(() => {
      if (!res.headersSent) {
        res.status(503).json({ status: 'timeout' });
      }
    }, 5000);
    res.on('finish', () => clearTimeout(timeout));
    res.json({ status: 'ok' });
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ status: 'error' });
    }
  }
});

// Error handling middleware
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  const errorId = Math.random().toString(36).substring(7);
  console.error(`[ERROR:${errorId}]`, err.stack);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error', errorId });
  }
});

if (import.meta.url === `file://${process.argv[1]}`) {
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
}

export default app;
