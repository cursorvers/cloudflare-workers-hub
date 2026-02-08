function escapePdfLiteralString(input: string): string {
  // Minimal escaping for PDF literal strings.
  return input.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/**
 * Generate a tiny, valid PDF 1.4 with one page containing embedded text.
 * Offsets/xref are computed to avoid parser fallback warnings.
 */
export function createMinimalHelloWorldPdf(text = 'Hello World'): ArrayBuffer {
  const offsets: number[] = [];
  let out = '';

  const add = (chunk: string) => {
    out += chunk;
  };

  add('%PDF-1.4\n');

  offsets[1] = out.length;
  add('1 0 obj\n');
  add('<< /Type /Catalog /Pages 2 0 R >>\n');
  add('endobj\n');

  offsets[2] = out.length;
  add('2 0 obj\n');
  add('<< /Type /Pages /Kids [3 0 R] /Count 1 >>\n');
  add('endobj\n');

  offsets[3] = out.length;
  add('3 0 obj\n');
  add('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]\n');
  add('   /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\n');
  add('endobj\n');

  const stream = `BT /F1 12 Tf 100 700 Td (${escapePdfLiteralString(text)}) Tj ET\n`;

  offsets[4] = out.length;
  add('4 0 obj\n');
  add(`<< /Length ${stream.length} >>\n`);
  add('stream\n');
  add(stream);
  add('endstream\n');
  add('endobj\n');

  offsets[5] = out.length;
  add('5 0 obj\n');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\n');
  add('endobj\n');

  const xrefOffset = out.length;
  add('xref\n');
  add('0 6\n');
  add('0000000000 65535 f \n');
  for (let i = 1; i <= 5; i++) {
    add(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  }
  add('trailer\n');
  add('<< /Size 6 /Root 1 0 R >>\n');
  add('startxref\n');
  add(`${xrefOffset}\n`);
  add('%%EOF\n');

  return new TextEncoder().encode(out).buffer;
}

