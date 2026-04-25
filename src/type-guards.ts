/**
 * Strict type guards to prevent type coercion attacks
 * JavaScript's loose typing can lead to security issues when inputs are coerced
 */

/**
 * Validate that a value is strictly a string (not a number, boolean, or object coerced to string)
 */
export const isStrictString = (value: unknown): value is string => {
  return typeof value === 'string';
};

/**
 * Validate that a value is strictly a number (not a string coercible to number)
 */
export const isStrictNumber = (value: unknown): value is number => {
  return typeof value === 'number' && !isNaN(value) && isFinite(value);
};

/**
 * Validate that a value is strictly a boolean
 */
export const isStrictBoolean = (value: unknown): value is boolean => {
  return typeof value === 'boolean';
};

/**
 * Validate that a value is strictly an array
 */
export const isStrictArray = (value: unknown): value is Array<unknown> => {
  return Array.isArray(value);
};

/**
 * Validate that a value is a string array (not mixed types)
 */
export const isStringArray = (value: unknown): value is string[] => {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
};

/**
 * Validate that a value is a string with bounds checking
 */
export const isValidString = (
  value: unknown,
  minLength: number = 0,
  maxLength: number = 65536
): value is string => {
  return (
    typeof value === 'string' &&
    value.length >= minLength &&
    value.length <= maxLength
  );
};

/**
 * Validate that a value matches a regex pattern (strict string first)
 */
export const isStringMatching = (
  value: unknown,
  pattern: RegExp
): value is string => {
  return typeof value === 'string' && pattern.test(value);
};

/**
 * Validate enum membership (prevent arbitrary string values)
 */
export const isEnumValue = <T extends Record<string, string>>(
  value: unknown,
  enumObj: T
): value is T[keyof T] => {
  return (
    typeof value === 'string' &&
    Object.values(enumObj).includes(value as any)
  );
};

/**
 * Validate object structure - check that all properties match expected types
 */
export const isValidObject = (
  value: unknown,
  schema: Record<string, (v: unknown) => boolean>
): boolean => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  
  const obj = value as Record<string, unknown>;
  
  for (const [key, validator] of Object.entries(schema)) {
    if (!(key in obj)) {
      return false;
    }
    if (!validator(obj[key])) {
      return false;
    }
  }
  
  return true;
};

/**
 * Parse number safely without coercion
 */
export const parseNumberSafely = (
  value: unknown,
  min?: number,
  max?: number
): number | null => {
  if (!isStrictNumber(value)) {
    return null;
  }
  if (min !== undefined && value < min) {
    return null;
  }
  if (max !== undefined && value > max) {
    return null;
  }
  return value;
};
