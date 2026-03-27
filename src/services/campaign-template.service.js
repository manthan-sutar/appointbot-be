import { query } from '../config/db.js';

export async function createTemplate({
  businessId,
  name,
  description = null,
  sendMode = 'text',
  metaTemplateName = null,
  templateLanguage = 'en',
  contentText = null,
  contentMediaUrl = null,
  variableCount = 0,
  variableLabels = [],
}) {
  const { rows } = await query(
    `INSERT INTO campaign_templates (
       business_id, name, description, send_mode, meta_template_name,
       template_language, content_text, content_media_url,
       variable_count, variable_labels
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
     RETURNING *`,
    [
      businessId,
      name,
      description,
      sendMode,
      metaTemplateName,
      templateLanguage,
      contentText,
      contentMediaUrl,
      variableCount,
      JSON.stringify(variableLabels || []),
    ],
  );
  return rows[0] || null;
}

export async function listTemplates(businessId) {
  const { rows } = await query(
    `SELECT *
     FROM campaign_templates
     WHERE business_id = $1
       AND active = TRUE
     ORDER BY created_at DESC`,
    [businessId],
  );
  return rows;
}

export async function getTemplate({ businessId, templateId }) {
  const { rows } = await query(
    `SELECT *
     FROM campaign_templates
     WHERE id = $1
       AND business_id = $2`,
    [templateId, businessId],
  );
  return rows[0] || null;
}

export async function updateTemplate({
  businessId,
  templateId,
  name,
  description,
  sendMode,
  metaTemplateName,
  templateLanguage,
  contentText,
  contentMediaUrl,
  variableCount,
  variableLabels,
}) {
  const fields = [];
  const values = [];
  let idx = 1;

  if (name !== undefined) {
    fields.push(`name = $${idx++}`);
    values.push(name);
  }
  if (description !== undefined) {
    fields.push(`description = $${idx++}`);
    values.push(description);
  }
  if (sendMode !== undefined) {
    fields.push(`send_mode = $${idx++}`);
    values.push(sendMode);
  }
  if (metaTemplateName !== undefined) {
    fields.push(`meta_template_name = $${idx++}`);
    values.push(metaTemplateName);
  }
  if (templateLanguage !== undefined) {
    fields.push(`template_language = $${idx++}`);
    values.push(templateLanguage);
  }
  if (contentText !== undefined) {
    fields.push(`content_text = $${idx++}`);
    values.push(contentText);
  }
  if (contentMediaUrl !== undefined) {
    fields.push(`content_media_url = $${idx++}`);
    values.push(contentMediaUrl);
  }
  if (variableCount !== undefined) {
    fields.push(`variable_count = $${idx++}`);
    values.push(variableCount);
  }
  if (variableLabels !== undefined) {
    fields.push(`variable_labels = $${idx++}::jsonb`);
    values.push(JSON.stringify(variableLabels || []));
  }

  if (!fields.length) return null;

  fields.push(`updated_at = NOW()`);
  values.push(templateId);
  values.push(businessId);

  const { rows } = await query(
    `UPDATE campaign_templates
     SET ${fields.join(', ')}
     WHERE id = $${idx++}
       AND business_id = $${idx++}
     RETURNING *`,
    values,
  );

  return rows[0] || null;
}

export async function deleteTemplate({ businessId, templateId }) {
  await query(
    `UPDATE campaign_templates
     SET active = FALSE,
         updated_at = NOW()
     WHERE id = $1
       AND business_id = $2`,
    [templateId, businessId],
  );
}
