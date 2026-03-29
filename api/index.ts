import app from '../src/index.js';

// Security middleware: validate authorization headers
app.use((req, res, next) => {
  const authHeader = req.headers.authorization;
  if (req.path.startsWith('/api/protected/')) {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid authorization header' });
    }
    const token = authHeader.slice(7);
    if (!token || token.length < 20) {
      return res.status(401).json({ error: 'Invalid token format' });
    }
  }
  next();
});

// Security middleware: sanitize query parameters
app.use((req, res, next) => {
  const suspiciousPatterns = ['<script', 'onclick=', 'onerror=', 'javascript:', 'union select'];
  const queryString = JSON.stringify(req.query).toLowerCase();
  if (suspiciousPatterns.some(pattern => queryString.includes(pattern))) {
    return res.status(400).json({ error: 'Invalid request parameters' });
  }
  next();
});

export default app;