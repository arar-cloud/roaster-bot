// Import from pre-compiled dist in production, or src in development
const isDev = process.env.NODE_ENV !== 'production';
const app = isDev 
  ? (await import('../src/index.js')).default 
  : (await import('../dist/index.js')).default;

export default app;