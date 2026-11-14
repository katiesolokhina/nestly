# Nestly

A private, installable household app: shared shopping lists, reminders, calendar, meals, recipes, pantry, bills, and chores. Same stack as Questly: Node, Express 5, EJS, MongoDB, and a PWA, with no build step.

## Status

Built: households, sign-in, one-time invite and reset links, admin controls, section toggles, Activity with undo and restore, a customizable Today, the bottom bar, Shopping with a shared item catalog and secure uploads, Remember, Calendar, Bills (repeating, split, balances), Pantry (have/low/out, linked to Shopping), Home info (hidden fields, Wi-Fi QR, warranties), Meals, Recipes (with import from a link or pasted text), editable lists, and notifications. Chores is a placeholder until they're built.

Nestly is online-only: nothing is queued while offline.

## Run it locally

```bash
npm install
cp .env.example .env      # then fill it in
node scripts/create-household.js --household="Our home" --name=Katie --email=you@example.com
npm run dev
```

The script asks for your password, so it doesn't end up in your shell history.

## Tests

```bash
npm test
```

Tests start the real server against a throwaway database. To use a local mongod instead of the downloaded one, set `TEST_MONGODB_URI=mongodb://127.0.0.1:27017`.

## Deploy

On the VPS, using a port nothing else uses (set `PORT` in `.env`):

```bash
git clone https://github.com/katiesolokhina/nestly.git && cd nestly
npm ci --omit=dev
cp .env.example .env      # fill in production values, using a new database name and SESSION_SECRET
node scripts/create-household.js --household="Our home" --name=Katie --email=you@example.com
pm2 start server.js --name nestly && pm2 save
```

Point Nginx at the port, add a certificate for `nestly.trisolocreations.com` with Certbot, and set `client_max_body_size 11m;` so receipt uploads get through. Nginx must send `X-Forwarded-Proto`, or the session cookie won't be marked secure. `APP_ORIGIN` must exactly match the public URL.

Nightly backups use `scripts/backup.js`. Uploaded files live in `uploads/` (or `UPLOAD_DIR`), outside `public/`, and need their own backup: `tar czf` or `rsync` that folder nightly.

## Recipe import

Importing from a link makes the server fetch that page, so it only fetches http(s) on ports 80 and 443, refuses private and local addresses (checked on every connection), and limits size, time, and redirects. It reads the recipe data most sites publish (schema.org Recipe). Sites that block apps get a message suggesting pasting the text instead.

## Notifications

Reminders, events, and "someone's shopping" alerts use web push, the same as Questly. Generate a new key pair for Nestly with `npx web-push generate-vapid-keys` and put it in `.env` as `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` (a `mailto:` address). Without them, notifications stay off and everything else works.

Each person turns notifications on per device in Settings. Each event sets its own lead time; there is no default in Settings. On iPhone, that only works in the app added to the Home Screen. A check runs every minute; anything missed by more than an hour (say, during a restart) is skipped rather than sent late.

## Locked out?

If the only admin forgets their password, run this on the server. It prints a one-time link that works for 24 hours:

```bash
node scripts/reset-link.js --email=you@example.com
```
