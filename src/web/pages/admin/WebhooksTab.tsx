// Mail flow → Webhooks: notify Discord or any HTTPS endpoint when mail arrives.
import { useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AtSign, CornerDownLeft, Globe, ImageUp, Plus, RotateCcw, Send, Trash, Webhook, X } from 'lucide-react';
import { del, get, post, put } from '../../lib/api';
import { timeAgo } from '../../lib/format';
import { useAction } from '../../lib/hooks';
import type { MailboxAdmin } from '../../lib/types';
import { cn } from '../../lib/utils';
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
  username: string;
  avatarUrl: string | null;
  avatarImage: string | null;
  avatarResolved?: string | null;
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

const BLANK: Hook = { name: '', type: 'discord', url: '', addresses: [], events: ['received'], fields: ['to', 'from', 'subject'], enabled: true, username: '', avatarUrl: null, avatarImage: null };
const CLOUDFLARE_AVATAR = 'https://www.google.com/s2/favicons?domain=cloudflare.com&sz=256';
const AVATAR_SIZE = 256;

// Center-crops and scales any image to a 256×256 PNG data URL, small enough to store in D1.
async function toAvatar(file: Blob): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('That is not an image.');
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = AVATAR_SIZE;
  canvas.getContext('2d')!.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
  bitmap.close();
  return canvas.toDataURL('image/png');
}

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
              {h.type === 'discord' && <img src={h.avatarImage || h.avatarUrl || CLOUDFLARE_AVATAR} alt="" className="h-8 w-8 shrink-0 rounded-full bg-surface-2 object-cover" />}
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
  const { run, busy } = useAction();
  const boxes = useQuery({ queryKey: ['admin', 'mailboxes'], queryFn: () => get<MailboxAdmin[]>('/admin/mailboxes') });
  const known = [...new Set((boxes.data ?? []).flatMap((b) => [b.address, ...b.aliases.map((a) => a.address)]))].sort();
  const domains = [...new Set(known.map((a) => `@${a.split('@')[1]}`))].sort();

  const payload = () => ({
    name: h.name,
    type: h.type,
    url: h.url,
    addresses: h.addresses,
    events: h.events,
    fields: h.fields,
    enabled: h.enabled,
    username: h.username,
    avatarUrl: h.avatarImage ? null : h.avatarUrl || null,
    avatarImage: h.avatarImage,
  });
  const fileInput = useRef<HTMLInputElement>(null);
  const [imageError, setImageError] = useState('');
  const takeImage = async (file: Blob | null | undefined) => {
    if (!file) return;
    setImageError('');
    try {
      const avatarImage = await toAvatar(file);
      setH((cur) => ({ ...cur, avatarImage, avatarUrl: null }));
    } catch (e) {
      setImageError(e instanceof Error ? e.message : 'Could not read that image.');
    }
  };
  const onPaste = (e: ClipboardEvent) => {
    const file = [...e.clipboardData.items].find((i) => i.type.startsWith('image/'))?.getAsFile();
    if (file) {
      e.preventDefault();
      void takeImage(file);
    }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    void takeImage(e.dataTransfer.files[0]);
  };
  const imageUnsaved = !!h.avatarImage && h.avatarImage !== hook.avatarImage;
  const toggle = <T,>(list: T[], v: T, on: boolean) => (on ? [...new Set([...list, v])] : list.filter((x) => x !== v));
  const addAddress = (raw: string) => {
    const v = raw.trim().toLowerCase();
    if (v) setH((cur) => ({ ...cur, addresses: [...new Set([...cur.addresses, v])] }));
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

        {h.type === 'discord' && (
          <div className="space-y-3 rounded-lg border border-border p-4" onPaste={onPaste} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
            <div className="text-[13px] font-medium">How it appears in Discord</div>
            <div className="flex items-start gap-4">
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                className="group relative h-16 w-16 shrink-0 overflow-hidden rounded-full border border-dashed border-border bg-surface-2 outline-none focus-visible:ring-2 focus-visible:ring-primary"
                aria-label="Change the image"
                title="Click, paste or drop an image"
              >
                <img src={h.avatarImage || h.avatarUrl || CLOUDFLARE_AVATAR} alt="" className="h-full w-full object-cover" onError={() => setImageError('This URL does not load as an image.')} />
                <span className="absolute inset-0 grid place-items-center bg-black/45 text-white opacity-0 transition-opacity group-hover:opacity-100">
                  <ImageUp className="h-5 w-5" />
                </span>
              </button>
              <div className="min-w-0 flex-1 space-y-2.5">
                <Field label="Name">
                  <Input value={h.username} onChange={(e) => setH({ ...h, username: e.target.value })} placeholder="Cloudflare" maxLength={80} />
                </Field>
                <Field label="Image" hint="Paste an image here (Ctrl/Cmd+V), drop one, click the picture to upload, or give a URL.">
                  <div className="flex gap-2">
                    <Input
                      value={h.avatarImage ? '' : (h.avatarUrl ?? '')}
                      onChange={(e) => {
                        setImageError('');
                        setH({ ...h, avatarImage: null, avatarUrl: e.target.value.trim() || null });
                      }}
                      placeholder={h.avatarImage ? 'Uploaded image' : 'https://…/logo.png'}
                    />
                    {(h.avatarImage || h.avatarUrl) && (
                      <Button variant="ghost" icon={<RotateCcw className="h-4 w-4" />} onClick={() => setH({ ...h, avatarImage: null, avatarUrl: null })}>
                        Default
                      </Button>
                    )}
                  </div>
                </Field>
                {imageError && <div className="text-xs text-danger">{imageError}</div>}
                {imageUnsaved && <div className="text-xs text-muted">Save the webhook so Discord can load this image; until then a test uses the default logo.</div>}
              </div>
              <input ref={fileInput} type="file" accept="image/*" className="hidden" onChange={(e) => void takeImage(e.target.files?.[0])} />
            </div>
          </div>
        )}

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
          <AddressPicker known={known} domains={domains} chosen={h.addresses} onAdd={addAddress} />
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

// Text field with suggestions: whole domains first, then known addresses. Free text is accepted
// too, for catch-all addresses that no inbox lists.
function AddressPicker({ known, domains, chosen, onAdd }: { known: string[]; domains: string[]; chosen: string[]; onAdd: (v: string) => void }) {
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const q = draft.trim().toLowerCase();
  const pick = (list: string[]) => list.filter((a) => !chosen.includes(a) && (!q || a.includes(q)));
  const options = [...pick(domains).map((value) => ({ value, domain: true })), ...pick(known).map((value) => ({ value, domain: false }))];
  const valid = /^[^\s@]*@[^\s@]+\.[^\s@]+$/.test(q);
  const commit = (v: string) => {
    onAdd(v);
    setDraft('');
    setActive(0);
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setOpen(true);
      if (options.length) setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length);
    } else if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab') {
      const choice = open && options[active] ? options[active].value : valid ? q : null;
      if (choice) {
        e.preventDefault();
        commit(choice);
      } else if (e.key !== 'Tab') e.preventDefault();
    } else if (e.key === 'Escape') setOpen(false);
  };
  const row = (o: { value: string; domain: boolean }, i: number) => (
    <button
      key={o.value}
      type="button"
      role="option"
      aria-selected={i === active}
      onMouseDown={(e) => {
        e.preventDefault();
        commit(o.value);
      }}
      onMouseEnter={() => setActive(i)}
      className={cn('flex h-9 w-full items-center gap-2.5 rounded-[7px] px-2 text-left text-[13px]', i === active && 'bg-surface-2')}
    >
      {o.domain ? <Globe className="h-[15px] w-[15px] shrink-0 text-faint" /> : <AtSign className="h-[15px] w-[15px] shrink-0 text-faint" />}
      <span className="min-w-0 flex-1 truncate">{o.value}</span>
      {o.domain && <span className="shrink-0 text-xs text-faint">every address</span>}
      {i === active && <CornerDownLeft className="h-[13px] w-[13px] shrink-0 text-faint" />}
    </button>
  );
  const nDomains = options.filter((o) => o.domain).length;
  return (
    <div className="relative flex gap-2">
      <Input
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        placeholder="contact@example.com or @example.com"
        role="combobox"
        aria-expanded={open && options.length > 0}
        aria-autocomplete="list"
      />
      <Button variant="ghost" onClick={() => valid && commit(q)} disabled={!valid}>
        Add
      </Button>
      {open && options.length > 0 && (
        <div role="listbox" className="scroll-thin absolute top-full left-0 z-30 mt-1 max-h-72 w-full max-w-[420px] overflow-y-auto rounded-[10px] border border-border bg-surface p-[5px] shadow-pop animate-fade-in">
          {nDomains > 0 && <div className="px-2 pt-1 pb-1 text-[11.5px] font-medium text-faint">Domains</div>}
          {options.slice(0, nDomains).map((o, i) => row(o, i))}
          {options.length > nDomains && <div className={cn('px-2 pb-1 text-[11.5px] font-medium text-faint', nDomains > 0 ? 'mt-1 border-t border-border pt-2' : 'pt-1')}>Addresses</div>}
          {options.slice(nDomains).map((o, i) => row(o, i + nDomains))}
        </div>
      )}
    </div>
  );
}
