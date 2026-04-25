/**
 * Advanced prompt injection detection
 * Goes beyond simple blocklist to detect variations and encoding tricks
 */

// Normalize text for comparison (remove unicode variants, normalize case)
const normalizeText = (text: string): string => {
  return text
    .toLowerCase()
    .normalize('NFKD') // Normalize unicode variants
    .replace(/[\p{Diacritic}]/gu, '') // Remove diacritics
    .replace(/[\s\n\r\t]+/g, ' ') // Normalize whitespace
    .trim();
};

// Decode common encoding tricks
const decodeText = (text: string): string[] => {
  const variants: string[] = [text];
  
  // Try URL decoding
  try {
    variants.push(decodeURIComponent(text));
  } catch {}
  
  // Try base64 decoding
  if (/^[A-Za-z0-9+/=]+$/.test(text) && text.length % 4 === 0) {
    try {
      variants.push(Buffer.from(text, 'base64').toString('utf8'));
    } catch {}
  }
  
  return variants;
};

// Suspicious patterns that indicate prompt injection attempts
const SUSPICIOUS_PATTERNS = [
  // Direct override commands
  /ignore\s+(?:previous|instructions|prompt|context)/i,
  /forget\s+(?:everything|what|previous|last)/i,
  /disregard\s+(?:all|previous|above)/i,
  /override\s+(?:instructions|rules|guidelines)/i,
  /system\s+(?:prompt|instructions|message|override)/i,
  /jailbreak/i,
  /bypass/i,
  /evil\s+mode/i,
  /admin\s+(?:mode|access|override)/i,
  
  // Hidden instruction markers
  /^[\\\\s]*hidden|^[\\\\s]*secret|^[\\\\s]*debug/i,
  /\[system\]|\[admin\]|\[hidden\]/i,
  /<SYSTEM>|<ADMIN>|<HIDDEN>/i,
  
  // Prompt template injection
  /{{.*}}|{%.*%}|{#.*#}/,
  
  // Role-play tricks
  /act\s+as\s+(?:admin|root|system|hacker|attacker)/i,
  /pretend\s+(?:you|i|we)\s+(?:are|is)\s+(?:admin|root|unrestricted)/i,
  /roleplay.*(?:admin|unrestricted)/i,
  
  // Token smuggling
  /continue|resuming|proceed with|next step|now (that|complete)/i,
  
  // Instruction injection via user content
  /instruct|directive|command\s+(?:me|us)|tell\s+me\s+(?:to|how to)/i,
];

const SUSPICIOUS_KEYWORDS = [
  'ignore previous',
  'system prompt',
  'forget',
  'jailbreak',
  'bypass',
  'override',
  'hidden',
  'secret',
  'admin',
  'root',
  'unrestricted',
  'evil mode',
];

interface InjectionDetectionResult {
  isInjection: boolean;
  risk: 'low' | 'medium' | 'high';
  detectedPatterns: string[];
  normalizedText: string;
}

/**
 * Detect potential prompt injection in user message
 */
export const detectPromptInjection = (message: string): InjectionDetectionResult => {
  const detectedPatterns: string[] = [];
  const normalized = normalizeText(message);
  
  // Check decoded variants (catches encoding tricks)
  const variants = decodeText(message);
  
  for (const variant of variants) {
    const variantNormalized = normalizeText(variant);
    
    // Check regex patterns
    for (const pattern of SUSPICIOUS_PATTERNS) {
      if (pattern.test(variantNormalized)) {
        const patternStr = pattern.source.substring(0, 50);
        if (!detectedPatterns.includes(patternStr)) {
          detectedPatterns.push(patternStr);
        }
      }
    }
    
    // Check keywords (more lenient than regex)
    for (const keyword of SUSPICIOUS_KEYWORDS) {
      if (variantNormalized.includes(keyword)) {
        if (!detectedPatterns.includes(keyword)) {
          detectedPatterns.push(keyword);
        }
      }
    }
  }
  
  // Determine risk level
  let risk: 'low' | 'medium' | 'high' = 'low';
  if (detectedPatterns.length >= 3) {
    risk = 'high';
  } else if (detectedPatterns.length >= 2) {
    risk = 'medium';
  } else if (detectedPatterns.length === 1) {
    // Check if it's a high-confidence pattern
    const highConfidenceKeywords = [
      'jailbreak',
      'system prompt',
      'override',
      'bypass',
    ];
    if (highConfidenceKeywords.some(kw => detectedPatterns.some(dp => dp.includes(kw)))) {
      risk = 'high';
    } else {
      risk = 'low';
    }
  }
  
  return {
    isInjection: detectedPatterns.length > 0,
    risk,
    detectedPatterns,
    normalizedText: normalized,
  };
};
