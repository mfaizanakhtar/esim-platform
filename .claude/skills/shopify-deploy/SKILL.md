# Skill: Shopify Extension Deploy

## Scripts in this skill

| Script | Purpose |
|--------|---------|
| `deploy.sh` | Pull latest main, show changes, deploy extension to Shopify |

---

**Trigger**: Use this skill whenever the user asks to deploy the Shopify extension, push extension changes to Shopify, or says "deploy to Shopify".

---

## Usage

```bash
./.claude/skills/shopify-deploy/deploy.sh
```

## What it does

1. Pulls latest from `origin/main`
2. Shows what extension files changed since last deploy
3. Builds and deploys the extension via `shopify app deploy --force`
4. Reports the deployed version number

## Prerequisites

- Must be run from the repo root or `fulfillment-engine/` directory
- Shopify CLI installed (`npm install -g @shopify/cli`)
- Authenticated with Shopify Partners (run `shopify auth login` if needed)
