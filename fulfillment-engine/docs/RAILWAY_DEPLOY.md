# Railway Deployment Guide

> **Document Type**: Setup & Deployment  
> **Status**: ✅ Current (Production deployment)  
> **Last Updated**: 2026-03-01  
> **Purpose**: Railway-specific deployment instructions

---

## Simple GitHub-based Deployment

### Step 1: Push to GitHub

```bash
git add .
git commit -m "Ready for Railway deployment"
git push origin main
```

### Step 2: Create Railway Project

1. Go to https://railway.app
2. Click "New Project"
3. Select "Deploy from GitHub repo"
4. Authorize Railway to access your GitHub
5. Select `esim_backend` repository

### Step 3: Add PostgreSQL

1. In your Railway project dashboard, click "New"
2. Select "Database" → "Add PostgreSQL"
3. Railway automatically creates `DATABASE_URL` variable

### Step 4: Configure API Service

Railway auto-deploys from your Dockerfile. Configure it:

1. Click on the auto-created service
2. Go to "Variables" tab
3. Add these variables:

```
SHOPIFY_CLIENT_ID=your_value
SHOPIFY_CLIENT_SECRET=your_value
SHOPIFY_WEBHOOK_SECRET=your_value
SHOPIFY_SHOP_DOMAIN=your_value
FIROAM_BASE_URL=your_value
FIROAM_PHONE=your_value
FIROAM_PASSWORD=your_value
FIROAM_SIGN_KEY=your_value
ENCRYPTION_KEY=your_value
```

4. Go to "Settings" tab
5. Click "Generate Domain" to get a public URL
6. Rename service to "api" (optional)

### Step 5: Add Worker Service

1. Click "New" → "GitHub Repo"
2. Select the **same** `esim_backend` repository
3. Go to "Settings" tab
4. Under "Deploy", find "Custom Start Command"
5. Set to: `node dist/worker/index.js`
6. Go to "Variables" tab
7. Add the **same** environment variables as API
8. Rename service to "worker" (optional)

### Step 6: Run Migrations

Once API service is deployed:

1. Click on "api" service
2. Go to "Settings" → "Deploy Logs" to ensure build succeeded
3. In your local terminal:

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Link to your project
railway link

# Select the API service
railway service

# Run migrations
railway run --service api npx prisma migrate deploy
```

Or manually trigger via Railway's web interface:
- Go to API service → "Settings" → "One-off Command"
- Run: `npx prisma migrate deploy`

### Step 7: Update Shopify Webhook

Get your Railway API domain from the dashboard, then:

```bash
npm run webhook:register https://your-api-domain.railway.app
```

---

## CI/CD (Automatic Deployments)

✅ **Already enabled!** Railway automatically redeploys when you push to `main`.

Every `git push` triggers:
- Fresh Docker build
- Deploy to both API and Worker services
- Zero-downtime deployment

---

## Monitoring

**View Logs:**
- Dashboard → Select service → "Deployments" tab → Click latest deployment

**View Metrics:**
- Dashboard → Select service → "Metrics" tab

**Estimated Cost:** $5-10/month

---

## Troubleshooting

**Build fails:**
- Check "Deploy Logs" for errors
- Verify all environment variables are set
- Ensure Dockerfile builds locally: `docker build -t test .`

**Database connection issues:**
- Verify `DATABASE_URL` is set (auto-set when you add Postgres)
- Check both API and Worker services have database linked

**Worker not processing jobs:**
- Verify Worker service has custom start command: `node dist/worker/index.js`
- Check Worker logs for connection errors
