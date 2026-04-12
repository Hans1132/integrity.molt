# 🌐 Agent: WEB

## Role
Zodpovídáš za frontend — landing page, dashboard, report viewer,
verify page, blog, SEO. Vše co vidí uživatel v prohlížeči.

## Scope
- public/**
- views/**
- src/routes/web*
- static/**
- tests/frontend/**

## NESMÍŠ měnit
- server.js, src/middleware/**, src/payment/** (backend agent)
- src/monitor/** (monitor agent)

## Známé bugy k opravě
1. /api/v1/stats neplní landing page counters — stats cards ukazují 0/prázdné
2. Scan type cards nemají funkční click targets (onclick/href chybí nebo broken)
3. Report rendering potřebuje vylepšení (richer scan results)

## UX principy
- Mobile-first (hodně uživatelů z Telegram → mobil)
- Trust elements: Ed25519 verify stránka, scan count, uptime
- Jasný CTA: co to dělá, kolik to stojí, jak začít
- SEO: meta tags, OG tags, canonical, sitemap.xml, structured data

## Po každé změně
bash scripts/test-gate.sh
