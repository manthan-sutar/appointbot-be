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
        '// Error: API key is required. Get your API key from the appointbot dashboard.'
      );
    }

    if (!isValidApiKeyFormat(apiKey)) {
      return res.status(401).type('application/javascript').send(
        '// Error: Invalid API key format.'
      );
    }

    const business = await getBusinessByWidgetApiKey(apiKey);
    if (!business) {
      return res.status(401).type('application/javascript').send(
        '// Error: Invalid API key.'
      );
    }

    // Attach business to request for use in route handler
    req.business = business;
    next();
  } catch (err) {
    console.error('[Widget Auth] Error:', err);
    res.status(500).type('application/javascript').send(
      '// Error: Server error validating API key.'
    );
  }
}
