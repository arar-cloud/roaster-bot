/**
 * Pagination and streaming middleware for large result sets.
 * Implements cursor-based pagination to reduce memory and serialization latency.
 * Supports streaming responses for progressive client-side rendering.
 * Reduces peak memory consumption by processing results incrementally.
 */

import { Request, Response, NextFunction } from 'express';

interface PaginationParams {
  limit: number;
  cursor?: string;
  order?: 'asc' | 'desc';
}

interface PaginatedResponse<T> {
  data: T[];
  nextCursor?: string;
  hasMore: boolean;
  count: number;
  limit: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const DEFAULT_ORDER = 'desc';

/**
 * Parse pagination parameters from query string.
 */
export function parsePaginationParams(req: Request): PaginationParams {
  const limit = Math.min(
    Math.max(parseInt(req.query.limit as string) || DEFAULT_LIMIT, 1),
    MAX_LIMIT
  );
  
  const cursor = req.query.cursor as string | undefined;
  const order = (req.query.order as 'asc' | 'desc') || DEFAULT_ORDER;

  return { limit, cursor, order };
}

/**
 * Encode cursor from database ID.
 * Simple base64 encoding of the last item's ID.
 */
export function encodeCursor(id: string | number): string {
  return Buffer.from(`cursor_${id}`).toString('base64');
}

/**
 * Decode cursor back to database ID.
 */
export function decodeCursor(cursor: string): string {
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf-8');
    if (decoded.startsWith('cursor_')) {
      return decoded.substring(7);
    }
    return decoded;
  } catch (error) {
    return '';
  }
}

/**
 * Format paginated response with cursor support.
 */
export function formatPaginatedResponse<T extends { id?: string | number }>(
  items: T[],
  limit: number,
  hasMore: boolean
): PaginatedResponse<T> {
  const nextCursor = hasMore && items.length > 0
    ? encodeCursor(items[items.length - 1].id || '')
    : undefined;

  return {
    data: items,
    nextCursor,
    hasMore,
    count: items.length,
    limit,
  };
}

/**
 * Middleware to inject pagination helpers into request/response.
 */
export function createPaginationMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    // Attach pagination params to request
    (req as any).pagination = parsePaginationParams(req);

    // Attach pagination response formatter
    (res as any).paginate = function <T extends { id?: string | number }>(
      items: T[],
      hasMore: boolean
    ) {
      const pagination = (req as any).pagination;
      const response = formatPaginatedResponse(items, pagination.limit, hasMore);
      return this.json(response);
    };

    next();
  };
}

/**
 * Build cursor-based WHERE clause for database queries.
 * Assumes items are sorted by ID in descending order (most recent first).
 */
export function buildCursorWhereClause(
  cursor?: string,
  order: 'asc' | 'desc' = 'desc'
): { id: { [key: string]: string } } | {} {
  if (!cursor) {
    return {};
  }

  const lastId = decodeCursor(cursor);
  if (!lastId) {
    return {};
  }

  // For descending order (newer items first), we fetch items with ID < lastId
  // For ascending order, we fetch items with ID > lastId
  return order === 'desc'
    ? { id: { lt: lastId } }
    : { id: { gt: lastId } };
}

/**
 * Stream large result sets to client using newline-delimited JSON (NDJSON).
 * Allows progressive rendering without loading entire result in memory.
 * Sends items one per line, enabling client-side streaming parse.
 */
export function createStreamingMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    /**
     * Stream array of items as NDJSON to client.
     * Each item is a complete JSON object on its own line.
     */
    (res as any).streamJson = async function <T>(
      itemsAsyncIterable: AsyncIterable<T>,
      totalCount?: number
    ) {
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Transfer-Encoding', 'chunked');
      res.setHeader('X-Stream-Format', 'ndjson');

      if (totalCount !== undefined) {
        res.setHeader('X-Total-Count', totalCount.toString());
      }

      try {
        let itemCount = 0;

        for await (const item of itemsAsyncIterable) {
          // Send each item as a complete JSON object followed by newline
          const line = JSON.stringify(item) + '\n';
          const written = res.write(line);

          itemCount++;

          // Backpressure: pause if write buffer is full
          if (!written) {
            await new Promise((resolve) => res.once('drain', resolve));
          }

          // Optional: send progress metadata every 100 items
          if (itemCount % 100 === 0) {
            const progress = JSON.stringify({ _progress: itemCount }) + '\n';
            res.write(progress);
          }
        }

        // Send completion marker
        res.write(JSON.stringify({ _complete: true, _count: itemCount }) + '\n');
        res.end();
      } catch (error) {
        console.error('Streaming error:', error);
        res.write(JSON.stringify({ _error: String(error) }) + '\n');
        res.end();
      }
    };

    next();
  };
}

/**
 * Convert array of results to async iterable for streaming.
 * Useful for testing or converting existing array-based endpoints.
 */
export async function* arrayToAsyncIterable<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) {
    yield item;
  }
}
