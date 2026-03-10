# eSIM Backend (scaffold)

This repository is a scaffold for the Shopify → FiRoam eSIM fulfillment backend.

Quick start:

1. Install dependencies

```bash
npm install
```

2. Create a `.env` with at minimum:

```
DATABASE_URL=postgresql://user:pass@localhost:5432/esim
SHOPIFY_ADMIN_TOKEN=...
SHOPIFY_WEBHOOK_SECRET=...
FIROAM_API_KEY=...
ENCRYPTION_KEY=... # 32-byte key
```

3. Generate Prisma client and run migrations (Postgres required)

```bash
npm run prisma:generate
npm run prisma:migrate
```

4. Start in dev mode

```bash
npm run dev
```
