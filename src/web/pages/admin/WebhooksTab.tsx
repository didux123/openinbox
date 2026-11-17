// Mail flow → Webhooks: notify Discord or any HTTPS endpoint when mail arrives.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, Send, Trash, Webhook, X } from 'lucide-react';
import { del, get, post, put } from '../../lib/api';
import { timeAgo } from '../../lib/format';
import { useAction } from '../../lib/hooks';
import type { MailboxAdmin } from '../../lib/types';
import { Button } from '../../components/ui/button';
import { Checkbox, Field, Input, Switch, ChoiceCards } from '../../components/ui/form';
import { Card, CardHeader, EmptyState, PageSpinner, StatusPill } from '../../components/ui/misc';
import { Dialog } from '../../components/ui/overlay';

type Event = 'received' | 'spam';
type FieldKey = 'to' | 'from' | 'subject' | 'snippet' | 'date' | 'link';

interface Hook {
  id?: number;
  name: string;
  type: 'discord' | 'json';
  url: string;
  addresses: string[];
  events: Event[];
  fields: FieldKey[];
  enabled: boolean;
  lastStatus?: 'ok' | 'error' | null;
  lastError?: string | null;
  lastAt?: number | null;
}

const EVENTS: { value: Event; label: string }[] = [
  { value: 'received', label: 'New mail' },
  { value: 'spam', label: 'Spam' },
];

const FIELDS: { value: FieldKey; label: string }[] = [
  { value: 'to', label: 'Recipient' },
  { value: 'from', label: 'Sender' },
  { value: 'subject', label: 'Subject' },
  { value: 'snippet', label: 'Preview' },
  { value: 'date', label: 'Date' },
  { value: 'link', label: 'Link to the message' },
];

const BLANK: Hook = { name: '', type: 'discord', url: '', addresses: [], events: ['received'], fields: ['to', 'from', 'subject'], enabled: true };

export function WebhooksTab() {
  const q = useQuery({ queryKey: ['admin', 'notify-webhooks'], queryFn: () => get<Hook[]>('/admin/notify-webhooks') });
  const [editing, setEditing] = useState<Hook | null>(null);
  const { run } = useAction();
  if (q.isLoading) return <PageSpinner />;
  const hooks = q.data ?? [];
  const scope = (h: Hook) => (h.addresses.length ? h.addresses.join(', ') : 'All mail');
  return (
    <Card>
      <CardHeader
        icon={<Webhook className="h-5 w-5" />}
        title="Webhooks"
        description="Get a notification on Discord, or a JSON POST anywhere, when mail arrives."
        action={
          <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing({ ...BLANK })}>
            New webhook
          </Button>
        }
      />
      {hooks.length === 0 ? (
        <EmptyState icon={<Webhook />} title="No webhooks yet" action={<Button size="sm" variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing({ ...BLANK })}>New webhook</Button>}>
          Add one to be notified on Discord for every new message, or only for some addresses.
        </EmptyState>
      ) : (
        <div className="divide-y divide-border">
          {hooks.map((h) => (
            <div key={h.id} className="flex items-center gap-3 px-5 py-3">
              <Switch checked={h.enabled} label={`Enable ${h.name || 'webhook'}`} onChange={(v) => run('t', () => put(`/admin/notify-webhooks/${h.id}`, { ...h, enabled: v }).then(() => q.refetch()))} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm font-medium">
                  {h.name || (h.type === 'discord' ? 'Discord' : 'JSON webhook')}
                  {h.lastStatus === 'ok' && <StatusPill tone="success">OK</StatusPill>}
                  {h.lastStatus === 'error' && <StatusPill tone="danger">Failing</StatusPill>}
                </div>
                <div className="truncate text-xs text-muted">
                  {h.type === 'discord' ? 'Discord' : 'JSON'} · {h.events.map((e) => EVENTS.find((x) => x.value === e)?.label).join(' + ')} · {scope(h)}
                  {h.lastAt ? ` · last sent ${timeAgo(h.lastAt)}` : ''}
                </div>
                {h.lastStatus === 'error' && h.lastError && <div className="truncate text-xs text-danger">{h.lastError}</div>}
              </div>
              <Button size="xs" variant="ghost" onClick={() => setEditing(h)}>
                Edit
              </Button>
              <Button size="xs" variant="ghost" aria-label="Delete" icon={<Trash className="h-3.5 w-3.5" />} onClick={() => run('d', () => del(`/admin/notify-webhooks/${h.id}`).then(() => q.refetch()), 'Webhook deleted')} />
            </div>
          ))}
        </div>
      )}
      {editing && (
        <WebhookDialog
          hook={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            q.refetch();
          }}
        />
      )}
    </Card>
  );
}

function WebhookDialog({ hook, onClose, onSaved }: { hook: Hook; onClose: () => void; onSaved: () => void }) {
  const [h, setH] = useState<Hook>(hook);
  const [draft, setDraft] = useState('');
  const { run, busy } = useAction();
  const boxes = useQuery({ queryKey: ['admin', 'mailboxes'], queryFn: () => get<MailboxAdmin[]>('/admin/mailboxes') });
  const known = [...new Set((boxes.data ?? []).flatMap((b) => [b.address, ...b.aliases.map((a) => a.address)]))].sort();
  const domains = [...new Set(known.map((a) => `@${a.split('@')[1]}`))].sort();

  const payload = () => ({ name: h.name, type: h.type, url: h.url, addresses: h.addresses, events: h.events, fields: h.fields, enabled: h.enabled });
  const toggle = <T,>(list: T[], v: T, on: boolean) => (on ? [...new Set([...list, v])] : list.filter((x) => x !== v));
  const addAddress = (raw: string) => {
    const v = raw.trim().toLowerCase();
    if (v) setH((cur) => ({ ...cur, addresses: [...new Set([...cur.addresses, v])] }));
    setDraft('');
  };
  const save = () => run('save', () => (h.id ? put(`/admin/notify-webhooks/${h.id}`, payload()) : post('/admin/notify-webhooks', payload())).then(onSaved), 'Webhook saved');
  const test = () =>
    run('test', async () => {
      const r = await post<{ ok: boolean; error: string | null }>(`/admin/notify-webhooks/test${h.id ? `?id=${h.id}` : ''}`, payload());
      if (!r.ok) throw new Error(r.error ?? 'The test failed.');
    }, 'Test sent');

  return (
    <Dialog
      open
      onClose={onClose}
      title={h.id ? 'Edit webhook' : 'New webhook'}
      size="lg"
      footerStart={
        <Button variant="ghost" icon={<Send className="h-4 w-4" />} loading={busy === 'test'} disabled={!h.url} onClick={test}>
          Send test
        </Button>
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy === 'save'} disabled={!h.url} onClick={save}>
            Save webhook
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <ChoiceCards
          value={h.type}
          onChange={(type) => setH({ ...h, type })}
          options={[
            { value: 'discord', label: 'Discord', hint: 'A message with the Cloudflare logo in a channel.' },
            { value: 'json', label: 'JSON', hint: 'A POST with the chosen fields, for n8n, Zapier or your own code.' },
          ]}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">
            <Input value={h.name} onChange={(e) => setH({ ...h, name: e.target.value })} placeholder="Contact form alerts" />
          </Field>
          <Field label="URL" hint={h.type === 'discord' ? 'Channel settings → Integrations → Webhooks.' : 'Must start with https://.'}>
            <Input value={h.url} onChange={(e) => setH({ ...h, url: e.target.value.trim() })} placeholder={h.type === 'discord' ? 'https://discord.com/api/webhooks/…' : 'https://…'} />
          </Field>
        </div>

        <div className="space-y-3 rounded-lg border border-border p-4">
          <div className="text-[13px] font-medium">Only for mail sent to</div>
          <div className="flex flex-wrap gap-1.5">
            {h.addresses.length === 0 && <span className="text-[12.5px] text-muted">Every address (leave empty for all mail)</span>}
            {h.addresses.map((a) => (
              <span key={a} className="inline-flex h-6 items-center gap-1 rounded-full bg-primary-soft pr-1 pl-2.5 text-[12px] text-primary-text">
                {a}
                <button type="button" aria-label={`Remove ${a}`} className="grid h-4 w-4 place-items-center rounded-full hover:bg-primary/15" onClick={() => setH({ ...h, addresses: h.addresses.filter((x) => x !== a) })}>
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <Input
              list="webhook-addresses"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ',') {
                  e.preventDefault();
                  addAddress(draft);
                }
              }}
              placeholder="contact@example.com or @example.com"
            />
            <Button variant="ghost" onClick={() => addAddress(draft)} disabled={!draft.trim()}>
              Add
            </Button>
            <datalist id="webhook-addresses">
              {[...known, ...domains].map((a) => (
                <option key={a} value={a} />
              ))}
            </datalist>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-3 rounded-lg border border-border p-4">
            <div className="text-[13px] font-medium">Send when</div>
            {EVENTS.map((e) => (
              <Checkbox key={e.value} label={e.label} checked={h.events.includes(e.value)} onChange={(v) => setH({ ...h, events: toggle(h.events, e.value, v) })} />
            ))}
          </div>
          <div className="space-y-3 rounded-lg border border-border p-4">
            <div className="text-[13px] font-medium">Show</div>
            {FIELDS.map((f) => (
              <Checkbox key={f.value} label={f.label} checked={h.fields.includes(f.value)} onChange={(v) => setH({ ...h, fields: toggle(h.fields, f.value, v) })} />
            ))}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
