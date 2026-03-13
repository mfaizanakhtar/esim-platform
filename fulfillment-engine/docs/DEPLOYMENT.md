# Railway Deployment Guide

> **Document Type**: Setup & Deployment  
> **Status**: ⚠️ Generic (prefer RAILWAY_DEPLOY.md for production)  
> **Last Updated**: 2026-03-01  
> **Purpose**: General deployment guide for any platform

---

## 🚀 Quick Setup

### 1. Install Railway CLI

```bash
npm install -g @railway/cli
```

### 2. Login to Railway

```bash
railway login
```

### 3. Create New Project

```bash
railway init
```

Select: **Empty Project**

## 📦 Service Setup

### Create Three Services

1. **Postgres Database**
2. **API Service** 
3. **Worker Service**

### A. Postgres Database

```bash
railway add --database postgres
```

Railway will automatically create `DATABASE_URL` environment variable.

### B. API Service

```bash
railway service create api
```

**Environment Variables for API:**

```bash
# Shopify
railway variables set SHOPIFY_CLIENT_ID="your-client-id"
railway variables set SHOPIFY_CLIENT_SECRET="your-client-secret"
railway variables set SHOPIFY_WEBHOOK_SECRET="your-webhook-secret"
railway variables set SHOPIFY_SHOP_DOMAIN="your-shop.myshopify.com"

# FiRoam
railway variables set FIROAM_API_KEY="your-api-key"
railway variables set FIROAM_SIGN_KEY="your-sign-key"

# Encryption
railway variables set ENCRYPTION_KEY="your-32-byte-hex-key"

# Link to database (Railway will auto-populate DATABASE_URL)
railway service link
```

**Start Command Override:**
- Railway auto-detects Dockerfile
- Default CMD runs API: `node dist/index.js`

**Add Domain:**
- Railway generates domain automatically (e.g., `api-production-xxxx.up.railway.app`)
- Or add custom domain in Railway dashboard

### C. Worker Service

```bash
railway service create worker
```

**Environment Variables for Worker:**
- Same as API (can share service variables in Railway dashboard)
- Or set individually:

```bash
railway variables set SHOPIFY_CLIENT_ID="your-client-id"
railway variables set SHOPIFY_CLIENT_SECRET="your-client-secret"
railway variables set SHOPIFY_SHOP_DOMAIN="your-shop.myshopify.com"
railway variables set FIROAM_API_KEY="your-api-key"
railway variables set FIROAM_SIGN_KEY="your-sign-key"
railway variables set ENCRYPTION_KEY="your-32-byte-hex-key"
```

**Start Command Override:**
In Railway dashboard → Worker service → Settings → Deploy:
- **Start Command**: `node dist/worker/index.js`

Or in `railway.json` per service (if using service-specific configs).

## 🔄 CI/CD with GitHub Actions

### 1. Get Railway Token

```bash
railway token
```

Copy the token.

### 2. Add GitHub Secret

Go to: **GitHub Repo → Settings → Secrets and variables → Actions**

Add secret:
- **Name**: `RAILWAY_TOKEN`
- **Value**: `<your-railway-token>`

### 3. Configure Railway Services

In Railway dashboard, link your services to GitHub:

1. **API Service**:
   - Settings → Source → Connect GitHub repo
   - Service name: `api`

2. **Worker Service**:
   - Settings → Source → Connect GitHub repo
   - Service name: `worker`

### 4. Push to Main

```bash
git add .
git commit -m "Add Railway deployment"
git push origin main
```

GitHub Actions will:
✅ Lint code
✅ Run tests
✅ Build Docker image
✅ Deploy to Railway
✅ Run migrations

## 🗄️ Database Migrations

### First Time Setup

```bash
# Connect to API service
railway service api

# Run migrations
railway run npx prisma migrate deploy

# (Optional) Seed database
railway run npm run seed:all-mappings
```

### Automatic Migrations

Migrations run automatically in CI/CD pipeline after deployment.

Or add to API service start command:
```bash
npx prisma migrate deploy && node dist/index.js
```

## 🔍 Monitoring

### View Logs

```bash
# API logs
railway logs --service api

# Worker logs
railway logs --service worker

# Follow logs
railway logs --service api --follow
```

### Railway Dashboard

- Go to: https://railway.app/dashboard
- View metrics: CPU, Memory, Network
- Check deployments, logs, variables

## 💰 Cost Management

### Current Plan: Hobby ($5/month)

**Included:**
- $5 usage credits per month
- Up to 50 GB RAM / 50 vCPU per service
- Up to 5 GB storage
- After credits: pay only for actual usage

**Estimated Monthly Cost: $5-10**
- API service: ~$0-3 (mostly idle)
- Worker service: ~$0-3 (runs only during orders)
- Postgres: ~$0-2 (small database)

**Monitor Usage:**
```bash
railway status
```

Or check Railway dashboard → Billing

## 🌍 Custom Domain (Optional)

### API Service

1. Railway dashboard → API service → Settings → Networking
2. Click **Generate Domain** (free Railway domain)
3. Or add **Custom Domain** (point DNS to Railway)

Example: `api.yourdomain.com`

### Update Shopify Webhook URL

After deployment, update webhook URL:

```bash
npm run webhook:register https://your-api-domain.railway.app
```

## 🔒 Security Best Practices

1. **Environment Variables**: Never commit secrets to git
2. **Encryption Key**: Generate strong 32-byte key:
   ```bash
   openssl rand -hex 32
   ```
3. **Rotate Secrets**: Regularly rotate API keys and tokens
4. **Service Isolation**: API and Worker share DB but run separately

## 🛠️ Local Development with Docker

```bash
# Start all services
docker-compose up -d

# View logs
docker-compose logs -f

# Stop services
docker-compose down

# Rebuild after code changes
docker-compose up -d --build
```

## 📝 Deployment Checklist

- [ ] Railway CLI installed
- [ ] Railway project created
- [ ] Postgres database provisioned
- [ ] API service created with correct env vars
- [ ] Worker service created with start command override
- [ ] GitHub repo connected to Railway
- [ ] `RAILWAY_TOKEN` added to GitHub secrets
- [ ] Database migrations run
- [ ] SKU mappings seeded
- [ ] Shopify webhook URL updated to Railway domain
- [ ] Test order processed successfully

## 🆘 Troubleshooting

### Deployment Fails

```bash
# Check build logs
railway logs --service api

# Verify environment variables
railway variables
```

### Database Connection Issues

```bash
# Verify DATABASE_URL is set
railway variables | grep DATABASE_URL

# Test connection
railway run --service api npx prisma db push
```

### Worker Not Processing Jobs

- Verify start command is `node dist/worker/index.js`
- Check worker logs: `railway logs --service worker`
- Ensure DATABASE_URL is accessible

### High Costs

- Check Railway dashboard for usage breakdown
- Scale down resources if needed
- Consider upgrading to Pro plan ($20/month) with more included credits

## 📚 Additional Resources

- [Railway Docs](https://docs.railway.app/)
- [Railway CLI Reference](https://docs.railway.app/develop/cli)
- [Prisma Migrations](https://www.prisma.io/docs/guides/migrate/production-troubleshooting)
