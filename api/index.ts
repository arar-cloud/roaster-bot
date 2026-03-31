import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import { randomUUID } from 'crypto';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Request ID middleware for tracing
app.use((req: any, res: express.Response, next: express.NextFunction) => {
  req.id = randomUUID();
  res.setHeader('X-Request-ID', req.id);
  console.log(`[${req.id}] ${req.method} ${req.path}`);
  next();
});

// Security middleware
app.use(helmet());
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
});
app.use(limiter);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Error handling middleware
app.use((err: any, req: any, res: express.Response, next: express.NextFunction) => {
  const status = err.status || 500;
  const requestId = req.id || 'unknown';
  console.error(`[${requestId}] [Error] Status: ${status}, Message: ${err.message}`);
  res.status(status).json({ error: err.message || 'Internal server error', requestId });
});

if (import.meta.url === `file://${process.argv[1]}`) {
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
}

export default app;
