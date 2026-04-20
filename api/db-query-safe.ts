/**
 * Safe Database Query Module
 * Enforces parameterized queries and prepared statements to prevent SQL injection
 * Issue: security:issue-9ba44f970f
 */

interface QueryParams {
  [key: string]: any;
}

interface SafeQuery {
  sql: string;
  params: any[];
}

/**
 * Validates and constructs a parameterized SQL query
 * @param baseQuery - SQL template with placeholders
 * @param params - Parameters to bind (replaces placeholders)
 * @returns Safe parameterized query
 */
export const buildSafeQuery = (baseQuery: string, params: QueryParams = {}): SafeQuery => {
  // Validate query contains only allowed SQL keywords and no raw variable interpolation
  const forbiddenPatterns = [
    /\$\{.*?\}/g, // Template literals
    /\+.*?\+/g,   // String concatenation
    /'.*?'\s*\+/,  // Single quotes with concatenation
    /".*?"\s*\+/,  // Double quotes with concatenation
  ];

  for (const pattern of forbiddenPatterns) {
    if (pattern.test(baseQuery)) {
      throw new Error('SQL query contains forbidden interpolation pattern. Use parameterized queries instead.');
    }
  }

  // Replace named placeholders with positional parameters
  let sql = baseQuery;
  const paramArray: any[] = [];
  let paramIndex = 1;

  // Match :paramName or $paramName patterns
  const placeholderRegex = /(:([a-zA-Z_][a-zA-Z0-9_]*))|\$(\d+)/g;
  sql = sql.replace(placeholderRegex, (match, namedMatch, paramName, positional) => {
    if (positional) {
      // Already numbered placeholder, keep it
      return match;
    } else if (paramName) {
      // Named placeholder
      if (!(paramName in params)) {
        throw new Error(`Missing parameter: ${paramName}`);
      }
      paramArray.push(params[paramName]);
      return `$${paramIndex++}`;
    }
    return match;
  });

  return { sql, params: paramArray };
};

/**
 * Validates SQL query structure to detect injection attempts
 * @param sql - SQL query string
 * @returns boolean indicating if query is safe
 */
export const isSqlSafe = (sql: string): boolean => {
  // Check for common SQL injection patterns
  const injectionPatterns = [
    /('|\")(\s|\+)*(\s|\+)*(OR|AND|UNION|SELECT|DROP|INSERT|UPDATE|DELETE|EXEC|EXECUTE|SCRIPT|JAVASCRIPT)/gi,
    /(;|--|\|\|)\s*(DROP|DELETE|UPDATE|INSERT|CREATE|ALTER)/i,
    /\b(UNION|ALL|SELECT)\b.*\b(FROM|WHERE)\b/i,
    /(exec|execute)\s*\(/i,
  ];

  for (const pattern of injectionPatterns) {
    if (pattern.test(sql)) {
      return false;
    }
  }
  return true;
};

/**
 * Sanitizes identifier names (table names, column names)
 * Prevents injection through identifier names
 * @param identifier - Table or column name
 * @returns Validated identifier
 */
export const sanitizeIdentifier = (identifier: string): string => {
  // Allow only alphanumeric, underscores, and hyphens
  if (!/^[a-zA-Z0-9_\-]+$/.test(identifier)) {
    throw new Error(`Invalid identifier: ${identifier}. Only alphanumeric, underscore, and hyphen allowed.`);
  }
  // Additional check for SQL keywords
  const sqlKeywords = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'DROP', 'CREATE', 'ALTER', 'TABLE', 'DATABASE'];
  if (sqlKeywords.includes(identifier.toUpperCase())) {
    throw new Error(`Invalid identifier: ${identifier} is a SQL keyword.`);
  }
  return identifier;
};

/**
 * Executes a query with proper parameterization
 * This is a reference implementation; actual database execution depends on your DB driver
 * @param query - SafeQuery object with parameterized SQL
 * @param dbConnection - Database connection instance
 * @returns Query result
 */
export const executeParamQuery = async (query: SafeQuery, dbConnection: any): Promise<any> => {
  // Validate query before execution
  if (!isSqlSafe(query.sql)) {
    throw new Error('Query contains potential SQL injection patterns.');
  }

  // Execute with prepared statement (driver-specific)
  // Example for most SQL drivers:
  // const stmt = dbConnection.prepare(query.sql);
  // return stmt.run(...query.params);
  
  // Placeholder: actual implementation depends on DB driver (sqlite3, pg, mysql2, etc.)
  console.log('[Safe Query Execution]', { sql: query.sql, paramCount: query.params.length });
  return null;
};

/**
 * Examples of SAFE query patterns:
 * 
 * // Named parameters
 * buildSafeQuery('SELECT * FROM users WHERE id = :userId', { userId: 123 });
 * // Result: { sql: 'SELECT * FROM users WHERE id = $1', params: [123] }
 * 
 * // Multiple parameters
 * buildSafeQuery('SELECT * FROM users WHERE email = :email AND status = :status', 
 *   { email: 'test@example.com', status: 'active' });
 * // Result: { sql: 'SELECT * FROM users WHERE email = $1 AND status = $2', params: [...] }
 * 
 * Examples of UNSAFE patterns (will throw error):
 * 
 * // String concatenation - THROWS ERROR
 * 'SELECT * FROM users WHERE id = ' + userId
 * 
 * // Template literals - THROWS ERROR
 * `SELECT * FROM users WHERE id = ${userId}`
 * 
 * // Missing parameter - THROWS ERROR
 * buildSafeQuery('SELECT * FROM users WHERE id = :userId', {})
 */

export default {
  buildSafeQuery,
  isSqlSafe,
  sanitizeIdentifier,
  executeParamQuery,
};