-- Custom sender name and avatar for Discord notification webhooks. An uploaded image is kept here
-- (as a small data URL) and served publicly by the Worker, since Discord fetches avatars by URL.
ALTER TABLE notify_webhooks ADD COLUMN username TEXT NOT NULL DEFAULT '';
ALTER TABLE notify_webhooks ADD COLUMN avatar_url TEXT;
ALTER TABLE notify_webhooks ADD COLUMN avatar_image TEXT;
ALTER TABLE notify_webhooks ADD COLUMN avatar_hash TEXT;
-- Origin the admin used when saving, so uploaded avatars resolve even without Settings → App URL.
ALTER TABLE notify_webhooks ADD COLUMN public_origin TEXT;
