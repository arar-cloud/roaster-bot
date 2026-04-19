import app from '../src/index.js';

// Performance optimization utilities
export { cacheManager, default as CacheManager } from './cache.js';
export { default as DataLoader } from './batch-loader.js';
export {
  encodeCursor,
  decodeCursor,
  createPaginatedResponse,
  createOffsetPaginatedResponse,
  calculateOffset,
  type PaginationOptions,
  type PaginatedResponse,
  type OffsetPaginationOptions,
  type OffsetPaginatedResponse,
} from './pagination.js';

// Main application export
export default app;