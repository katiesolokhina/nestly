require('dotenv').config({ quiet: true });
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const { MongoStore } = require('connect-mongo');
const path = require('path');
const { connectDB } = require('./config/db');
const { ensureMemberships } = require('./lib/members');
const { sameOrigin } = require('./middleware/auth');
const { configurePush } = require('./lib/push');
const { startNotifications } = require('./lib/notify');

if (!process.env.SESSION_SECRET) {
  console.error('SESSION_SECRET is not set');
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3003;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);

app.use(helmet({ referrerPolicy: { policy: 'same-origin' } }));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(
  session({
    name: 'nestly.sid',
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true, // every visit pushes expiry out another 30 days
    store: MongoStore.create({ mongoUrl: process.env.MONGODB_URI, ttl: 60 * 60 * 24 * 30 }),
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: 'auto', // HTTPS-only over HTTPS (behind Nginx); still works on http://localhost
      maxAge: 1000 * 60 * 60 * 24 * 30,
    },
  })
);

app.use((req, res, next) => { res.locals.theme = ''; next(); });
app.use(sameOrigin);

app.get('/health', (req, res) => res.json({ ok: true }));
app.use(require('./routes/auth'));
app.use(require('./routes/push'));
app.use(require('./routes/households'));
app.use(require('./routes/access'));
app.use(require('./routes/ingredients')); // before Shopping, whose /s/shopping/:id would catch it
app.use(require('./routes/saved-items'));
app.use(require('./routes/shopping'));
app.use(require('./routes/remember'));
app.use(require('./routes/calendar'));
app.use(require('./routes/recipes'));
app.use(require('./routes/meals'));
app.use(require('./routes/bills'));
app.use(require('./routes/pantry'));
app.use(require('./routes/info'));
app.use(require('./routes/lists'));
app.use(require('./routes/section-settings').router);
app.use(require('./routes/files'));
app.use(require('./routes/home'));
app.use(require('./routes/settings'));
app.use(require('./routes/family'));
app.use(require('./routes/roles'));

app.use((req, res) => res.status(404).send('Not found'));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Something went wrong.');
});

connectDB(process.env.MONGODB_URI)
  .then(async () => {
    // Accounts from before households could be shared get their membership (once).
    const moved = await ensureMemberships();
    if (moved) console.log(`Set up household memberships for ${moved} ${moved === 1 ? 'account' : 'accounts'}.`);
  })
  .then(() => {
    app.listen(PORT, () => console.log(`Nestly on http://localhost:${PORT}`));
    if (configurePush()) startNotifications();
  })
  .catch((err) => {
    console.error('Startup failed:', err.message);
    process.exit(1);
  });
