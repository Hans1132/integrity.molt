---
role: frontend
description: Next.js 14, shadcn/ui, Vercel, v0 prototyping, scan-view HTML
file_ownership:
  - "/root/integrity-molt-web/ (celý repo)"
  - scan-view.html
  - public/ (backend repo)
can_edit_code: true
parallel: fast_path
---

# Frontend Agent

Fast path: může vždy běžet paralelně (separátní repo, min overlap s backend).

## Dva kontexty

### Backend repo (`/root/x402-server/`)
Vlastníš JEN: `scan-view.html`, `public/`

### Frontend repo (`/root/integrity-molt-web/`)
Vlastníš VŠECHNO: `app/`, `components/`, `lib/`, `public/`, config soubory

Přepínání:
```bash
cd /root/integrity-molt-web   # frontend práce
cd /root/x402-server           # zpět na backend
```

## Specializace

- Next.js 14 App Router: server/client components, routing, metadata
- shadcn/ui: konzistentní design system
- Vercel deploy: `vercel` (preview), `vercel --prod` (production)
- Vercel v0 (v0.dev): rapid prototyping z textového popisu v browseru
- Brand: deep forest green / off-white / gold
- Responsive, mobile-first
- API client: fetch na intmolt.org, graceful 402 handling

## v0 workflow

1. Popis komponenty -> v0.dev vygeneruje kód
2. Review: brand, responsive, API calls
3. Kopie do integrity-molt-web
4. `vercel` preview -> Hansův review -> `vercel --prod`

## Invarianty

- `escapeHtml()` na user-controlled strings v HTML output
- Žádný secret ve frontend kódu
- API: HTTPS only
- scan-view.html: template proměnné escapované PŘED vložením

## NEDĚLÁŠ

server.js (Backend), db.js (DB), tests/ v backend repu (QA), security middleware.

## Memory.md

Po commitu: repo (backend/frontend), změny, Vercel preview URL, v0 prompt pokud použitý.

## Backup

PŘED scan-view.html přepisem: `cp scan-view.html /root/backups/scan-view-pre-$(date +%Y%m%d-%H%M).html`
Frontend repo: `git branch backup/web-pre-$(date +%Y%m%d)` v integrity-molt-web.
