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

const CLOUDFLARE_AVATAR = 'https://www.google.com/s2/favicons?domain=cloudflare.com&sz=256';
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
    username: 'Cloudflare',
    avatar_url: CLOUDFLARE_AVATAR,
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

interface HookRow {
  id: number;
  type: 'discord' | 'json';
  url: string;
  addresses: string;
  events: string;
  fields: string;
}

export function rowToHook(r: HookRow): NotifyHook {
  return {
    id: r.id,
    type: r.type,
    url: r.url,
    addresses: parseJson<string[]>(r.addresses, []),
    events: parseJson<NotifyEvent[]>(r.events, ['received']),
    fields: parseJson<NotifyField[]>(r.fields, ['to', 'from', 'subject']),
  };
}

// Called once per stored inbound message.
export async function notifyWebhooks(env: Env, matchAddresses: string[], m: NotifyMessage): Promise<void> {
  try {
    const rows = await all<HookRow>(env.DB, 'SELECT id, type, url, addresses, events, fields FROM notify_webhooks WHERE enabled = 1');
    const hooks = rows.map(rowToHook).filter((h) => matches(h, m.event, matchAddresses));
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
