import type { Pool } from 'pg';
import type { LinkPreview } from './linkPreview.js';

export async function getLinkPreviewByUrl(pool: Pool, url: string): Promise<LinkPreview | null> {
  const result = await pool.query(
    'select url, title, description, image_url, site_name, status, fetched_at as "fetchedAt" from link_preview where url = $1',
    [url],
  );
  if (result.rowCount === 0 || !result.rows[0]) return null;
  const row = result.rows[0];
  return {
    url: row.url,
    title: row.title,
    description: row.description,
    imageUrl: row.image_url,
    siteName: row.site_name,
    status: row.status,
    fetchedAt: row.fetchedAt,
  };
}