/**
 * Pricing audit — read-only.
 *
 * Dumps every variant for the requested countries and flags monotonic
 * violations: same data ↑ days, same days ↑ data, and ↑ both (diagonal).
 * Groups by (country, planType) to mirror pricingEngine.ts's current grouping.
 *
 *   npx tsx scripts/audit-pricing.ts                          # default countries
 *   npx tsx scripts/audit-pricing.ts US,GB,JP,TH              # custom
 *   npx tsx scripts/audit-pricing.ts --json > out.json        # machine-readable
 *   npx tsx scripts/audit-pricing.ts --field=proposedPrice    # audit proposed (default: price)
 *   npx tsx scripts/audit-pricing.ts --group=country          # ignore planType (the proposed fix)
 */
import prisma from '~/db/prisma';
import { parseShopifySku } from '~/utils/parseShopifySku';

const DEFAULT_COUNTRIES = ['US', 'GB', 'JP', 'TH', 'AE', 'FR', 'DE', 'AU', 'IN', 'SG', 'MX', 'BR'];

type PriceField = 'price' | 'proposedPrice';
type GroupBy = 'country_planType' | 'country';

interface Row {
  id: string;
  sku: string;
  countryCode: string;
  planType: string;
  dataMb: number;
  validityDays: number;
  price: number | null;
  proposedPrice: number | null;
  costFloor: number | null;
  providerCost: number | null;
  priceLocked: boolean;
  marketPosition: string | null;
}

interface Violation {
  countryCode: string;
  planType: string;
  kind: 'same_data' | 'same_days' | 'diagonal';
  loVariant: { sku: string; dataMb: number; validityDays: number; price: number; locked: boolean };
  hiVariant: { sku: string; dataMb: number; validityDays: number; price: number; locked: boolean };
  delta: number;
}

function parseArgs() {
  const args = process.argv.slice(2);
  let countries = DEFAULT_COUNTRIES;
  let json = false;
  let field: PriceField = 'price';
  let groupBy: GroupBy = 'country_planType';
  for (const a of args) {
    if (a === '--json') json = true;
    else if (a.startsWith('--field=')) {
      const v = a.slice('--field='.length);
      if (v === 'price' || v === 'proposedPrice') field = v;
    } else if (a.startsWith('--group=')) {
      const v = a.slice('--group='.length);
      if (v === 'country' || v === 'country_planType') groupBy = v;
    } else if (!a.startsWith('--')) {
      countries = a
        .split(',')
        .map((c) => c.trim().toUpperCase())
        .filter(Boolean);
    }
  }
  return { countries, json, field, groupBy };
}

async function loadVariants(countries: string[]): Promise<Row[]> {
  const variants = await prisma.shopifyProductTemplateVariant.findMany({
    where: { template: { countryCode: { in: countries } } },
    include: { template: { select: { countryCode: true } } },
  });
  const rows: Row[] = [];
  for (const v of variants) {
    if (!v.template.countryCode) continue;
    const parsed = parseShopifySku(v.sku);
    if (!parsed) continue;
    rows.push({
      id: v.id,
      sku: v.sku,
      countryCode: v.template.countryCode,
      planType: v.planType,
      dataMb: parsed.dataMb,
      validityDays: parsed.validityDays,
      price: v.price == null ? null : Number(v.price),
      proposedPrice: v.proposedPrice == null ? null : Number(v.proposedPrice),
      costFloor: v.costFloor == null ? null : Number(v.costFloor),
      providerCost: v.providerCost == null ? null : Number(v.providerCost),
      priceLocked: v.priceLocked,
      marketPosition: v.marketPosition,
    });
  }
  return rows;
}

function detectViolations(rows: Row[], field: PriceField, groupBy: GroupBy): Violation[] {
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const key = groupBy === 'country' ? r.countryCode : `${r.countryCode}::${r.planType}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }

  const violations: Violation[] = [];
  for (const [, group] of groups) {
    for (let i = 0; i < group.length; i++) {
      for (let j = 0; j < group.length; j++) {
        if (i === j) continue;
        const a = group[i];
        const b = group[j];
        const dataLE = a.dataMb <= b.dataMb;
        const daysLE = a.validityDays <= b.validityDays;
        const strict = a.dataMb < b.dataMb || a.validityDays < b.validityDays;
        if (!(dataLE && daysLE && strict)) continue;

        const aPrice = field === 'price' ? a.price : a.proposedPrice;
        const bPrice = field === 'price' ? b.price : b.proposedPrice;
        if (aPrice == null || bPrice == null) continue;

        if (bPrice <= aPrice) {
          // The higher-tier variant being locked makes the violation an intentional override.
          if (b.priceLocked) continue;
          let kind: Violation['kind'];
          if (a.dataMb === b.dataMb) kind = 'same_data';
          else if (a.validityDays === b.validityDays) kind = 'same_days';
          else kind = 'diagonal';
          violations.push({
            countryCode: a.countryCode,
            planType: a.planType,
            kind,
            loVariant: {
              sku: a.sku,
              dataMb: a.dataMb,
              validityDays: a.validityDays,
              price: aPrice,
              locked: a.priceLocked,
            },
            hiVariant: {
              sku: b.sku,
              dataMb: b.dataMb,
              validityDays: b.validityDays,
              price: bPrice,
              locked: b.priceLocked,
            },
            delta: +(bPrice - aPrice).toFixed(2),
          });
        }
      }
    }
  }
  return violations;
}

function fmt(n: number | null): string {
  if (n == null) return '   —  ';
  return n.toFixed(2).padStart(6);
}

function printCountryTable(country: string, rows: Row[]) {
  const sorted = [...rows].sort(
    (a, b) =>
      a.planType.localeCompare(b.planType) ||
      a.dataMb - b.dataMb ||
      a.validityDays - b.validityDays,
  );
  console.log(`\n=== ${country} (${sorted.length} variants) ===`);
  console.log('planType         dataMb  days   price   propos   floor   cost   lock  pos');
  for (const r of sorted) {
    console.log(
      [
        r.planType.padEnd(16).slice(0, 16),
        String(r.dataMb).padStart(6),
        String(r.validityDays).padStart(4),
        fmt(r.price),
        fmt(r.proposedPrice),
        fmt(r.costFloor),
        fmt(r.providerCost),
        r.priceLocked ? '  ✓ ' : '    ',
        (r.marketPosition ?? '').slice(0, 12),
      ].join('  '),
    );
  }
}

function summariseViolations(violations: Violation[]) {
  const byKind = { same_data: 0, same_days: 0, diagonal: 0 };
  const byCountry = new Map<string, number>();
  let identicalCount = 0;
  let bothAtFloorCount = 0;
  for (const v of violations) {
    byKind[v.kind]++;
    byCountry.set(v.countryCode, (byCountry.get(v.countryCode) ?? 0) + 1);
    if (v.delta === 0) identicalCount++;
    // Pricing engine clamps standardFloor to minimumPrice (default $2.99). If both prices == 2.99 it's
    // strong evidence H2 (both hit floor) is the cause.
    if (v.loVariant.price === 2.99 && v.hiVariant.price === 2.99) bothAtFloorCount++;
  }
  console.log('\n=== Summary ===');
  console.log(`Total violations: ${violations.length}`);
  console.log(`  same_data (↑ days, ≤ price):  ${byKind.same_data}`);
  console.log(`  same_days (↑ data, ≤ price):  ${byKind.same_days}`);
  console.log(`  diagonal  (↑ both, ≤ price):  ${byKind.diagonal}`);
  console.log(`  exact-tie (delta=0):           ${identicalCount}`);
  console.log(`  both stuck at $2.99 floor:     ${bothAtFloorCount}`);
  console.log('\nBy country:');
  for (const [c, n] of [...byCountry.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${c}: ${n}`);
  }
}

async function main() {
  const { countries, json, field, groupBy } = parseArgs();
  const rows = await loadVariants(countries);
  const violations = detectViolations(rows, field, groupBy);

  if (json) {
    process.stdout.write(JSON.stringify({ countries, field, groupBy, rows, violations }, null, 2));
    return;
  }

  console.log(`Audit field: ${field}`);
  console.log(`Group by:    ${groupBy}`);
  console.log(`Countries:   ${countries.join(', ')}`);

  const byCountry = new Map<string, Row[]>();
  for (const r of rows) {
    if (!byCountry.has(r.countryCode)) byCountry.set(r.countryCode, []);
    byCountry.get(r.countryCode)!.push(r);
  }
  for (const c of countries) {
    const cRows = byCountry.get(c);
    if (!cRows || cRows.length === 0) {
      console.log(`\n=== ${c} === (no variants)`);
      continue;
    }
    printCountryTable(c, cRows);
  }

  if (violations.length === 0) {
    console.log('\n✅ No monotonic violations found.');
  } else {
    console.log(`\n=== Violations (${violations.length}) ===`);
    for (const v of violations.slice(0, 200)) {
      console.log(
        `[${v.countryCode}/${v.planType}] ${v.kind}: ` +
          `${v.loVariant.sku} (${v.loVariant.dataMb}MB/${v.loVariant.validityDays}d) ` +
          `$${v.loVariant.price.toFixed(2)}${v.loVariant.locked ? '🔒' : ''} ≥ ` +
          `${v.hiVariant.sku} (${v.hiVariant.dataMb}MB/${v.hiVariant.validityDays}d) ` +
          `$${v.hiVariant.price.toFixed(2)} (Δ${v.delta >= 0 ? '+' : ''}${v.delta.toFixed(2)})`,
      );
    }
    if (violations.length > 200) {
      console.log(`... and ${violations.length - 200} more (use --json for full list)`);
    }
  }

  summariseViolations(violations);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
