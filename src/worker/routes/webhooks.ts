// Provider delivery webhooks. Authenticated by signature (Resend) or a secret URL (Brevo, Mailjet);
// exempt from CSRF and sessions.
import { Hono } from 'hono';
import type { AppBindings } from '../types';
import { intParam } from '../lib/validate';
import { handleBrevoWebhook, handleMailjetWebhook, handleResendWebhook } from '../services/webhooks';
import { first } from '../db/db';
import { decodeDataUrl } from '../services/notify-webhooks';

export const webhooks = new Hono<AppBindings>();

webhooks.post('/resend/:id', async (c) => {
  await handleResendWebhook(c.env, intParam(c, 'id'), c.req.raw);
  return c.json({ ok: true });
});

webhooks.post('/brevo/:id/:token', async (c) => {
  await handleBrevoWebhook(c.env, intParam(c, 'id'), c.req.param('token'), c.req.raw);
  return c.json({ ok: true });
});

webhooks.post('/mailjet/:id/:token', async (c) => {
  await handleMailjetWebhook(c.env, intParam(c, 'id'), c.req.param('token'), c.req.raw);
  return c.json({ ok: true });
});

// Avatars of notification webhooks, fetched by Discord. Public on purpose: the hash in the path
// must match, so only images whose URL was handed to Discord can be read.
webhooks.get('/avatar/:id/:hash', async (c) => {
  const row = await first<{ avatar_image: string | null; avatar_hash: string | null }>(c.env.DB, 'SELECT avatar_image, avatar_hash FROM notify_webhooks WHERE id = ?', intParam(c, 'id'));
  const img = row?.avatar_image && row.avatar_hash === c.req.param('hash') ? decodeDataUrl(row.avatar_image) : null;
  if (!img) return c.json({ error: { code: 'not_found', message: 'No such image.' } }, 404);
  return c.body(img.bytes, 200, { 'Content-Type': img.type, 'Cache-Control': 'public, max-age=31536000, immutable' });
});
