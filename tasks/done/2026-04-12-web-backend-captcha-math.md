---
agent: web+backend
priority: P1
estimated_hours: 1
created: 2026-04-12
---

# Task: Nahradit Cloudflare Turnstile jednoduchou matematickou CAPTCHA

## Proč (business dopad)
Turnstile nefunguje — TURNSTILE_SITE_KEY/SECRET_KEY nejsou nastaveny, widget se
nezobrazuje, uživatelé mohou skenovat bez jakékoli ochrany. Jednoduchá matematická
CAPTCHA je viditelná, nevyžaduje žádné API klíče a funguje okamžitě.

## Architektura řešení

### Tok
1. Při načtení stránky: `GET /scan/captcha-challenge` → server vygeneruje otázku
   (např. "3 + 7") a podepíše HMAC(correct_answer + timestamp, CAPTCHA_SECRET)
   → vrátí `{ question: "3 + 7", token: "<hmac>" }`
2. Frontend zobrazí otázku, uživatel zadá číslo do inputu
3. `POST /scan/free` pošle `captcha_token` + `captcha_answer`
4. Server ověří HMAC a správnost odpovědi → pokud chyba → 403

### Platnost tokenu
Token obsahuje timestamp, platí 15 minut. Po vypršení nebo špatné odpovědi
frontend automaticky načte nový challenge.

---

## BACKEND agent: server.js

### Co odstranit
- Endpoint `GET /scan/captcha-config` (celý blok řádky ~2803–2806)
- Funkci `verifyTurnstile()` (řádky ~2822–2838)

### Co přidat

**Nový endpoint** `GET /scan/captcha-challenge`:
```js
// Generuje matematickou CAPTCHA challenge
const crypto = require('crypto');
const CAPTCHA_SECRET = process.env.CAPTCHA_SECRET || 'changeme-local-dev';
const CAPTCHA_TTL_MS = 15 * 60 * 1000; // 15 minut

app.get('/scan/captcha-challenge', (req, res) => {
  const a = Math.floor(Math.random() * 10) + 1;  // 1–10
  const b = Math.floor(Math.random() * 10) + 1;  // 1–10
  const answer = String(a + b);
  const ts = Date.now();
  const token = crypto
    .createHmac('sha256', CAPTCHA_SECRET)
    .update(`${answer}:${ts}`)
    .digest('hex') + ':' + ts;
  res.json({ question: `${a} + ${b}`, token });
});
```

**Nová funkce** `verifyCaptcha(token, answer)`:
```js
function verifyCaptcha(token, answer) {
  if (!token || !answer) return false;
  const parts = token.split(':');
  if (parts.length !== 2) return false;
  const [hmac, ts] = parts;
  if (Date.now() - Number(ts) > CAPTCHA_TTL_MS) return false;
  const expected = crypto
    .createHmac('sha256', CAPTCHA_SECRET)
    .update(`${answer.trim()}:${ts}`)
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(hmac, 'hex'), Buffer.from(expected, 'hex'));
}
```

**V `POST /scan/free`** — nahradit Turnstile logiku:
```js
// místo: const cfToken = (req.body?.cf_token || '').trim();
const captchaToken  = (req.body?.captcha_token  || '').trim();
const captchaAnswer = (req.body?.captcha_answer || '').trim();

// místo: const turnstileOk = isInternalA2A || await verifyTurnstile(cfToken, req.ip);
const captchaOk = isInternalA2A || verifyCaptcha(captchaToken, captchaAnswer);
if (!captchaOk) {
  return res.status(403).json({ error: 'CAPTCHA verification failed', captcha_required: true });
}
```

---

## WEB agent: public/scan.html

### Co odstranit
- `<script src="https://challenges.cloudflare.com/turnstile/...">` (řádek ~28)
- CSS blok `.cf-turnstile { ... }` (řádek ~754–755)
- `<div id="turnstileWrap">` s `cf-turnstile` uvnitř (řádky ~913–915)
- Proměnnou `let turnstileToken = null;` (řádek ~992)
- Funkce `onTurnstileSuccess()`, `onTurnstileExpired()` (řádky ~1047–1048)
- Funkci `initTurnstile()` (řádky ~1125–1139)
- Volání `initTurnstile()` v DOMContentLoaded (řádek ~1053)

### Co přidat

**CSS** (za existující styly, před `</style>`):
```css
/* ── Math CAPTCHA ── */
.captcha-wrap {
  margin: 16px 0;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.captcha-question {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
  background: var(--card-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 14px;
  white-space: nowrap;
}
.captcha-eq { color: var(--text-faint); font-size: 15px; }
.captcha-input {
  width: 70px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--input-bg, var(--card-bg));
  color: var(--text);
  font-size: 15px;
  text-align: center;
}
.captcha-input:focus { outline: 2px solid var(--green); border-color: transparent; }
.captcha-refresh {
  background: none; border: none; color: var(--text-faint);
  cursor: pointer; font-size: 18px; padding: 4px;
  transition: color 0.2s;
}
.captcha-refresh:hover { color: var(--green); }
```

**HTML** (místo `turnstileWrap` divu):
```html
<!-- Math CAPTCHA -->
<div class="captcha-wrap" id="captchaWrap">
  <span class="captcha-question" id="captchaQuestion">…</span>
  <span class="captcha-eq">= ?</span>
  <input class="captcha-input" id="captchaInput" type="number" min="0" max="30"
         placeholder="?" autocomplete="off">
  <button class="captcha-refresh" id="captchaRefresh" title="New question" onclick="loadCaptcha()">↻</button>
</div>
```

**JS proměnné** (místo `turnstileToken`):
```js
let captchaToken = null;
```

**JS funkce** (místo `initTurnstile` + callbacks):
```js
async function loadCaptcha() {
  try {
    document.getElementById('captchaInput').value = '';
    const r = await fetch('/scan/captcha-challenge');
    if (!r.ok) return;
    const { question, token } = await r.json();
    document.getElementById('captchaQuestion').textContent = question;
    captchaToken = token;
  } catch {}
}
```

**V DOMContentLoaded** — nahradit `initTurnstile()` za `loadCaptcha()`

**V `startScan()`** — nahradit `cf_token`:
```js
// přidat validaci před odesláním:
const captchaAnswer = (document.getElementById('captchaInput')?.value || '').trim();
if (!captchaAnswer) {
  showError('Please solve the math problem first.');
  return;
}
// v body:
const body = { address, type, captcha_token: captchaToken || '', captcha_answer: captchaAnswer };
```

**Po 403 captcha_required** — přidat reload captchy:
```js
if (json.captcha_required) {
  loadCaptcha();
  showError('CAPTCHA expired or incorrect — please try again.');
  return;
}
```

---

## Soubory v scope
- `server.js` (backend agent)
- `public/scan.html` (web agent)

## Acceptance criteria
- [ ] Matematická otázka (X + Y) viditelná na scan stránce bez jakýchkoli API klíčů
- [ ] Správná odpověď → scan proběhne
- [ ] Špatná odpověď → 403, nová otázka se načte
- [ ] Token starší 15 minut → 403
- [ ] Interní A2A volání (x-a2a-caller: 1 + 127.0.0.1) → přeskočí CAPTCHA
- [ ] Cloudflare Turnstile SDK se nenačítá (žádný request na challenges.cloudflare.com)

## Test příkazy
bash scripts/test-gate.sh

## Poznámky
- CAPTCHA_SECRET lze přidat do .env (volitelné — default 'changeme-local-dev' funguje lokálně)
- Po nasazení doporučeno přidat CAPTCHA_SECRET do produkčního .env pro silnější HMAC
