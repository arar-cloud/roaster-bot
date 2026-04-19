# Performance Optimization Guide for roaster-bot API

This guide explains how to use the performance utilities added to `api/index.ts` to fix the top 3 bottlenecks:
1. **Request Caching** - Eliminate redundant API calls
2. **N+1 Query Prevention** - Use batch loading for related entities
3. **Pagination** - Stream large datasets efficiently

## 1. Request Caching for Repeated API Calls

### Problem
Clients (mobile/web) making repeated requests cause redundant database queries and processing.

### Solution
Use the `cacheMiddleware` to automatically cache GET responses for configurable TTL.

### Example Usage

```typescript
import { cacheMiddleware } from './api/index.js';

// Cache GET /users for 60 seconds (60000ms)
app.get('/users', cacheMiddleware(60000), (req, res) => {
  // Your handler - response will be cached
  res.json({ users: [...] });
});

// Cache with default 60s TTL
app.get('/config', cacheMiddleware(), (req, res) => {
  res.json({ config: {...} });
});
```

### Manual Cache Control

```typescript
import { setCacheEntry, getCacheEntry, invalidateCache } from './api/index.js';

// Manually cache a response
const data = await fetchExpensiveData();
setCacheEntry('expensive-data', data, 120000); // 2 minutes

// Retrieve from cache
const cached = getCacheEntry('expensive-data');

// Invalidate cache after write operations
app.post('/users', (req, res) => {
  const newUser = createUser(req.body);
  invalidateCache('GET:/users'); // Clear related cache
  res.json(newUser);
});
```

### Performance Impact
- **Latency**: ~1-5ms (in-memory lookup) vs 100-500ms (database query)
- **Best for**: Frequently accessed, slowly-changing data (configs, user lists, dashboards)

---

## 2. Optimize N+1 Queries with Batch Loading

### Problem
```typescript
// ❌ ANTI-PATTERN: N+1 Query (causes 1 + N database queries)
const posts = await db.posts.all();
const enriched = await Promise.all(
  posts.map(async p => ({
    ...p,
    author: await db.users.getById(p.userId) // N separate queries!
  }))
);
```

With 100 posts, this causes 101 database queries (1 for posts + 100 for each user).

### Solution
Use `BatchLoader` to collect IDs and execute one batch query.

### Example Usage

```typescript
import { BatchLoader, eagerLoad, attachRelations } from './api/index.js';

// Create a batch loader for users (configurable batch size)
const userBatcher = new BatchLoader(
  async (userIds) => {
    // Execute ONE query with multiple IDs
    const users = await db.users.getByIds(userIds);
    return new Map(users.map(u => [u.id, u]));
  },
  100 // batch size
);

app.get('/posts', async (req, res) => {
  const posts = await db.posts.all();
  
  // Load all related users in a single query
  const userMap = await eagerLoad(posts, 'userId', (ids) =>
    db.users.getByIds(ids).then(users => new Map(users.map(u => [u.id, u])))
  );
  
  // Attach loaded users to posts
  const enriched = attachRelations(posts, 'userId', userMap, 'id', 'author');
  
  res.json(enriched);
});
```

### Query Comparison

| Approach | Queries | Time |
|----------|---------|------|
| N+1 Pattern | 101 | ~500ms |
| Eager Load | 2 | ~50ms |
| Reduction | **50x fewer** | **10x faster** |

### Performance Impact
- **Latency**: 500ms+ (N+1) → 50-100ms (eager load)
- **Database Load**: 100% reduction in round-trips
- **Best for**: Fetching lists with related entities (posts with authors, comments with users)

---

## 3. Pagination for Large Datasets

### Problem
```typescript
// ❌ ANTI-PATTERN: Loading entire dataset
app.get('/items', (req, res) => {
  const items = await db.items.all(); // 1M items = 500MB in memory!
  res.json(items);
});
```

Mobile clients with 50MB data limits crash. Memory exhaustion on backend.

### Solution
Use `paginationMiddleware` and `createPaginatedResponse` for efficient streaming.

### Example Usage

```typescript
import { paginationMiddleware, createPaginatedResponse } from './api/index.js';

// Apply pagination middleware globally
app.use(paginationMiddleware({ defaultLimit: 20, maxLimit: 100 }));

app.get('/items', (req, res) => {
  const { limit, offset } = req.pagination;
  
  // Fetch limit+1 to determine if more exist
  const items = await db.items.skip(offset).limit(limit + 1).all();
  const total = await db.items.count();
  
  const paginated = createPaginatedResponse(items, req.pagination, {
    cursorField: 'id',
    totalCount: total
  });
  
  res.json(paginated);
});
```

### Response Format

```json
{
  "items": [...],
  "limit": 20,
  "offset": 0,
  "hasMore": true,
  "total": 1000,
  "nextCursor": "eyJpZCI6IDk5fQ=="
}
```

### Client Usage

```typescript
// Fetch first page
const page1 = await fetch('/items?limit=20&offset=0');

// Fetch next page using cursor
const nextCursor = page1.data.nextCursor;
const page2 = await fetch(`/items?cursor=${nextCursor}&limit=20`);
```

### Performance Impact
- **Memory**: 500MB (all) → 1MB (page) - **500x reduction**
- **Response Time**: 5-10s (full) → 100-200ms (page)
- **Bandwidth**: 500MB → 5MB per request
- **Best for**: Large lists (items, users, logs), mobile clients

---

## Integration Checklist

When updating endpoints:

- [ ] GET endpoints reading static data → Add `cacheMiddleware(60000)`
- [ ] GET endpoints loading lists with related entities → Use `eagerLoad` + `BatchLoader`
- [ ] GET endpoints returning many items → Add `paginationMiddleware`
- [ ] POST/PUT/DELETE endpoints → Call `invalidateCache()` to clear related cache
- [ ] Test with `X-Cache: HIT` header to verify caching works
- [ ] Monitor response time improvements

## Testing Performance

```bash
# Test caching effectiveness
curl -i http://localhost:3000/users  # First request (MISS)
curl -i http://localhost:3000/users  # Second request (HIT) - should be 10x faster

# Test pagination
curl http://localhost:3000/items?limit=20&offset=0

# Test batch loading (query count in logs)
curl http://localhost:3000/posts  # Should see 2 queries, not N+1
```

## Monitoring

Add metrics to track improvements:

```typescript
const cacheStats = {
  hits: 0,
  misses: 0,
  hitRate: () => stats.hits / (stats.hits + stats.misses) * 100
};

app.use((req, res, next) => {
  if (res.get('X-Cache') === 'HIT') cacheStats.hits++;
  if (res.get('X-Cache') === 'MISS') cacheStats.misses++;
  next();
});

app.get('/metrics', (req, res) => res.json(cacheStats));
```
