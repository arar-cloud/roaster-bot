/**
 * Validate JSON structure depth to prevent parser DoS attacks
 * Deeply nested objects can cause exponential time complexity even if total size is small
 */

const MAX_DEPTH = 20; // Maximum nesting depth allowed
const MAX_ARRAY_LENGTH = 1000; // Maximum array length at any level
const MAX_OBJECT_KEYS = 100; // Maximum object keys at any level

interface DepthValidationResult {
  valid: boolean;
  error?: string;
  depth?: number;
}

/**
 * Recursively validate object structure depth and breadth
 */
export const validatePayloadDepth = (
  payload: any,
  currentDepth: number = 0,
  maxDepth: number = MAX_DEPTH
): DepthValidationResult => {
  // Check depth limit
  if (currentDepth > maxDepth) {
    return {
      valid: false,
      error: `Payload nesting exceeds maximum depth of ${maxDepth}`,
      depth: currentDepth,
    };
  }

  // Skip validation for primitives
  if (payload === null || payload === undefined || typeof payload !== 'object') {
    return { valid: true, depth: currentDepth };
  }

  // Validate arrays
  if (Array.isArray(payload)) {
    if (payload.length > MAX_ARRAY_LENGTH) {
      return {
        valid: false,
        error: `Array length ${payload.length} exceeds maximum of ${MAX_ARRAY_LENGTH}`,
        depth: currentDepth,
      };
    }

    // Validate each array element
    for (let i = 0; i < payload.length; i++) {
      const result = validatePayloadDepth(payload[i], currentDepth + 1, maxDepth);
      if (!result.valid) {
        return {
          ...result,
          error: `Array[${i}]: ${result.error}`,
        };
      }
    }
  } else {
    // Validate objects
    const keys = Object.keys(payload);
    if (keys.length > MAX_OBJECT_KEYS) {
      return {
        valid: false,
        error: `Object has ${keys.length} keys, exceeds maximum of ${MAX_OBJECT_KEYS}`,
        depth: currentDepth,
      };
    }

    // Validate each object property
    for (const key of keys) {
      // Validate key name (prevent prototype pollution)
      if (
        key === '__proto__' ||
        key === 'constructor' ||
        key === 'prototype'
      ) {
        return {
          valid: false,
          error: `Forbidden property key: ${key}`,
          depth: currentDepth,
        };
      }

      const result = validatePayloadDepth(payload[key], currentDepth + 1, maxDepth);
      if (!result.valid) {
        return {
          ...result,
          error: `Property '${key}': ${result.error}`,
        };
      }
    }
  }

  return { valid: true, depth: currentDepth };
};
