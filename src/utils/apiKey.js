import crypto from 'crypto';

/**
 * Generate a secure random API key
 * Format: apb_live_<32 random hex chars>
 */
export function generateApiKey(prefix = 'apb') {
  const randomBytes = crypto.randomBytes(24);
  const randomString = randomBytes.toString('base64url');
  return `${prefix}_live_${randomString}`;
}

/**
 * Validate API key format
 */
export function isValidApiKeyFormat(apiKey) {
  if (!apiKey || typeof apiKey !== 'string') return false;
  return /^apb_live_[A-Za-z0-9_-]{32}$/.test(apiKey);
}
