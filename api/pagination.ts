/**
 * Cursor-based pagination utilities for large datasets
 * Reduces payload size and enables streaming responses for better performance
 * Cursor-based pagination is stateless and ideal for APIs
 * Prevents returning entire datasets which would overwhelm network bandwidth and client memory
 */

export interface PaginationOptions {
  limit?: number;
  cursor?: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  cursor: string | null;
  hasMore: boolean;
  count: number;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Encode cursor for pagination - converts position to base64
 */
export function encodeCursor(value: string | number): string {
  return Buffer.from(String(value)).toString('base64');
}

/**
 * Decode cursor for pagination - converts base64 back to position
 */
export function decodeCursor(cursor: string): string {
  try {
    return Buffer.from(cursor, 'base64').toString('utf-8');
  } catch {
    return '';
  }
}

/**
 * Create paginated response from array using cursor
 * Best for small in-memory datasets or after database fetch
 */
export function createPaginatedResponse<T>(
  items: T[],
  keyFn: (item: T) => string | number,
  limit: number = DEFAULT_LIMIT,
  cursor?: string
): PaginatedResponse<T> {
  // Validate and clamp limit between 1 and MAX_LIMIT
  const safeLimit = Math.min(Math.max(limit || DEFAULT_LIMIT, 1), MAX_LIMIT);

  // Find start index from cursor
  let startIndex = 0;
  if (cursor) {
    const decodedCursor = decodeCursor(cursor);
    startIndex = items.findIndex(
      (item) => String(keyFn(item)) === decodedCursor
    );
    if (startIndex === -1) {
      startIndex = 0;
    } else {
      startIndex += 1; // Start after cursor
    }
  }

  // Fetch one extra item to determine if there are more
  const paginatedItems = items.slice(startIndex, startIndex + safeLimit + 1);
  const hasMore = paginatedItems.length > safeLimit;
  const data = paginatedItems.slice(0, safeLimit);

  // Generate next cursor from last item
  const nextCursor =
    hasMore && data.length > 0
      ? encodeCursor(keyFn(data[data.length - 1]))
      : null;

  return {
    data,
    cursor: nextCursor,
    hasMore,
    count: data.length,
  };
}

/**
 * Offset-based pagination (page + limit) - traditional approach
 * Good for database queries with OFFSET/LIMIT support
 */
export interface OffsetPaginationOptions {
  page?: number;
  limit?: number;
}

export interface OffsetPaginatedResponse<T> {
  data: T[];
  page: number;
  limit: number;
  total: number;
  pages: number;
}

export function createOffsetPaginatedResponse<T>(
  items: T[],
  total: number,
  page: number = 1,
  limit: number = DEFAULT_LIMIT
): OffsetPaginatedResponse<T> {
  // Validate and clamp limit
  const safeLimit = Math.min(Math.max(limit || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const safePage = Math.max(page || 1, 1);
  const totalPages = Math.ceil(total / safeLimit);

  return {
    data: items,
    page: safePage,
    limit: safeLimit,
    total,
    pages: totalPages,
  };
}

/**
 * Calculate offset from page and limit
 * Useful for database OFFSET queries
 */
export function calculateOffset(page: number = 1, limit: number = DEFAULT_LIMIT): number {
  const safePage = Math.max(page || 1, 1);
  const safeLimit = Math.min(Math.max(limit || DEFAULT_LIMIT, 1), MAX_LIMIT);
  return (safePage - 1) * safeLimit;
}