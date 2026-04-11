/**
 * State reconciliation and validation module
 * Handles cross-platform state consistency, conflict resolution, and validation
 * for web, mobile, and backend components
 */

export interface LogContext {
  traceId: string;
  operation: string;
  platform?: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export class StructuredLogger {
  private context: LogContext;

  constructor(traceId: string) {
    this.context = {
      traceId,
      operation: 'unknown',
      timestamp: Date.now(),
    };
  }

  info(operation: string, metadata?: Record<string, unknown>): void {
    console.log(JSON.stringify({
      level: 'INFO',
      ...this.context,
      operation,
      metadata,
    }));
  }

  error(operation: string, error: Error | unknown, metadata?: Record<string, unknown>): void {
    const err = error instanceof Error ? error : new Error(String(error));
    const errorContext = {
      errorName: err.name,
      errorMessage: err.message,
      errorStack: err.stack,
      // Include cause if available (Error.cause in Node.js 16.9+)
      errorCause: (err as any).cause ? String((err as any).cause) : undefined,
    };
    console.error(JSON.stringify({
      level: 'ERROR',
      ...this.context,
      operation,
      ...errorContext,
      metadata,
      timestamp: Date.now(),
    }));
  }

  warn(operation: string, message: string, metadata?: Record<string, unknown>): void {
    console.warn(JSON.stringify({
      level: 'WARN',
      ...this.context,
      operation,
      message,
      metadata, Record<string, unknown>): void {
    console.error(JSON.stringify({
      level: 'ERROR',
      ...this.context,
      operation,
      error: { message: error.message, stack: error.stack },
      metadata,
    }));
  }

  warn(operation: string, metadata?: Record<string, unknown>): void {
    console.warn(JSON.stringify({
      level: 'WARN',
      ...this.context,
      operation,
      metadata,
    }));
  }
}

export interface StateVersion {
  version: number;
  timestamp: number;
  hash: string;
  cacheExpireAt?: number; // TTL-based expiration timestamp
}

export interface CacheEntry<T = unknown> {
  data: T;
  version: number;
  createdAt: number;
  ttlMs: number;
  tags?: string[]; // Tags for bulk invalidation
}

export interface CachePolicy {
  ttlMs: number; // Time-to-live in milliseconds
  maxSize?: number; // Maximum cache entries
  enableVersioning?: boolean;
}

export interface StateSnapshot {
  id: string;
  platform: 'web' | 'mobile' | 'backend';
  data: Record<string, unknown>;
  version: StateVersion;
}

export interface ConflictResolutionStrategy {
  strategy: 'last-write-wins' | 'first-write-wins' | 'custom';
  compareFn?: (local: StateSnapshot, remote: StateSnapshot) => StateSnapshot;
}

export class StateCache {
  private cache: Map<string, CacheEntry> = new Map();
  private policy: CachePolicy;

  constructor(policy: CachePolicy = { ttlMs: 5 * 60 * 1000 }) {
    this.policy = policy;
  }

  set<T>(key: string, value: T, version: number, tags?: string[]): void {
    const entry: CacheEntry<T> = {
      data: value,
      version,
      createdAt: Date.now(),
      ttlMs: this.policy.ttlMs,
      tags,
    };
    this.cache.set(key, entry);
    if (this.policy.maxSize && this.cache.size > this.policy.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
  }

  get<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    const isExpired = Date.now() - entry.createdAt > entry.ttlMs;
    if (isExpired) {
      this.cache.delete(key);
      return null;
    }
    return entry.data as T;
  }

  invalidate(key: string): void {
    this.cache.delete(key);
  }

  invalidateByTag(tag: string): void {
    const keysToDelete: string[] = [];
    for (const [key, entry] of this.cache.entries()) {
      if (entry.tags?.includes(tag)) {
        keysToDelete.push(key);
      }
    }
    keysToDelete.forEach(key => this.cache.delete(key));
  }

  clear(): void {
    this.cache.clear();
  }

  isExpired(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return true;
    return Date.now() - entry.createdAt > entry.ttlMs;
  }
}

export interface Transaction {
  id: string;
  operations: StateOperation[];
  status: 'pending' | 'committed' | 'rolled_back';
  timestamp: number;
  checksum?: string;
}

export interface OfflineSnapshot {
  stateId: string;
  data: StateSnapshot;
  createdAt: number;
  txnQueue: Transaction[];
}

export class StateRecoveryManager {
  private offlineSnapshots: Map<string, OfflineSnapshot> = new Map();
  private reconnectHandlers: Array<() => Promise<void>> = [];
  private isOnline: boolean = true;
  private pendingTransactions: Transaction[] = [];

  constructor() {
    // Setup network event listeners
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => this.handleReconnect());
      window.addEventListener('offline', () => this.handleOffline());
    }
  }

  saveOfflineSnapshot(snapshot: StateSnapshot, transactions: Transaction[]): void {
    const offlineSnapshot: OfflineSnapshot = {
      stateId: snapshot.id,
      data: snapshot,
      createdAt: Date.now(),
      txnQueue: transactions,
    };
    this.offlineSnapshots.set(snapshot.id, offlineSnapshot);
    console.log(`[StateRecovery] Saved offline snapshot for state ${snapshot.id}`);
  }

  getOfflineSnapshot(stateId: string): OfflineSnapshot | null {
    return this.offlineSnapshots.get(stateId) ?? null;
  }

  async rehydrateState(stateId: string, remoteSnapshot: StateSnapshot): Promise<StateSnapshot> {
    const offlineSnapshot = this.getOfflineSnapshot(stateId);
    if (!offlineSnapshot) {
      console.log(`[StateRecovery] No offline snapshot found, using remote state`);
      return remoteSnapshot;
    }

    const merged: StateSnapshot = {
      ...remoteSnapshot,
      data: {
        ...remoteSnapshot.data,
        ...offlineSnapshot.data.data,
      },
      version: {
        version: Math.max(remoteSnapshot.version.version, offlineSnapshot.data.version.version) + 1,
        timestamp: Date.now(),
        hash: this.computeHash({
          ...remoteSnapshot.data,
          ...offlineSnapshot.data.data,
        }),
      },
    };
    console.log(`[StateRecovery] Rehydrated state ${stateId} with ${offlineSnapshot.txnQueue.length} pending transactions`);
    return merged;
  }

  registerReconnectHandler(handler: () => Promise<void>): void {
    this.reconnectHandlers.push(handler);
  }

  private async handleReconnect(): Promise<void> {
    console.log(`[StateRecovery] Network reconnected, rehydrating state...`);
    this.isOnline = true;
    for (const handler of this.reconnectHandlers) {
      try {
        await handler();
      } catch (error) {
        console.error(`[StateRecovery] Rehydration handler failed:`, error);
      }
    }
  }

  private handleOffline(): void {
    console.log(`[StateRecovery] Network offline, preserving state for recovery`);
    this.isOnline = false;
  }

  isNetworkOnline(): boolean {
    return this.isOnline;
  }

  private computeHash(data: Record<string, unknown>): string {
    // Simple hash for state versioning
    return JSON.stringify(data).split('').reduce((a, b) => ((a << 5) - a) + b.charCodeAt(0), 0).toString(16);
  }
}

export interface StateOperation {
  type: 'update' | 'delete' | 'create';
  path: string;
  value?: unknown;
  previousValue?: unknown;
}

export interface AtomicWriteGuard {
  locked: boolean;
  transactionId?: string;
  acquiredAt?: number;
  timeout: number;
}

/**
 * Compute hash of state object for conflict detection
 */
export function computeStateHash(data: Record<string, unknown>): string {
  const sorted = JSON.stringify(data, Object.keys(data).sort());
  // Simple hash for comparison - in production use crypto.createHash
  let hash = 0;
  for (let i = 0; i < sorted.length; i++) {
    const char = sorted.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash.toString(16);
}

/**
 * Validate state consistency before mutations
 * Ensures data integrity and prevents corrupt writes
 */
export function validateStateConsistency(snapshot: StateSnapshot, expectedHash?: string): boolean {
  if (!snapshot || !snapshot.data || typeof snapshot.data !== 'object') {
    return false;
  }
  if (expectedHash && computeStateHash(snapshot.data) !== expectedHash) {
    return false;
  }
  if (snapshot.version.timestamp > Date.now() + 60000) {
    return false;
  }
  return true;
}

/**
 * Atomic write guard to prevent concurrent mutations
 * Uses simple locking mechanism for single-threaded Node.js
 */
const writeGuards = new Map<string, AtomicWriteGuard>();

export function acquireWriteLock(stateId: string, transactionId: string, timeout: number = 30000): boolean {
  if (writeGuards.has(stateId)) {
    const guard = writeGuards.get(stateId)!;
    if (guard.locked && Date.now() - (guard.acquiredAt || 0) < guard.timeout) {
      return false;
    }
  }
  writeGuards.set(stateId, { locked: true, transactionId, acquiredAt: Date.now(), timeout });
  return true;
}

export function releaseWriteLock(stateId: string, transactionId: string): boolean {
  const guard = writeGuards.get(stateId);
  if (guard && guard.transactionId === transactionId) {
    writeGuards.delete(stateId);
    return true;
  }
  return false;
}

/**
 * Validate state snapshot structure and required fields
 */
export function validateStateSnapshot(snapshot: unknown): snapshot is StateSnapshot {
  if (!snapshot || typeof snapshot !== 'object') {
    return false;
  }

  const obj = snapshot as Record<string, unknown>;
  
  // Check required fields
  if (typeof obj.id !== 'string' || !obj.id) {
    console.warn('Invalid state snapshot: missing or invalid id');
    return false;
  }

  if (!['web', 'mobile', 'backend'].includes(obj.platform as string)) {
    console.warn('Invalid state snapshot: invalid platform');
    return false;
  }

  if (!obj.data || typeof obj.data !== 'object') {
    console.warn('Invalid state snapshot: missing or invalid data');
    return false;
  }

  const version = obj.version as Record<string, unknown> | undefined;
  if (!version || typeof version.version !== 'number' || 
      typeof version.timestamp !== 'number' || 
      typeof version.hash !== 'string') {
    console.warn('Invalid state snapshot: invalid version metadata');
    return false;
  }

  return true;
}

/**
 * Reconcile two state snapshots using conflict resolution strategy
 * Returns merged state with highest priority version
 */
export function reconcileState(
  local: StateSnapshot,
  remote: StateSnapshot,
  strategy: ConflictResolutionStrategy = { strategy: 'last-write-wins' }
): StateSnapshot {
  // Validate both snapshots
  if (!validateStateSnapshot(local)) {
    console.warn('Local state snapshot validation failed, using remote');
    return remote;
  }

  if (!validateStateSnapshot(remote)) {
    console.warn('Remote state snapshot validation failed, using local');
    return local;
  }

  // Check for conflicts
  const localHash = local.version.hash;
  const remoteHash = remote.version.hash;

  if (localHash === remoteHash) {
    // No conflict, states are identical
    return local;
  }

  // Conflict detected, apply resolution strategy
  switch (strategy.strategy) {
    case 'last-write-wins':
      return local.version.timestamp >= remote.version.timestamp ? local : remote;

    case 'first-write-wins':
      return local.version.timestamp <= remote.version.timestamp ? local : remote;

    case 'custom':
      if (strategy.compareFn) {
        return strategy.compareFn(local, remote);
      }
      return local; // fallback to local

    default:
      console.warn('Unknown conflict resolution strategy, using last-write-wins');
      return local.version.timestamp >= remote.version.timestamp ? local : remote;
  }
}

/**
 * Merge state snapshots from multiple platforms into unified state
 * Handles partial updates and missing platforms gracefully
 */
export function mergeStateSnapshots(
  snapshots: (StateSnapshot | null | undefined)[],
  strategy?: ConflictResolutionStrategy
): StateSnapshot | null {
  // Filter out null/undefined and validate remaining snapshots
  const validSnapshots = snapshots.filter(
    (snap): snap is StateSnapshot => validateStateSnapshot(snap)
  );

  if (validSnapshots.length === 0) {
    console.warn('No valid state snapshots to merge');
    return null;
  }

  if (validSnapshots.length === 1) {
    return validSnapshots[0];
  }

  // Recursively reconcile multiple snapshots
  let merged = validSnapshots[0];
  for (let i = 1; i < validSnapshots.length; i++) {
    merged = reconcileState(merged, validSnapshots[i], strategy);
  }

  return merged;
}

/**
 * Create a new state snapshot with updated version metadata
 */
export function createStateSnapshot(
  id: string,
  platform: 'web' | 'mobile' | 'backend',
  data: Record<string, unknown>,
  previousVersion?: number
): StateSnapshot {
  const newVersion = (previousVersion ?? 0) + 1;
  const timestamp = Date.now();
  const hash = computeStateHash(data);

  return {
    id,
    platform,
    data,
    version: {
      version: newVersion,
      timestamp,
      hash,
    },
  };
}

/**
 * Pre-commit validation and conflict detection for transactions
 * Ensures no conflicting writes occur before transaction commits
 */
export function validatePreCommit(snapshot: StateSnapshot, previousChecksum: string): boolean {
  if (!validateStateConsistency(snapshot)) {
    return false;
  }
  const currentChecksum = computeStateHash(snapshot.data);
  return currentChecksum === previousChecksum;
}

/**
 * Detect if state has drifted by comparing local and remote versions
 * Returns drift information for reconciliation logic
 */
export function detectStateDrift(
  local: StateSnapshot | null | undefined,
  remote: StateSnapshot | null | undefined
): { hasDrift: boolean; reason: string } {
  if (!local || !remote) {
    return {
      hasDrift: !local || !remote,
      reason: 'One or both state snapshots missing',
    };
  }

  if (!validateStateSnapshot(local) || !validateStateSnapshot(remote)) {
    return {
      hasDrift: true,
      reason: 'Invalid state snapshot structure',
    };
  }

  if (local.version.hash !== remote.version.hash) {
    return {
      hasDrift: true,
      reason: `Version hash mismatch: local=${local.version.hash}, remote=${remote.version.hash}`,
    };
  }

  if (local.version.version !== remote.version.version) {
    return {
      hasDrift: true,
      reason: `Version number mismatch: local=${local.version.version}, remote=${remote.version.version}`,
    };
  }

  return {
    hasDrift: false,
    reason: 'States are synchronized',
  };
}
