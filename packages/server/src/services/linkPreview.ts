import type { Pool } from 'pg';
import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import { emitEvent } from '../events.js';

const PRIVATE_IP_PATTERNS = [
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^192\.168\./,
  /^127\./,
  /^169\.254\./,
  /^::1$/,
  /^fc00:/i,
  /^fe80:/i,
];

const BLOCKED_HOSTS = [
  'localhost',
  'metadata.google.internal',
  'metadata.google',
  '169.254.169.254',
  'metadata.aws.internal',
  'kubernetes.default.svc',
];

function isPrivateIp(ip: string): boolean {
  if (PRIVATE_IP_PATTERNS.some((pattern) => pattern.test(ip))) return true;
  if (ip.startsWith('0.')) return true;
  return false;
}

function isBlockedHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return BLOCKED_HOSTS.some((blocked) => lower === blocked || lower.endsWith('.' + blocked));
}

export type LinkPreview = {
  url: string;
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
  status: 'ok' | 'failed' | 'blocked';
  fetchedAt: Date;
};

export type LinkPreviewRow = {
  url: string;
  title: string | null;
  description: string | null;
  image_url: string | null;
  site_name: string | null;
  status: string;
  fetched_at: Date;
};

function normalizeUrl(inputUrl: string): string | null {
  try {
    const url = new URL(inputUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.port) {
      if (url.protocol === 'http:' && url.port === '80') url.port = '';
      else if (url.protocol === 'https:' && url.port === '443') url.port = '';
    }
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function extractUrls(text: string): string[] {
  const urlPattern = /https?:\/\/[^\s<>"']+/gi;
  const matches = text.match(urlPattern);
  if (!matches) return [];
  return [...new Set(matches.slice(0, 3))];
}

export { normalizeUrl, isPrivateIp, isBlockedHost, extractUrls, parseHtml, checkSsrfForUrl };

export async function queueLinkPreviewFetch(pool: Pool, url: string): Promise<void> {
  const normalized = normalizeUrl(url);
  if (!normalized) return;
  const client = await pool.connect();
  try {
    const existing = await client.query(
      'select 1 from link_preview where url = $1',
      [normalized],
    );
    if (existing.rowCount && existing.rowCount > 0) return;
    await client.query(
      "insert into link_preview (url, status, fetched_at) values ($1, 'ok', now())",
      [normalized],
    );
    fetchLinkPreview(normalized).then((preview) => {
      saveLinkPreview(pool, preview);
    }).catch(() => {});
  } finally {
    client.release();
  }
}

async function saveLinkPreview(pool: Pool, preview: LinkPreview | null): Promise<void> {
  if (!preview) return;
  let client;
  try {
    client = await pool.connect();
  } catch {
    return;
  }
  try {
    await client.query(
      `insert into link_preview (url, title, description, image_url, site_name, status, fetched_at)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (url) do update set
       title = excluded.title, description = excluded.description, image_url = excluded.image_url,
       site_name = excluded.site_name, status = excluded.status, fetched_at = excluded.fetched_at`,
      [preview.url, preview.title, preview.description, preview.imageUrl,
        preview.siteName, preview.status, preview.fetchedAt],
    );
    emitEvent({ type: 'link_preview.ready', url: preview.url, audience: 'all' });
  } finally {
    if (client) client.release();
  }
}

async function fetchLinkPreview(urlString: string): Promise<LinkPreview | null> {
  const normalized = normalizeUrl(urlString);
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    if (isBlockedHost(url.hostname)) {
      return { url: normalized, title: null, description: null,
        imageUrl: null, siteName: null, status: 'blocked', fetchedAt: new Date() };
    }
    const ip = await dnsResolve(url.hostname);
    if (!ip) {
      return { url: normalized, title: null, description: null,
        imageUrl: null, siteName: null, status: 'failed', fetchedAt: new Date() };
    }
    if (isPrivateIp(ip)) {
      return { url: normalized, title: null, description: null,
        imageUrl: null, siteName: null, status: 'blocked', fetchedAt: new Date() };
    }
    const html = await fetchHtml(normalized, 0);
    if (!html) {
      return { url: normalized, title: null, description: null,
        imageUrl: null, siteName: null, status: 'failed', fetchedAt: new Date() };
    }
    return parseHtml(html, normalized);
  } catch {
    return { url: normalized, title: null, description: null,
      imageUrl: null, siteName: null, status: 'failed', fetchedAt: new Date() };
  }
}

function dnsResolve(hostname: string): Promise<string | null> {
  return new Promise((resolve) => {
    const resolver = new (require('dns').Resolver)();
    resolver.resolve4(hostname, (err: Error | null, addresses: string[]) => {
      if (err || !addresses || addresses.length === 0) {
        resolver.resolve6(hostname, (err6: Error | null, addresses6: string[]) => {
          if (err6 || !addresses6 || addresses6.length === 0) {
            resolve(null);
          } else {
            const firstIp = addresses6[0];
            if (firstIp) resolve(firstIp);
            else resolve(null);
          }
        });
      } else {
        const firstIp = addresses[0];
        if (firstIp) resolve(firstIp);
        else resolve(null);
      }
    });
  });
}

const MAX_BODY_SIZE = 512 * 1024;
const TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 3;

async function checkSsrfForUrl(urlString: string): Promise<boolean> {
  try {
    const url = new URL(urlString);
    if (isBlockedHost(url.hostname)) return false;
    const ip = await dnsResolve(url.hostname);
    if (!ip) return true;
    return !isPrivateIp(ip);
  } catch {
    return false;
  }
}

async function fetchHtml(urlString: string, redirectCount: number): Promise<string | null> {
  if (redirectCount > MAX_REDIRECTS) return Promise.resolve(null);
  const isSafe = await checkSsrfForUrl(urlString);
  if (!isSafe) return null;
  return new Promise((resolve) => {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(urlString);
    } catch {
      resolve(null);
      return;
    }
    const protocol = parsedUrl.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: { 'User-Agent': 'murmur-link-preview' },
    };
    const req = protocol.request(options, (res) => {
      if (!res || !res.statusCode || res.statusCode < 200 || res.statusCode >= 400) {
        resolve(null);
        return;
      }
      const location = res.headers.location;
      if (location) {
        try {
          const newUrl = new URL(location, urlString).toString();
          if (newUrl !== urlString) {
            fetchHtml(newUrl, redirectCount + 1).then(resolve).catch(() => resolve(null));
            return;
          }
        } catch {
          resolve(null);
          return;
        }
      }
      let body = '';
      res.on('data', (chunk: Buffer) => {
        if (body.length + chunk.length > MAX_BODY_SIZE) {
          body = body.slice(0, MAX_BODY_SIZE);
          res.destroy();
        } else {
          body += chunk.toString();
        }
      });
      res.on('end', () => resolve(body));
      res.on('error', () => resolve(null));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.setTimeout(TIMEOUT_MS);
    req.end();
  });
}

function parseHtml(html: string, url: string): LinkPreview {
  const title = extractOgTitle(html) || extractTitleTag(html);
  const description = extractOgDescription(html) || extractMetaDescription(html);
  const siteName = extractOgSiteName(html);
  const imageUrl = extractOgImage(html);
  return {
    url,
    title: truncate(title, 200),
    description: truncate(description, 200),
    imageUrl,
    siteName: truncate(siteName, 200),
    status: 'ok',
    fetchedAt: new Date(),
  };
}

function extractOgTitle(html: string): string | null {
  const match = html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i);
  if (match && match[1]) return decodeHtmlEntity(match[1]);
  const match2 = html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
  return (match2 && match2[1]) ? decodeHtmlEntity(match2[1]) : null;
}

function extractTitleTag(html: string): string | null {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return (match && match[1]) ? decodeHtmlEntity(match[1]) : null;
}

function extractOgDescription(html: string): string | null {
  const match = html.match(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']+)["']/i);
  if (match && match[1]) return decodeHtmlEntity(match[1]);
  const match2 = html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:description["']/i);
  return (match2 && match2[1]) ? decodeHtmlEntity(match2[1]) : null;
}

function extractMetaDescription(html: string): string | null {
  const match = html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["']/i);
  if (match && match[1]) return decodeHtmlEntity(match[1]);
  const match2 = html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*name=["']description["']/i);
  return (match2 && match2[1]) ? decodeHtmlEntity(match2[1]) : null;
}

function extractOgSiteName(html: string): string | null {
  const match = html.match(/<meta[^>]+property=["']og:site_name["'][^>]*content=["']([^"']+)["']/i);
  if (match && match[1]) return decodeHtmlEntity(match[1]);
  const match2 = html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:site_name["']/i);
  return (match2 && match2[1]) ? decodeHtmlEntity(match2[1]) : null;
}

function extractOgImage(html: string): string | null {
  const match = html.match(/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i);
  if (match && match[1]) return decodeHtmlEntity(match[1]);
  const match2 = html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
  return (match2 && match2[1]) ? decodeHtmlEntity(match2[1]) : null;
}

function decodeHtmlEntity(str: string): string {
  return str.replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ');
}

function truncate(str: string | null, max: number): string | null {
  if (!str) return null;
  return str.length > max ? str.slice(0, max) : str;
}