import { getBusinessByWidgetApiKey } from '../services/appointment.service.js';
import { isValidApiKeyFormat } from '../utils/apiKey.js';

/**
 * Middleware to validate widget API key
 * Extracts API key from query params and validates it against the database
 */
export async function validateWidgetApiKey(req, res, next) {
  try {
    const apiKey = req.query.api_key || req.query.apiKey;

    if (!apiKey) {
      return res.status(401).type('application/javascript').send(
        '// Error: API key is required. Get your API key from the appointbot dashboard.',
      );
    }

    if (!isValidApiKeyFormat(apiKey)) {
      return res.status(401).type('application/javascript').send(
        '// Error: Invalid API key format.',
      );
    }

    const business = await getBusinessByWidgetApiKey(apiKey);
    if (!business) {
      return res.status(401).type('application/javascript').send(
        '// Error: Invalid API key.',
      );
    }

    req.business = business;
    next();
  } catch (err) {
    console.error('[Widget Auth] Error:', err);
    res.status(500).type('application/javascript').send(
      '// Error: Server error validating API key.',
    );
  }
}

/**
 * Same as validateWidgetApiKey but for JSON API (POST /api/widget/*).
 * Key from X-Widget-Api-Key or Authorization: Bearer
 */
export async function validateWidgetApiKeyHeader(req, res, next) {
  try {
    const raw =
      req.headers['x-widget-api-key'] ||
      req.headers['X-Widget-Api-Key'] ||
      (req.headers.authorization && String(req.headers.authorization).replace(/^Bearer\s+/i, ''));

    if (!raw) {
      return res.status(401).json({ error: 'Missing X-Widget-Api-Key header' });
    }

    if (!isValidApiKeyFormat(raw)) {
      return res.status(401).json({ error: 'Invalid API key format' });
    }

    const business = await getBusinessByWidgetApiKey(raw);
    if (!business) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    req.business = business;
    next();
  } catch (err) {
    console.error('[Widget Auth] Header error:', err);
    res.status(500).json({ error: 'Server error validating API key' });
  }
}
