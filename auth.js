/**
 * auth.js — Passport.js social login (Google, GitHub, Twitter/X)
 * Session stored in SQLite via SqliteStore from db.js.
 */
'use strict';

const passport = require('passport');
const express  = require('express');
const session  = require('express-session');
const bcrypt   = require('bcrypt');

const {
  SqliteStore,
  findOrCreateUser, findUserById, findUserByEmail,
  createLocalUser, createPasswordResetToken, consumePasswordResetToken
} = require('./db');

// ── User serialization ─────────────────────────────────────────────────────────
passport.serializeUser((user, done) => done(null, user.id));

passport.deserializeUser(async (id, done) => {
  try {
    const user = await findUserById(id);
    done(null, user || null);
  } catch (e) { done(e, null); }
});

// ── Strategies ─────────────────────────────────────────────────────────────────
function setupStrategies() {
  const BASE_URL = process.env.APP_URL || 'https://intmolt.org';

  // Google
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_ID.trim()) {
    const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
    passport.use(new GoogleStrategy(
      {
        clientID:     process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL:  `${BASE_URL}/auth/google/callback`
      },
      async (_at, _rt, profile, done) => {
        try {
          const user = await findOrCreateUser({
            email:       profile.emails?.[0]?.value,
            name:        profile.displayName,
            avatar_url:  profile.photos?.[0]?.value,
            provider:    'google',
            provider_id: profile.id
          });
          done(null, user);
        } catch (e) { done(e, null); }
      }
    ));
    console.log('[auth] Google OAuth strategy registered');
  }

  // GitHub
  if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_ID.trim()) {
    const { Strategy: GitHubStrategy } = require('passport-github2');
    passport.use(new GitHubStrategy(
      {
        clientID:     process.env.GITHUB_CLIENT_ID,
        clientSecret: process.env.GITHUB_CLIENT_SECRET,
        callbackURL:  `${BASE_URL}/auth/github/callback`,
        scope: ['user:email']
      },
      async (_at, _rt, profile, done) => {
        try {
          const email = profile.emails?.find(e => e.primary)?.value
                     || profile.emails?.[0]?.value
                     || `${profile.username}@github.invalid`;
          const user = await findOrCreateUser({
            email,
            name:        profile.displayName || profile.username,
            avatar_url:  profile.photos?.[0]?.value,
            provider:    'github',
            provider_id: profile.id
          });
          done(null, user);
        } catch (e) { done(e, null); }
      }
    ));
    console.log('[auth] GitHub OAuth strategy registered');
  }

  // Twitter/X (OAuth 1.0a via passport-twitter)
  if (process.env.TWITTER_CLIENT_ID && process.env.TWITTER_CLIENT_ID.trim()) {
    const { Strategy: TwitterStrategy } = require('passport-twitter');
    passport.use(new TwitterStrategy(
      {
        consumerKey:    process.env.TWITTER_CLIENT_ID,
        consumerSecret: process.env.TWITTER_CLIENT_SECRET,
        callbackURL:    `${BASE_URL}/auth/twitter/callback`,
        includeEmail:   true
      },
      async (_token, _ts, profile, done) => {
        try {
          const email = profile.emails?.[0]?.value
                     || `${profile.username}@twitter.invalid`;
          const user = await findOrCreateUser({
            email,
            name:        profile.displayName || profile.username,
            avatar_url:  profile.photos?.[0]?.value,
            provider:    'twitter',
            provider_id: profile.id
          });
          done(null, user);
        } catch (e) { done(e, null); }
      }
    ));
    console.log('[auth] Twitter OAuth strategy registered');
  }

  // Email + password (passport-local)
  const { Strategy: LocalStrategy } = require('passport-local');
  passport.use(new LocalStrategy(
    { usernameField: 'email', passwordField: 'password' },
    async (email, password, done) => {
      try {
        const user = await findUserByEmail(email.toLowerCase().trim());
        if (!user) return done(null, false, { message: 'No account with this email.' });
        if (!user.password_hash) return done(null, false, { message: 'This account uses social login. Please sign in with Google/GitHub.' });
        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) return done(null, false, { message: 'Incorrect password.' });
        done(null, user);
      } catch (e) { done(e, null); }
    }
  ));
  console.log('[auth] Local (email+password) strategy registered');
}

// ── Session middleware ─────────────────────────────────────────────────────────
function configureSession(app) {
  app.use(session({
    store: new SqliteStore(),
    secret:            process.env.SESSION_SECRET || 'dev-secret-please-change',
    resave:            false,
    saveUninitialized: false,
    cookie: {
      secure:   process.env.NODE_ENV === 'production',
      httpOnly: true,
      maxAge:   30 * 24 * 60 * 60 * 1000  // 30 days
    }
  }));
  app.use(passport.initialize());
  app.use(passport.session());
}

// ── Auth routes ────────────────────────────────────────────────────────────────
function registerAuthRoutes(app) {
  const BASE_URL = process.env.APP_URL || 'https://intmolt.org';

  // GET /auth/me — returns current user (session auth)
  app.get('/auth/me', (req, res) => {
    if (!req.isAuthenticated || !req.isAuthenticated()) {
      return res.status(401).json({ authenticated: false });
    }
    const u = req.user;
    res.json({
      authenticated: true,
      id:         u.id,
      email:      u.email,
      name:       u.name,
      avatar_url: u.avatar_url,
      provider:   u.provider
    });
  });

  // GET /auth/logout
  app.get('/auth/logout', (req, res, next) => {
    req.logout(err => {
      if (err) return next(err);
      res.redirect('/');
    });
  });

  // Helper: redirect to ?next= after login, or /dashboard
  function afterLoginRedirect(req, res) {
    const next = req.session?.authNext;
    if (next) {
      delete req.session.authNext;
      return res.redirect(next);
    }
    res.redirect('/dashboard');
  }

  // Google
  app.get('/auth/google', (req, res, next) => {
    if (req.query.next) req.session.authNext = req.query.next;
    passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next);
  });
  app.get('/auth/google/callback',
    passport.authenticate('google', { failureRedirect: '/login' }),
    afterLoginRedirect
  );

  // GitHub
  app.get('/auth/github', (req, res, next) => {
    if (req.query.next) req.session.authNext = req.query.next;
    passport.authenticate('github', { scope: ['user:email'] })(req, res, next);
  });
  app.get('/auth/github/callback',
    passport.authenticate('github', { failureRedirect: '/login' }),
    afterLoginRedirect
  );

  // Twitter
  app.get('/auth/twitter', (req, res, next) => {
    if (req.query.next) req.session.authNext = req.query.next;
    passport.authenticate('twitter')(req, res, next);
  });
  app.get('/auth/twitter/callback',
    passport.authenticate('twitter', { failureRedirect: '/login' }),
    afterLoginRedirect
  );

  // ── Email + password routes ────────────────────────────────────────────────

  // POST /auth/register — vytvoří nový účet
  app.post('/auth/register', express.json(), async (req, res) => {
    const { email, password, name } = req.body || {};
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Zadejte platný email.' });
    }
    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'Heslo musí mít alespoň 8 znaků.' });
    }
    const existing = await findUserByEmail(email.toLowerCase().trim()).catch(() => null);
    if (existing) {
      return res.status(409).json({ error: 'Tento email je již zaregistrován.' });
    }
    const user = await createLocalUser({ email: email.toLowerCase().trim(), password, name }).catch(() => null);
    if (!user) return res.status(500).json({ error: 'Registrace selhala, zkuste to znovu.' });

    // Auto-přihlásit po registraci
    await new Promise((resolve, reject) =>
      req.login(user, err => err ? reject(err) : resolve())
    );
    res.json({ ok: true, email: user.email, name: user.name });
  });

  // POST /auth/login/local — přihlásit emailem + heslem
  app.post('/auth/login/local', express.json(), (req, res, next) => {
    passport.authenticate('local', (err, user, info) => {
      if (err) return next(err);
      if (!user) return res.status(401).json({ error: info?.message || 'Přihlášení selhalo.' });
      req.login(user, loginErr => {
        if (loginErr) return next(loginErr);
        res.json({ ok: true, email: user.email, name: user.name });
      });
    })(req, res, next);
  });

  // POST /auth/forgot — odešle reset token (vrátí token jen pokud SMTP není nakonfigurováno)
  app.post('/auth/forgot', express.json(), async (req, res) => {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Email je povinný.' });
    const user = await findUserByEmail(email.toLowerCase().trim()).catch(() => null);
    // Vždy vrátit 200 aby se neodhalilo zda email existuje
    if (!user || !user.password_hash) return res.json({ ok: true });

    const token = await createPasswordResetToken(email.toLowerCase().trim()).catch(() => null);
    if (!token) return res.json({ ok: true });

    // Pokus o odeslání emailu (pokud je SMTP nakonfigurováno)
    try {
      const nodemailer = require('nodemailer');
      const host = process.env.SMTP_HOST;
      if (host && process.env.SMTP_USER && process.env.SMTP_PASS) {
        const transporter = nodemailer.createTransport({
          host,
          port: parseInt(process.env.SMTP_PORT || '587'),
          secure: process.env.SMTP_PORT === '465',
          auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        });
        const resetUrl = `${BASE_URL}/reset-password?token=${token}`;
        await transporter.sendMail({
          from: process.env.SMTP_FROM || process.env.SMTP_USER,
          to: email,
          subject: '[integrity.molt] Reset hesla',
          html: `
            <div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#0f0f18;color:#d0d8e8;border:1px solid #1e1e2e;border-radius:10px;padding:28px">
              <h2 style="margin:0 0 16px;color:#fff">Reset hesla</h2>
              <p style="margin:0 0 20px;color:#8b95b0">Klikněte na odkaz níže pro reset hesla. Odkaz je platný 2 hodiny.</p>
              <a href="${resetUrl}" style="display:inline-block;padding:11px 22px;background:#4da6ff;color:#000;font-weight:700;border-radius:6px;text-decoration:none">
                Resetovat heslo →
              </a>
              <p style="margin:20px 0 0;font-size:12px;color:#3a3f54">Pokud jste o reset nežádali, ignorujte tento email.</p>
            </div>`
        });
      }
    } catch (e) {
      console.error('[auth] forgot password email failed:', e.message);
    }
    res.json({ ok: true });
  });

  // POST /auth/reset — nastaví nové heslo přes token
  app.post('/auth/reset', express.json(), async (req, res) => {
    const { token, password } = req.body || {};
    if (!token || !password || password.length < 8) {
      return res.status(400).json({ error: 'Neplatný token nebo příliš krátké heslo.' });
    }
    const user = await consumePasswordResetToken(token, password).catch(() => null);
    if (!user) return res.status(400).json({ error: 'Token je neplatný nebo vypršel.' });
    res.json({ ok: true, email: user.email });
  });
}

module.exports = { passport, configureSession, setupStrategies, registerAuthRoutes, findUserByEmail };
