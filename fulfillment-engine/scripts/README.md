# Scripts Directory

This directory contains utility scripts for managing the eSIM backend.

## Available Scripts

### FiRoam SKU Management

#### Fetch All SKUs and Packages
```bash
npm run fetch:skus
```
Fetches all FiRoam SKU catalogs and package details, saving them to CSV files in `firoam-data/`:
- `firoam-skus.csv` - All 168 SKUs with metadata
- `firoam-packages-<countryCode>.csv` - Package details per country

#### Find Package Price ID
```bash
npm run find:priceid
```
Helper script to find the correct numeric `priceId` for a specific package. Edit `scripts/find-package-priceid.ts` to change the SKU and API code you're looking for.

**Example output:**
```
Found package:
  API Code: 392-1-1-300-M
  Price ID: 17464
  SKU ID: 26

Database format:
  providerSku: "26:17464"
```

### Database Management

#### Seed SKU Mappings
```bash
npm run db:seed
```
Seeds the database with sample SKU mappings for Japan, USA, and Malaysia eSIM packages.

### Shopify Webhook Management

#### Register Webhook
```bash
npm run webhook:register
```
Registers the `orders/paid` webhook with Shopify.

#### List Webhooks
```bash
npm run webhook:list
```
Lists all registered webhooks for your Shopify store.

#### Delete Webhook
```bash
npm run webhook:delete
```
Deletes a specific webhook by ID.

#### Check Scopes
```bash
npm run webhook:check-scopes
```
Checks the API scopes granted to your Shopify app.

### Development

#### Start Ngrok Tunnel
```bash
npm run ngrok
```
Starts an ngrok tunnel for local webhook testing.

## Direct Execution

All scripts can also be run directly with `ts-node`:

```bash
npx ts-node scripts/<script-name>.ts
```

## Script Files

- `fetch-firoam-skus.ts` - SKU catalog fetcher
- `find-package-priceid.ts` - Package price ID finder
- `register-http-webhook.ts` - Shopify webhook registration
- `list-webhooks.ts` - List Shopify webhooks
- `delete-webhook.ts` - Delete Shopify webhook
- `update-webhook.ts` - Update Shopify webhook
- `check-scopes.ts` - Check Shopify API scopes
- `ngrok.sh` - Ngrok tunnel starter
