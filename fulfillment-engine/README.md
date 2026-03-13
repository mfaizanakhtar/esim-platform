# fulfillment-engine

Node.js backend for the eSIM fulfillment platform. Handles Shopify webhooks, provisions eSIMs via FiRoam and TGT Technology, and delivers credentials by email.

**For full context, read [`AGENTS.md`](AGENTS.md).**

## Quick Start

```bash
npm install
cp ../.env.example .env   # fill in required vars
npm run prisma:generate
npm run prisma:migrate
npm run dev               # starts API + worker
```

## Key Commands

```bash
npm test -- --run    # run all tests
npm run verify       # type-check + build + lint + tests
npm run pr:create "feat: description"  # create PR with CI + CodeRabbit review
```
