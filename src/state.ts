/**
 * State reconciliation and validation module
 * Handles cross-platform state consistency, conflict resolution, and validation
 * for web, mobile, and backend components
 */

export interface StateVersion {
  version: number;
  timestamp: number;
  hash: string;
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
