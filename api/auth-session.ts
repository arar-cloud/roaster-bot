/**
 * Authentication and Session Token Handling Module
 * Addresses secure token generation, validation, refresh logic, and session management
 * Issue: security:issue-7ae92d25e4, security:issue-6ad68f6642
 */

import crypto from 'crypto';

interface SessionToken {
  token: string;
  userId: string;
  role: string;
  issuedAt: number;
  expiresAt: number;
  refreshToken?: string;
}

interface AuthSession {
  [sessionId: string]: SessionToken;
}

// In-memory session store (use Redis or database in production)
const activeSessions: AuthSession = {};

// Configuration (should be in environment variables in production)
const TOKEN_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes
const REFRESH_TOKEN_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const TOKEN_LENGTH = 32; // Bytes for cryptographic randomness

/**
 * Generates a cryptographically secure token
 * @returns Random token string (hex-encoded)
 */
export const generateSecureToken = (): string => {
  return crypto.randomBytes(TOKEN_LENGTH).toString('hex');
};

/**
 * Creates a new authentication session
 * @param userId - User identifier
 * @param role - User role (used for authorization)
 * @returns SessionToken with token and refresh token
 */
export const createAuthSession = (userId: string, role: string = 'user'): SessionToken => {
  // Validate inputs
  if (!userId || typeof userId !== 'string' || userId.length === 0) {
    throw new Error('Invalid userId');
  }
  if (!role || typeof role !== 'string' || role.length === 0) {
    throw new Error('Invalid role');
  }

  const now = Date.now();
  const sessionToken: SessionToken = {
    token: generateSecureToken(),
    userId: userId,
    role: role,
    issuedAt: now,
    expiresAt: now + TOKEN_EXPIRY_MS,
    refreshToken: generateSecureToken(),
  };

  // Store session
  activeSessions[sessionToken.token] = sessionToken;

  return sessionToken;
};

/**
 * Validates an authentication token
 * @param token - Token string to validate
 * @returns SessionToken if valid, throws error if invalid
 */
export const validateAuthToken = (token: string): SessionToken => {
  if (!token || typeof token !== 'string') {
    throw new Error('Invalid token format');
  }

  // Check if token exists in session store
  if (!(token in activeSessions)) {
    throw new Error('Token not found or revoked');
  }

  const session = activeSessions[token];
  const now = Date.now();

  // Check if token is expired
  if (now > session.expiresAt) {
    // Clean up expired token
    delete activeSessions[token];
    throw new Error('Token expired');
  }

  return session;
};

/**
 * Refreshes an authentication token using refresh token
 * @param refreshToken - Refresh token string
 * @returns New SessionToken with updated token and expiresAt
 */
export const refreshAuthToken = (refreshToken: string): SessionToken => {
  if (!refreshToken || typeof refreshToken !== 'string') {
    throw new Error('Invalid refresh token format');
  }

  // Find session with matching refresh token
  let oldSession: SessionToken | null = null;
  let oldToken: string | null = null;

  for (const [token, session] of Object.entries(activeSessions)) {
    if (session.refreshToken === refreshToken) {
      oldSession = session;
      oldToken = token;
      break;
    }
  }

  if (!oldSession || !oldToken) {
    throw new Error('Refresh token not found or revoked');
  }

  // Check if refresh token is still within valid window
  const now = Date.now();
  if (now > oldSession.expiresAt + REFRESH_TOKEN_EXPIRY_MS) {
    delete activeSessions[oldToken];
    throw new Error('Refresh token expired');
  }

  // Create new session with same userId and role
  const newSession = createAuthSession(oldSession.userId, oldSession.role);

  // Revoke old token
  delete activeSessions[oldToken];

  return newSession;
};

/**
 * Revokes an authentication token (logout)
 * @param token - Token to revoke
 */
export const revokeAuthToken = (token: string): void => {
  if (token && token in activeSessions) {
    delete activeSessions[token];
  }
};

/**
 * Revokes all sessions for a user (force logout all devices)
 * @param userId - User identifier
 */
export const revokeAllUserSessions = (userId: string): void => {
  for (const [token, session] of Object.entries(activeSessions)) {
    if (session.userId === userId) {
      delete activeSessions[token];
    }
  }
};

/**
 * Extracts user information from a valid token
 * @param token - Token string
 * @returns User ID and role
 */
export const extractUserFromToken = (token: string): { userId: string; role: string } => {
  const session = validateAuthToken(token);
  return {
    userId: session.userId,
    role: session.role,
  };
};

/**
 * Checks if a user has a specific role or permission
 * @param token - Token string
 * @param requiredRole - Required role to check
 * @returns boolean indicating if user has required role
 */
export const hasRole = (token: string, requiredRole: string): boolean => {
  try {
    const session = validateAuthToken(token);
    // Simple role check; in production, implement role hierarchy
    return session.role === requiredRole || session.role === 'admin';
  } catch {
    return false;
  }
};

/**
 * Gets session statistics (for monitoring/audit)
 * @returns Count of active sessions
 */
export const getSessionStats = (): { activeSessionCount: number; sessionIds: string[] } => {
  const now = Date.now();
  const activeTokens = Object.entries(activeSessions)
    .filter(([_, session]) => now <= session.expiresAt)
    .map(([token, _]) => token);

  return {
    activeSessionCount: activeTokens.length,
    sessionIds: activeTokens,
  };
};

/**
 * Cleans up expired sessions (should be called periodically)
 */
export const cleanupExpiredSessions = (): number => {
  const now = Date.now();
  let cleanedCount = 0;

  for (const [token, session] of Object.entries(activeSessions)) {
    if (now > session.expiresAt + REFRESH_TOKEN_EXPIRY_MS) {
      delete activeSessions[token];
      cleanedCount++;
    }
  }

  return cleanedCount;
};

export default {
  generateSecureToken,
  createAuthSession,
  validateAuthToken,
  refreshAuthToken,
  revokeAuthToken,
  revokeAllUserSessions,
  extractUserFromToken,
  hasRole,
  getSessionStats,
  cleanupExpiredSessions,
};