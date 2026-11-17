-- Outgoing notification webhooks (Discord or plain JSON), configured by admins in Mail flow.
-- Not to be confused with the provider delivery webhooks in routes/webhooks.ts, which are inbound.
CREATE TABLE notify_webhooks (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL CHECK (type IN ('discord', 'json')),
  url TEXT NOT NULL,
  addresses TEXT NOT NULL DEFAULT '[]',  -- JSON: addresses or @domains to match; empty = all mail
  events TEXT NOT NULL DEFAULT '["received"]',  -- JSON: 'received' | 'spam'
  fields TEXT NOT NULL DEFAULT '["to","from","subject"]',  -- JSON: what the notification shows
  enabled INTEGER NOT NULL DEFAULT 1,
  last_status TEXT,                      -- 'ok' | 'error'
  last_error TEXT,
  last_at INTEGER,
  created_at INTEGER NOT NULL
);
