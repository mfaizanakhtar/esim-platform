import * as fs from 'fs';

function parseCSVRows(content: string): string[] {
  const rows: string[] = [];
  let currentRow = '';
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];

    if (char === '"') {
      if (i + 1 < content.length && content[i + 1] === '"') {
        currentRow += '""';
        i++;
      } else {
        inQuotes = !inQuotes;
        currentRow += char;
      }
    } else if (char === '\n' && !inQuotes) {
      if (currentRow.trim()) {
        rows.push(currentRow);
      }
      currentRow = '';
    } else if (char === '\r') {
      continue;
    } else {
      currentRow += char;
    }
  }
  if (currentRow.trim()) {
    rows.push(currentRow);
  }
  return rows;
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

const content = fs.readFileSync('products_export_cleaned.csv', 'utf-8');
const rows = parseCSVRows(content);

console.log('Total rows found:', rows.length);

// Find Saudi Arabia
for (const row of rows) {
  if (row.startsWith('saudi-arabia,Saudi Arabia')) {
    const fields = parseCSVLine(row);
    console.log('\nFound Saudi Arabia title row');
    console.log('Field count:', fields.length);
    console.log('Field 50 (Status):', fields[49]);
    console.log('Has newlines in row:', row.includes('\n'));
    console.log('Row length:', row.length);
    break;
  }
}
