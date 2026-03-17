/**
 * Voice transcription for WhatsApp voice notes (Meta Cloud API).
 *
 * Flow:
 *   1. Meta sends a message with type=audio and audio.id (media ID).
 *   2. We fetch the media URL from Graph API using the media ID and business token.
 *   3. We download the audio bytes, then send to Groq Whisper API for transcript.
 */

import 'dotenv/config';
import { getBusinessWhatsAppConfig } from './whatsapp.service.js';

const GROQ_API_KEY = process.env.GROQ_API_KEY;

/**
 * Fetch audio bytes from Meta Graph API given a media ID.
 * @param {string} mediaId - Meta media ID from msg.audio.id
 * @param {number} businessId - Business ID for WhatsApp token (used for multi-tenant)
 * @returns {Promise<{ buffer: Buffer, mimeType: string | null }>}
 */
export async function downloadMetaAudio(mediaId, businessId) {
  if (!mediaId) {
    throw new Error('Missing mediaId for WhatsApp audio');
  }

  const { accessToken, apiVersion } = await getBusinessWhatsAppConfig(businessId);
  if (!accessToken) {
    throw new Error('WhatsApp access token not set — cannot download media');
  }

  const metaUrl = `https://graph.facebook.com/${apiVersion}/${mediaId}`;
  const metaRes = await fetch(metaUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!metaRes.ok) {
    const t = await metaRes.text();
    throw new Error(`Meta media lookup failed ${metaRes.status}: ${t}`);
  }

  const metaData = await metaRes.json();
  const url = metaData?.url;
  const mimeType = metaData?.mime_type || null;

  if (!url) {
    throw new Error('Meta media lookup returned no url');
  }

  const binRes = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!binRes.ok) {
    const t = await binRes.text();
    throw new Error(`Meta media download failed ${binRes.status}: ${t}`);
  }

  const arrayBuffer = await binRes.arrayBuffer();
  return { buffer: Buffer.from(arrayBuffer), mimeType };
}

/**
 * Transcribe an audio buffer using Groq Whisper API.
 * Supports: flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm (and AMR/3GPP via ogg).
 *
 * @param {Buffer} audioBuffer - Raw audio bytes
 * @param {string} contentType - MIME type e.g. "audio/ogg"
 * @returns {Promise<string>} - Transcript text
 */
export async function transcribeWithGroq(audioBuffer, contentType) {
  if (!GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY not set — cannot transcribe audio');
  }

  const extMap = {
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'mp4',
    'audio/wav': 'wav',
    'audio/webm': 'webm',
    'audio/flac': 'flac',
    'audio/amr': 'ogg',
    'audio/3gpp': 'ogg',
  };
  const ext = extMap[contentType] || 'ogg';
  const filename = `voice.${ext}`;

  const formData = new FormData();
  const blob = new Blob([audioBuffer], { type: contentType });
  formData.append('file', blob, filename);
  formData.append('model', 'whisper-large-v3-turbo');
  formData.append('response_format', 'json');

  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
    body: formData,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Groq Whisper error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return (data.text || '').trim();
}

/**
 * Download a WhatsApp voice note from Meta and transcribe it.
 *
 * @param {string} mediaId - Meta media ID (msg.audio.id)
 * @param {string} [hintedMimeType] - Optional MIME from msg.audio.mime_type
 * @param {number} businessId - Business ID for WhatsApp config
 * @returns {Promise<string>} - Transcript text, or empty string on failure
 */
export async function transcribeMetaAudio(mediaId, hintedMimeType, businessId) {
  const contentType = hintedMimeType || 'audio/ogg';
  console.log(`[Whisper] Transcribing voice note: ${contentType} (biz ${businessId})`);

  try {
    const { buffer, mimeType } = await downloadMetaAudio(mediaId, businessId);
    const effectiveType = mimeType || contentType;
    const transcript = await transcribeWithGroq(buffer, effectiveType);
    console.log(`[Whisper] Transcript: "${transcript}"`);
    return transcript;
  } catch (err) {
    console.error('[Whisper] Transcription failed:', err.message);
    return '';
  }
}
