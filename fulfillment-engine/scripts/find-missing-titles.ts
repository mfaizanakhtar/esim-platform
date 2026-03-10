import * as fs from 'fs';
import * as path from 'path';

const csvPath = path.join(process.cwd(), 'products_export_cleaned.csv');
const content = fs.readFileSync(csvPath, 'utf-8');
const lines = content.split('\n');

// Track first occurrence of each handle
const firstOccurrence = new Map();
const missingTitles: Array<{ handle: string; line: number }> = [];

for (let i = 1; i < lines.length; i++) {
  const line = lines[i].trim();
  if (!line) continue;

  const fields = line.split(',');
  const handle = fields[0];
  const title = fields[1];

  if (handle && !firstOccurrence.has(handle)) {
    firstOccurrence.set(handle, { line: i + 1, hasTitle: !!title });

    if (!title) {
      missingTitles.push({ handle, line: i + 1 });
    }
  }
}

console.log(`Total unique products: ${firstOccurrence.size}`);
console.log(`Products with missing title: ${missingTitles.length}\n`);

if (missingTitles.length > 0) {
  console.log('Products missing title:');
  missingTitles.forEach(({ handle, line }) => {
    console.log(`  Line ${line}: ${handle}`);
  });
}
