/**
 * Canonical `leads.source` values for funnel analytics (web chat page, embed widget, WhatsApp).
 * Legacy values (`chat_page`, `website_chat_widget`) are normalized in dashboard SQL and UI.
 */
export const LEAD_SOURCE = {
  WEB_CHAT_PAGE: 'web_chat_page',
  WEB_CHAT_WIDGET: 'web_chat_widget',
  WHATSAPP: 'whatsapp',
  UNKNOWN: 'unknown',
};

/** Default when POST body omits `source` (hosted /chat HTML UI). */
export const DEFAULT_WEB_CHAT_PAGE_SOURCE = LEAD_SOURCE.WEB_CHAT_PAGE;

/** Default when POST body omits `source` (embedded widget / API). */
export const DEFAULT_WEB_CHAT_WIDGET_SOURCE = LEAD_SOURCE.WEB_CHAT_WIDGET;
