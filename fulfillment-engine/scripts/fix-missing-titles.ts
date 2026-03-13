import * as fs from 'fs';
import * as path from 'path';

// Helper to convert handle to title (e.g., "saudi-arabia" -> "Saudi Arabia")
function handleToTitle(handle: string): string {
  return handle
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// Helper to parse CSV line properly (handles quoted commas)
function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let currentField = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      inQuotes = !inQuotes;
      currentField += char;
    } else if (char === ',' && !inQuotes) {
      fields.push(currentField);
      currentField = '';
    } else {
      currentField += char;
    }
  }
  fields.push(currentField);
  return fields;
}

const csvPath = path.join(process.cwd(), 'products_export_cleaned.csv');
const content = fs.readFileSync(csvPath, 'utf-8');
const lines = content.split('\n');

const firstOccurrence = new Map<string, number>();
const linesToFix: number[] = [];

// Find first occurrence of each handle
for (let i = 1; i < lines.length; i++) {
  const line = lines[i].trim();
  if (!line) continue;

  const fields = parseCSVLine(line);
  const handle = fields[0];
  const title = fields[1];

  if (handle && !firstOccurrence.has(handle)) {
    firstOccurrence.set(handle, i);

    // If title is missing, mark this line for fixing
    if (!title || title.trim() === '') {
      linesToFix.push(i);
    }
  }
}

console.log(`Found ${linesToFix.length} lines to fix\n`);

// Fix each line
let fixedCount = 0;
for (const lineIndex of linesToFix) {
  const fields = parseCSVLine(lines[lineIndex]);
  const handle = fields[0];
  const title = handleToTitle(handle);

  // Set the title (field index 1)
  fields[1] = title;

  // Additional fields that should be set on the first row:
  // Body (HTML) - field index 2
  fields[2] = '<p>Instant digital eSIM. Activate in minutes. No physical SIM required.<br></p>';

  // Vendor - field index 3
  fields[3] = 'Fluxyfi';

  // Product Category - field index 4
  fields[4] =
    'Electronics > Communications > Telephony > Mobile & Smart Phone Accessories > Mobile Phone Pre-Paid Cards & SIM Cards > eSIMs';

  // Status - last field (index 46)
  fields[46] = 'draft';

  lines[lineIndex] = fields.join(',');
  fixedCount++;
  console.log(`✓ Fixed line ${lineIndex + 1}: ${handle} -> "${title}"`);
}

// Write back to file
const outputPath = path.join(process.cwd(), 'products_export_cleaned.csv');
fs.writeFileSync(outputPath, lines.join('\n'), 'utf-8');

console.log(`\n✨ Fixed ${fixedCount} products`);
console.log(`📄 Updated file: ${outputPath}`);
