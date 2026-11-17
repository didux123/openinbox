// Outgoing notification webhooks: one POST per matching hook when mail arrives. Runs in
// ctx.waitUntil after the message is stored, so a slow or broken endpoint never delays or
// blocks delivery. Each attempt records its outcome on the hook for the settings page.
import type { Env } from '../env';
import type { Address } from '../mail/address';
import { all, run } from '../db/db';
import { parseJson } from '../lib/json';
import { logError } from '../lib/log';
import type { NOTIFY_EVENTS, NOTIFY_FIELDS } from '../../shared/schemas';

export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];
export type NotifyField = (typeof NOTIFY_FIELDS)[number];

export interface NotifyHook {
  id: number;
  type: 'discord' | 'json';
  url: string;
  addresses: string[];
  events: NotifyEvent[];
  fields: NotifyField[];
  username?: string;
  avatar?: string; // resolved public URL
}

export interface NotifyMessage {
  event: NotifyEvent;
  mailbox: string;
  to: string;
  from: Address;
  subject: string;
  snippet: string;
  date: number;
  link: string | null;
}

export const CLOUDFLARE_AVATAR = 'https://www.google.com/s2/favicons?domain=cloudflare.com&sz=256';
const TIMEOUT_MS = 8000;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const sender = (a: Address) => (a.name ? `${a.name} <${a.address}>` : a.address) || '(unknown)';

// `to` is every form the recipient can take (as sent, and without its +tag). A hook entry is
// either a full address or "@domain", which matches every address on that domain.
export function matches(hook: NotifyHook, event: NotifyEvent, to: string[]): boolean {
  if (!hook.events.includes(event)) return false;
  if (hook.addresses.length === 0) return true;
  const forms = to.map((a) => a.toLowerCase());
  return hook.addresses.some((entry) => (entry.startsWith('@') ? forms.some((a) => a.endsWith(entry)) : forms.includes(entry)));
}

export function discordPayload(hook: NotifyHook, m: NotifyMessage) {
  const f = new Set(hook.fields);
  const fields: { name: string; value: string; inline?: boolean }[] = [];
  if (f.has('to')) fields.push({ name: 'To', value: clip(m.to, 1024) });
  if (f.has('from')) fields.push({ name: 'From', value: clip(sender(m.from), 1024) });
  if (f.has('subject')) fields.push({ name: 'Subject', value: clip(m.subject || '(no subject)', 1024) });
  if (f.has('snippet') && m.snippet) fields.push({ name: 'Preview', value: clip(m.snippet, 1024) });
  if (f.has('date')) fields.push({ name: 'Received', value: `<t:${Math.floor(m.date / 1000)}:f>` });
  return {
    username: hook.username || 'Cloudflare',
    avatar_url: hook.avatar || CLOUDFLARE_AVATAR,
    allowed_mentions: { parse: [] },
    embeds: [
      {
        color: m.event === 'spam' ? 0x8a8a8a : 0xf38020,
        ...(m.event === 'spam' ? { title: 'Spam' } : {}),
        ...(f.has('link') && m.link ? { url: m.link, title: m.event === 'spam' ? 'Spam · open' : 'Open in OpenInbox' } : {}),
        fields,
      },
    ],
  };
}

export function jsonPayload(hook: NotifyHook, m: NotifyMessage) {
  const f = new Set(hook.fields);
  return {
    event: m.event,
    mailbox: m.mailbox,
    ...(f.has('to') ? { to: m.to } : {}),
    ...(f.has('from') ? { from: m.from } : {}),
    ...(f.has('subject') ? { subject: m.subject } : {}),
    ...(f.has('snippet') ? { snippet: m.snippet } : {}),
    ...(f.has('date') ? { receivedAt: new Date(m.date).toISOString() } : {}),
    ...(f.has('link') && m.link ? { link: m.link } : {}),
  };
}

// Sends one notification and returns the error text, or null on success. Never throws.
export async function sendHook(hook: NotifyHook, m: NotifyMessage): Promise<string | null> {
  try {
    const res = await fetch(hook.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'OpenInbox-Webhook' },
      body: JSON.stringify(hook.type === 'discord' ? discordPayload(hook, m) : jsonPayload(hook, m)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) return null;
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    return `HTTP ${res.status}${detail ? `: ${detail}` : ''}`;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export async function recordResult(db: D1Database, id: number, error: string | null): Promise<void> {
  await run(db, 'UPDATE notify_webhooks SET last_status = ?, last_error = ?, last_at = ? WHERE id = ?', error ? 'error' : 'ok', error, Date.now(), id);
}

export interface HookRow {
  id: number;
  type: 'discord' | 'json';
  url: string;
  addresses: string;
  events: string;
  fields: string;
  username: string;
  avatar_url: string | null;
  avatar_hash: string | null;
  public_origin: string | null;
}

export const HOOK_COLUMNS = 'id, type, url, addresses, events, fields, username, avatar_url, avatar_hash, public_origin';

// Public path of an uploaded avatar. The hash changes with the image, so Discord's cache never
// shows a stale one.
export const avatarPath = (id: number, hash: string) => `/api/webhooks/avatar/${id}/${hash}`;

export function avatarFor(r: Pick<HookRow, 'id' | 'avatar_url' | 'avatar_hash' | 'public_origin'>, appUrl: string | null): string | undefined {
  const origin = (appUrl || r.public_origin || '').replace(/\/+$/, '');
  if (r.avatar_hash && origin) return origin + avatarPath(r.id, r.avatar_hash);
  return r.avatar_url || undefined;
}

export function rowToHook(r: HookRow, appUrl: string | null = null): NotifyHook {
  return {
    id: r.id,
    type: r.type,
    url: r.url,
    addresses: parseJson<string[]>(r.addresses, []),
    events: parseJson<NotifyEvent[]>(r.events, ['received']),
    fields: parseJson<NotifyField[]>(r.fields, ['to', 'from', 'subject']),
    username: r.username,
    avatar: avatarFor(r, appUrl),
  };
}

export async function imageHash(dataUrl: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(dataUrl));
  return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function decodeDataUrl(dataUrl: string): { type: string; bytes: Uint8Array<ArrayBuffer> } | null {
  const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/.exec(dataUrl);
  if (!m) return null;
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { type: m[1], bytes };
}

// Called once per stored inbound message.
export async function notifyWebhooks(env: Env, appUrl: string | null, matchAddresses: string[], m: NotifyMessage): Promise<void> {
  try {
    const rows = await all<HookRow>(env.DB, `SELECT ${HOOK_COLUMNS} FROM notify_webhooks WHERE enabled = 1`);
    const hooks = rows.map((r) => rowToHook(r, appUrl)).filter((h) => matches(h, m.event, matchAddresses));
    await Promise.all(
      hooks.map(async (h) => {
        const error = await sendHook(h, m);
        if (error) logError('notify_webhook.failed', new Error(error), { hook: h.id });
        await recordResult(env.DB, h.id, error);
      }),
    );
  } catch (e) {
    logError('notify_webhook.dispatch_failed', e, { mailbox: m.mailbox });
  }
}
