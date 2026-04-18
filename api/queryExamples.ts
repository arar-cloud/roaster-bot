/**
 * Example: Refactoring N+1 Query Patterns
 * This file shows BEFORE/AFTER patterns for common N+1 issues.
 */

import { createBatchLoader, sqlBatchQuery } from './batchLoader.js';

/**
 * BEFORE (N+1 Pattern - BAD):
 * For each user, fetch their posts in a separate query.
 * If there are 100 users, this creates 101 queries (1 to get users + 100 to get posts).
 */
export async function getUsersWithPostsNPlusOne(dbPool: any) {
  const users = await dbPool.query('SELECT id, name FROM users LIMIT 100');
  
  // BAD: This loop creates 100 additional queries
  const usersWithPosts = await Promise.all(
    users.rows.map(async (user) => {
      const posts = await dbPool.query(
        'SELECT * FROM posts WHERE user_id = $1',
        [user.id]
      );
      return { ...user, posts: posts.rows };
    })
  );

  return usersWithPosts; // Total: 101 queries
}

/**
 * AFTER (Batched Pattern - GOOD):
 * Fetch all users, then all posts for those users in a single query.
 * Creates only 2 queries total.
 */
export async function getUsersWithPostsBatched(dbPool: any) {
  // Query 1: Get all users
  const users = await dbPool.query('SELECT id, name FROM users LIMIT 100');
  const userIds = users.rows.map((u) => u.id);

  // Query 2: Get ALL posts in one query using IN clause
  const posts = await dbPool.query(
    'SELECT * FROM posts WHERE user_id = ANY($1)',
    [userIds]
  );

  // Map posts to users in application layer
  const postsByUserId: { [key: number]: any[] } = {};
  posts.rows.forEach((post) => {
    if (!postsByUserId[post.user_id]) {
      postsByUserId[post.user_id] = [];
    }
    postsByUserId[post.user_id].push(post);
  });

  const usersWithPosts = users.rows.map((user) => ({
    ...user,
    posts: postsByUserId[user.id] || [],
  }));

  return usersWithPosts; // Total: 2 queries (80-90% reduction)
}

/**
 * ADVANCED: Using Batch Loader for automatic N+1 prevention
 * Useful when you can't control query structure (e.g., GraphQL fields).
 */
export function createPostLoader(dbPool: any) {
  return createBatchLoader(async (userIds: number[]) => {
    const result = await dbPool.query(
      'SELECT * FROM posts WHERE user_id = ANY($1) ORDER BY user_id',
      [userIds]
    );

    // Group posts by user_id in same order as userIds
    const postsByUserId: { [key: number]: any[] } = {};
    result.rows.forEach((post) => {
      if (!postsByUserId[post.user_id]) {
        postsByUserId[post.user_id] = [];
      }
      postsByUserId[post.user_id].push(post);
    });

    // Return posts in same order as input userIds
    return userIds.map((id) => postsByUserId[id] || []);
  });
}

/**
 * Usage in Express handler:
 * const postLoader = createPostLoader(dbPool);
 * 
 * app.get('/users/:id', async (req, res) => {
 *   const user = await dbPool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
 *   const posts = await postLoader.load(user.id); // Batches multiple calls
 *   res.json({ ...user.rows[0], posts });
 * });
 */
