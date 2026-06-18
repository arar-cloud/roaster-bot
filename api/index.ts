import app from '../src/index.js';

// Error boundary wrapper for serverless runtime
const errorHandler = (err: Error) => {
  console.error('Fatal error in app initialization:', err);
  return (req: any, res: any) => {
    res.status(500).json({
      error: 'Service initialization failed',
      message: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
    });
  };
};

try {
  export default app;
} catch (err) {
  console.error('Failed to export app:', err);
  export default errorHandler(err as Error);
}