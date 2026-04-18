import app from '../src/index.js';
import Pool from 'pg';

// Initialize database connection pool
const dbPool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'roaster',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
  max: 20, // Maximum pool size: handle 20 concurrent connections
  idleTimeoutMillis: 30000, // Close idle connections after 30s
  connectionTimeoutMillis: 2000, // Connection timeout 2s
});

// Attach pool to app for use in route handlers
app.locals.dbPool = dbPool;

export default app;