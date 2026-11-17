import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useFakeApis } from '../helpers/fake';
import { Client, deliver, email, setupInstance } from '../helpers/client';

describe('notification webhooks', () => {
  let admin: Client;
  let sent: { url: string; body: Record<string, unknown> }[];
  let failing: boolean;

  beforeEach(async () => {
    useFakeApis();
    const fallback = vi.mocked(globalThis.fetch).getMockImplementation()!;
    sent = [];
    failing = false;
    vi.mocked(globalThis.fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      if (req.url.startsWith('https://hooks.test/')) {
        sent.push({ url: req.url, body: await req.json() });
        return new Response(failing ? 'nope' : null, { status: failing ? 500 : 204 });
      }
      return fallback(input, init);
    });
    admin = new Client();
    await setupInstance(admin);
  });

  it('notifies matching hooks with only the chosen fields', async () => {
    await admin.post('/api/admin/notify-webhooks', { name: 'All', type: 'discord', url: 'https://hooks.test/all', fields: ['to', 'from', 'subject'] });
    await admin.post('/api/admin/notify-webhooks', { name: 'Other', type: 'json', url: 'https://hooks.test/other', addresses: ['someone@else.test'] });
    await admin.post('/api/admin/notify-webhooks', { name: 'Domain', type: 'json', url: 'https://hooks.test/domain', addresses: ['@example.com'], fields: ['subject'] });

    await deliver(email({ subject: 'Hello there', from: 'Ann <ann@sender.test>' }), { from: 'ann@sender.test', to: 'admin@example.com' });

    expect(sent.map((s) => s.url).sort()).toEqual(['https://hooks.test/all', 'https://hooks.test/domain']);
    const discord = sent.find((s) => s.url.endsWith('/all'))!.body as { username: string; avatar_url: string; embeds: { fields: { name: string; value: string }[] }[] };
    expect(discord.username).toBe('Cloudflare');
    expect(discord.avatar_url).toContain('cloudflare');
    expect(discord.embeds[0].fields.map((f) => f.name)).toEqual(['To', 'From', 'Subject']);
    expect(discord.embeds[0].fields[1].value).toContain('ann@sender.test');
    expect(sent.find((s) => s.url.endsWith('/domain'))!.body).toEqual({ event: 'received', mailbox: 'admin@example.com', subject: 'Hello there' });

    const hooks = await admin.get('/api/admin/notify-webhooks');
    expect(hooks.find((h: { name: string }) => h.name === 'All').lastStatus).toBe('ok');
  });

  it('skips disabled hooks, records failures and rejects non-https URLs', async () => {
    const { id } = await admin.post('/api/admin/notify-webhooks', { type: 'json', url: 'https://hooks.test/a' });
    failing = true;
    await deliver(email({ subject: 'One' }), { from: 'ann@sender.test', to: 'admin@example.com' });
    let [hook] = await admin.get('/api/admin/notify-webhooks');
    expect(hook).toMatchObject({ lastStatus: 'error' });
    expect(hook.lastError).toContain('500');

    await admin.put(`/api/admin/notify-webhooks/${id}`, { ...hook, enabled: false });
    sent = [];
    await deliver(email({ subject: 'Two' }), { from: 'ann@sender.test', to: 'admin@example.com' });
    expect(sent).toHaveLength(0);

    const bad = await admin.request('POST', '/api/admin/notify-webhooks', { type: 'json', url: 'http://hooks.test/plain' });
    expect(bad.status).toBe(400);
    [hook] = await admin.get('/api/admin/notify-webhooks');
    expect(hook.enabled).toBe(false);
  });

  it('sends a test notification', async () => {
    const r = await admin.post('/api/admin/notify-webhooks/test', { type: 'discord', url: 'https://hooks.test/t' });
    expect(r).toEqual({ ok: true, error: null });
    expect(sent).toHaveLength(1);
  });

  it('uses a custom name and an uploaded avatar, served publicly', async () => {
    // 1×1 PNG.
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    await admin.post('/api/admin/notify-webhooks', { type: 'discord', url: 'https://hooks.test/av', username: 'Inbox bot', avatarImage: png, avatarUrl: 'https://ignored.test/x.png' });
    const [hook] = await admin.get('/api/admin/notify-webhooks');
    expect(hook.avatarUrl).toBeNull();
    expect(hook.avatarResolved).toMatch(/\/api\/webhooks\/avatar\/\d+\/[0-9a-f]{16}$/);

    await deliver(email({ subject: 'Hi' }), { from: 'ann@sender.test', to: 'admin@example.com' });
    const body = sent[0].body as { username: string; avatar_url: string };
    expect(body.username).toBe('Inbox bot');
    expect(body.avatar_url).toBe(hook.avatarResolved);

    // Anyone can fetch it (Discord does), but only with the right hash.
    const path = new URL(hook.avatarResolved).pathname;
    const anon = new Client();
    const img = await anon.request('GET', path);
    expect(img.status).toBe(200);
    expect(img.headers.get('Content-Type')).toBe('image/png');
    expect((await anon.request('GET', path.replace(/[0-9a-f]{16}$/, '0000000000000000'))).status).toBe(404);

    // An image URL instead.
    await admin.put(`/api/admin/notify-webhooks/${hook.id}`, { ...hook, avatarImage: null, avatarUrl: 'https://cdn.test/logo.png' });
    sent = [];
    await deliver(email({ subject: 'Again' }), { from: 'ann@sender.test', to: 'admin@example.com' });
    expect((sent[0].body as { avatar_url: string }).avatar_url).toBe('https://cdn.test/logo.png');
  });
});
