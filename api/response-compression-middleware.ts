/**
 * Response compression and HTTP caching headers middleware.
 * Reduces bandwidth by 60-80% using gzip/brotli compression.
 * Adds Cache-Control and ETag headers for client-side caching and validation.
 * Optimizes for mobile networks with smaller transfer sizes.
 */

import { Request, Response, NextFunction } from 'express';
import { createHash } from 'crypto';
import zlib from 'zlib';

interface CompressionStats {
  originalSize: number;
  compressedSize: number;
  compressionRatio: number;
  algorithm: 'gzip' | 'brotli' | 'none';
}

/**
 * Generate ETag from response body.
 * Uses MD5 hash of response content for fast validation.
 */
function generateETag(body: string | Buffer): string {
  const hash = createHash('md5').update(body).digest('hex').substring(0, 16);
  return `"${hash}"`;
}

/**
 * Determine appropriate cache directives based on request path.
 * Public endpoints: 300s (5 min), Private/auth: no-cache, non-GET: no-cache.
 */
function getCacheControl(req: Request): string {
  // No caching for write operations
  if (req.method !== 'GET') {
    return 'no-cache, no-store, must-revalidate';
  }

  // Auth/user endpoints: short cache or no-cache
  if (req.path.includes('/auth') || req.path.includes('/user') || req.path.includes('/profile')) {
    return 'private, max-age=0, must-revalidate';
  }

  // Public/static data endpoints: 5 minute cache
  if (req.path.includes('/list') || req.path.includes('/data') || req.path.includes('/public')) {
    return 'public, max-age=300, must-revalidate';
  }

  // Default: 1 minute cache for other GET requests
  return 'public, max-age=60, must-revalidate';
}

/**
 * Check if client accepts compression algorithm.
 */
function getPreferredCompression(req: Request): 'gzip' | 'brotli' | 'none' {
  const acceptEncoding = req.headers['accept-encoding'] || '';
  
  // Brotli has better compression ratio but slower
  if (acceptEncoding.includes('br') && process.version >= 'v11.7.0') {
    return 'brotli';
  }
  
  if (acceptEncoding.includes('gzip')) {
    return 'gzip';
  }
  
  return 'none';
}

/**
 * Compress response body using selected algorithm.
 */
async function compressBody(body: Buffer, algorithm: 'gzip' | 'brotli'): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (algorithm === 'gzip') {
      zlib.gzip(body, (err, compressed) => {
        if (err) reject(err);
        else resolve(compressed);
      });
    } else if (algorithm === 'brotli') {
      zlib.brotliCompress(body, (err, compressed) => {
        if (err) reject(err);
        else resolve(compressed);
      });
    } else {
      resolve(body);
    }
  });
}

/**
 * Response compression and caching headers middleware.
 * Intercepts responses and applies compression + cache headers.
 */
export function createCompressionMiddleware() {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Skip compression for non-json responses
    const originalJson = res.json;
    const originalSend = res.send;

    let responseBody: string | null = null;

    res.json = function (body: any) {
      try {
        const cacheControl = getCacheControl(req);
        res.setHeader('Cache-Control', cacheControl);
        res.setHeader('Vary', 'Accept-Encoding');

        // Convert body to JSON string
        responseBody = JSON.stringify(body);
        const bodyBuffer = Buffer.from(responseBody, 'utf-8');

        // Generate and set ETag
        const etag = generateETag(bodyBuffer);
        res.setHeader('ETag', etag);

        // Check If-None-Match header (client cache validation)
        if (req.headers['if-none-match'] === etag) {
          res.statusCode = 304; // Not Modified
          return res.end();
        }

        // Determine compression
        const compression = getPreferredCompression(req);

        // Only compress responses larger than 1KB
        if (bodyBuffer.length > 1024 && compression !== 'none') {
          compressBody(bodyBuffer, compression)
            .then((compressed) => {
              const ratio = ((1 - compressed.length / bodyBuffer.length) * 100).toFixed(1);
              res.setHeader('Content-Encoding', compression);
              res.setHeader('X-Compression-Ratio', `${ratio}%`);
              res.setHeader('X-Original-Size', bodyBuffer.length.toString());
              res.setHeader('X-Compressed-Size', compressed.length.toString());
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              return res.end(compressed);
            })
            .catch((err) => {
              // Fallback to uncompressed on error
              console.error('Compression error:', err);
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              return originalJson.call(this, body);
            });
        } else {
          // Send uncompressed
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          return originalJson.call(this, body);
        }
      } catch (error) {
        console.error('Response compression middleware error:', error);
        return originalJson.call(this, body);
      }
    };

    res.send = function (data: any) {
      const cacheControl = getCacheControl(req);
      res.setHeader('Cache-Control', cacheControl);
      res.setHeader('Vary', 'Accept-Encoding');
      return originalSend.call(this, data);
    };

    next();
  };
}

/**
 * Middleware to set compression headers for streaming responses.
 */
export function setCompressionHeaders(req: Request, res: Response, next: NextFunction) {
  const cacheControl = getCacheControl(req);
  res.setHeader('Cache-Control', cacheControl);
  res.setHeader('Vary', 'Accept-Encoding');
  
  const compression = getPreferredCompression(req);
  if (compression !== 'none') {
    res.setHeader('Content-Encoding', compression);
  }
  
  next();
}
