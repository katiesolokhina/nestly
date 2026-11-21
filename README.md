# Nestly

A private, installable household app: shared shopping lists, reminders, calendar, meals, recipes, pantry, bills, and chores. Same stack as Questly: Node, Express 5, EJS, MongoDB, and a PWA, with no build step.

## Status

Built: households, sign-in, one-time invite and reset links, admin controls, section toggles, Activity with undo and restore, a customizable Today, the bottom bar, Shopping with a shared item catalog (editable under Shopping → Saved items, with staples in your own order) and secure uploads, Remember, Calendar, Bills (repeating, split, balances), Pantry (have/low/out, linked to Shopping), Home info (hidden fields, Wi-Fi QR, warranties), Chores (assigned or anyone, repeating, rooms, reminders, optional points and rewards), Meals, Recipes (with import from a link or pasted text), editable lists, and notifications.

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

### Backups

`scripts/backup.js` saves the whole database to `backups/` as one gzipped file, plus the uploaded receipts and photos (`uploads/`, or `UPLOAD_DIR`) as a `.tar.gz`, and keeps the newest 14 of each (`BACKUP_KEEP`). Run it nightly with pm2:

```bash
pm2 start scripts/backup.js --name nestly-backup --cron "30 3 * * *" --no-autorestart && pm2 save
pm2 logs nestly-backup --lines 5     # "backup ok: …"
```

Restore with `node scripts/restore.js backups/<file>.jsonl.gz` (it asks before replacing anything). Now and then, copy `backups/` off the server (for example `scp -r` to your computer), so a lost server doesn't take the backups with it.

Admins can also download their household's data as JSON from Settings → Download data.

### Morning email

Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and `MAIL_FROM` in `.env` (see `.env.example`) and each person can get a morning email of what needs them today, across all their households. By default it only goes to people with no device set up for notifications; each person changes that in Settings → Notifications, which also has a button to send a test.

### Calendar feed

Settings → Calendar feed makes a private link per person (only a hash is stored) for Google, Apple, or Outlook calendars: events, reminders, unpaid bills, and their chores, repeating the way they do in Nestly.

### Barcodes

Scanning uses the phone's built-in barcode reader where there is one (Android Chrome) and otherwise `public/js/vendor/zxing.min.js`. Products are looked up in the household's saved items first, then [Open Food Facts](https://world.openfoodfacts.org) (`OFF_URL` to change it). A code someone names is remembered on that saved item. The camera needs HTTPS (or localhost).

### Moving to another cluster

`scripts/move-cluster.js` copies every database on one cluster (Nestly, and anything else on it, like Questly) to another, with their indexes. It only reads the old cluster, refuses to copy into a database that already has data, and compares counts at the end; `--check` compares counts without copying.

### Speed

Every page sends a `Server-Timing` header (time and database calls), and requests slower than `SLOW_MS` (default 800) are logged: `pm2 logs nestly | grep Slow`. `/health?db=1` times five round trips to the database; under ~20 ms means the database and server are in the same region.

## Settings

Settings is a menu of pages, each with Back:

- **You**: account, notifications (all of them on one page), appearance, bottom bar, Today, households.
- **Household**: people and invites; sections on/off and their names.
- **Sections** (admins only): one page per section with its lists and defaults, also reachable from the gear next to each section's title.

Household settings include purchase methods, default store, the "someone's shopping" alert and how often, pantry status names, which statuses add to Shopping, the "expiring soon" window, default pantry spot, week start (Sunday or Monday), new-event notify and category, new-reminder recipients and category, default meal slot, default bill split, currency, how early repeating bills appear, and the starting fields for each Home info type.

## Roles and permissions

Admin can do everything. Other roles (Member, Teen, and Child to start) are set per household under People → Roles and permissions:

- Each section is **Hidden** (not shown, no notifications, left out of Today and Activity), **View** (look only), or **Edit**.
- Other permissions: invite people, change section settings and lists (for sections they can edit), see Activity, use "Only me".
- Admins rename, add, and delete roles (a role in use can't be deleted), choose the role an invite joins with, and change anyone's role from People → Manage. Invites never make someone an admin.

## Households

One sign-in can belong to several households. Each person's role (admin or member), whether they're turned off, their bottom bar, and their Today layout are set per household (the `memberships` collection). Notification settings and appearance belong to the person.

- **Switch** from the household name next to the logo, or Account → Households. Each device remembers its own.
- **Start** a household from Households; you're its admin.
- **Join** another household by opening its invite link while signed in.
- Notifications come from every household, titled with the household's name, and open it.
- An admin can make a password reset link only if they're an admin in all of that person's households.
- An admin can delete a household once everyone else has been removed (not your only one); it deletes all its data and files.
- `scripts/create-household.js` with an email that already has an account makes them the new household's admin.

Accounts from before this change get their membership automatically when the server starts.

## Maintenance page

While Nestly restarts (or is down), nginx can show `public/maintenance.html` instead of a gateway error. In the site's `server { … }` block:

```
error_page 502 503 504 /maintenance.html;
location = /maintenance.html { root /var/www/nestly/public; internal; }
```

Then `sudo nginx -t && sudo systemctl reload nginx`. The page checks again every 20 seconds.

## Lists

One section for everything that isn't groceries: **Places to go** (address, map, "Plan it" on the calendar, been there), **Projects**, **To watch** (movie or show, where to stream, watching, who wants to see it), **Wishlist** (others mark "I'm getting this"; the wishlist's owner never sees it, not in Activity or the download either), **Packing** (trip dates, untick all, copy for the next trip, add the trip to the calendar), **Checklist**, and **Note**. Lists can be pinned or Only me.

## Feedback

Settings → Report a bug or suggest a feature. Set `OWNER_EMAILS` in `.env` to your account email to see every household's feedback (household admins see their own). New feedback is emailed to `FEEDBACK_EMAIL` (or `OWNER_EMAILS`) when SMTP is set up.

## Cooking and planning

- **What can I cook?** (Recipes): your recipes ranked by what's in the pantry, with what expires soon first, plus recipes found online. Online search uses Spoonacular when `SPOONACULAR_KEY` is set in `.env` (free key at spoonacular.com/food-api, 50 searches a day), and TheMealDB otherwise (free, no key, smaller). Results are cached for an hour. Saving one opens it in the recipe form first.
- **Scaling**: ½×, 2×, 3× or "Serves N" on a recipe; the amounts, the "add to shopping" list and a planned meal's servings all follow.
- **Use soon** (Meals week): recipes that use what expires this week, with one tap to plan one on an open day.
- **Activity**: one week at a time. Admins can download a week, a date range, or everything as CSV, clear a date range, and set auto-clear (Settings → Activity; off by default).

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
