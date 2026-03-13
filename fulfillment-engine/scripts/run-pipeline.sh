#!/bin/bash

# ═══════════════════════════════════════════════════════════════
# Shopify eSIM SKU Pipeline - Full Workflow
# ═══════════════════════════════════════════════════════════════
# This script runs all phases to generate, match, and deploy SKUs
# from Shopify export to production database
# ═══════════════════════════════════════════════════════════════

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo ""
echo -e "${MAGENTA}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${MAGENTA}    Shopify eSIM SKU Pipeline - Full Workflow${NC}"
echo -e "${MAGENTA}═══════════════════════════════════════════════════════════════${NC}"
echo ""

# Check prerequisites
echo -e "${CYAN}📋 Checking prerequisites...${NC}"
if [ ! -f "products_export_1.csv" ]; then
    echo -e "${RED}❌ Error: products_export_1.csv not found${NC}"
    echo "   Please ensure Shopify export file exists in project root"
    exit 1
fi

if [ ! -d "firoam-data" ]; then
    echo -e "${RED}❌ Error: firoam-data directory not found${NC}"
    echo "   Please run: npm run fetch:skus"
    exit 1
fi

echo -e "${GREEN}✅ Prerequisites checked${NC}"
echo ""

# Phase 1: Generate SKUs
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}Phase 1: Generate SKUs from Shopify Export${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
npm run generate:skus
echo ""
echo -e "${GREEN}✅ Phase 1 complete: shopify-skus-generated.csv${NC}"
echo ""

# Phase 2: Match with FiRoam
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}Phase 2: Match SKUs with FiRoam Packages${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
npm run match:firoam
echo ""
echo -e "${GREEN}✅ Phase 2 complete: shopify-firoam-mappings.csv${NC}"
echo ""

# Phase 3: Generate Seed Script
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}Phase 3: Generate Database Seed Script${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
npm run generate:seed
echo ""
echo -e "${GREEN}✅ Phase 3 complete: prisma/seed-all-mappings.ts${NC}"
echo ""

# Phase 4: Deploy to Database
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}Phase 4: Deploy Mappings to Database${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
npm run seed:all-mappings
echo ""
echo -e "${GREEN}✅ Phase 4 complete: Database updated${NC}"
echo ""

# Phase 5: Update Shopify Export
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}Phase 5: Update Shopify Export with SKUs${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
npm run update:export
echo ""
echo -e "${GREEN}✅ Phase 5 complete: csv-exports/products_export_updated.csv${NC}"
echo ""

# Phase 6: Clean Export
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}Phase 6: Clean Export (Remove Unfulfillable Products)${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
npm run clean:export
echo ""
echo -e "${GREEN}✅ Phase 6 complete: csv-exports/products_export_cleaned.csv${NC}"
echo ""

# Phase 7: Verify Mappings
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}Phase 7: Verify Database Mappings${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
npm run verify:mappings
echo ""
echo -e "${GREEN}✅ Phase 7 complete: Verification report generated${NC}"
echo ""

# Final Summary
echo ""
echo -e "${MAGENTA}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${MAGENTA}    ✨ Pipeline Complete!${NC}"
echo -e "${MAGENTA}═══════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "${CYAN}📁 Generated Files (csv-exports/):${NC}"
echo "   • shopify-skus-generated.csv - Generated SKUs"
echo "   • shopify-firoam-mappings.csv - Matching results"
echo "   • products_export_updated.csv - All products with SKUs"
echo "   • products_export_cleaned.csv - Only fulfillable products"
echo "   • shopify-missing-mappings.csv - Products without mappings"
echo ""
echo -e "${CYAN}🗄️  Database:${NC}"
echo "   • ProviderSkuMapping table updated"
echo "   • prisma/seed-all-mappings.ts - Database seed script"
echo ""
echo -e "${CYAN}📤 Next Steps:${NC}"
echo "   1. Review csv-exports/products_export_cleaned.csv"
echo "   2. Upload to Shopify Admin → Products → Import"
echo "   3. Select 'Overwrite existing products that have a matching handle'"
echo "   4. Test an order to verify eSIM provisioning"
echo ""
echo -e "${GREEN}🎉 All phases completed successfully!${NC}"
echo ""
