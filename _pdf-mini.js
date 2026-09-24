// A hand-built, dependency-free single-page PDF writer for short text reports (like the weekly
// compliance summary). Deliberately NOT using a library like pdfkit here: those bundle external
// font/AFM files that esbuild's function-bundling (see netlify.toml: node_bundler = "esbuild")
// can silently fail to include correctly in a serverless deploy, which would only surface as a
// broken PDF in production with no easy local repro. Sticking to the 14 standard PDF fonts
// (Helvetica/Helvetica-Bold here) needs no embedded font data at all — every PDF reader already
// has them built in — so this has zero external dependencies and nothing to bundle incorrectly.

function pdfEscape(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}
// The 14 standard PDF fonts (Helvetica etc.) only support WinAnsi/Latin-1 — no embedded font
// data means no Unicode glyphs. Silently dropping or mangling unsupported characters (an em-dash
// disappearing and eating a space along with it, e.g. "Aug 4–8" becoming "Aug 48") is far worse
// than not using decorative symbols at all, so this maps the common offenders to safe ASCII
// instead of leaving them to fail unpredictably per PDF reader.
function winAnsiSafe(str) {
  return String(str)
    .replace(/[\u2013\u2014]/g, '-')      // en dash, em dash
    .replace(/[\u2018\u2019]/g, "'")      // curly single quotes
    .replace(/[\u201C\u201D]/g, '"')      // curly double quotes
    .replace(/\u2026/g, '...')            // ellipsis
    .replace(/[\u2705\u2713\u2714]/g, '') // checkmark variants — convey via wording/color instead
    .replace(/[\u26A0\uFE0F]/g, '')       // warning sign + variation selector
    .replace(/[^\x00-\xFF]/g, '');        // anything else outside Latin-1 — drop rather than mangle
}

// items: array of { text, size=11, bold=false, color=[0,0,0], gapAfter=6 }
// Renders top-to-bottom starting near the top of a US Letter page, wrapping long lines crudely
// by character count (fine for short, glanceable report lines — this isn't meant for prose).
function buildSimplePdf({ items }) {
  const pageWidth = 612, pageHeight = 792;
  const marginLeft = 56, marginTop = 740;
  let y = marginTop;
  const ops = [];

  function wrapLine(text, maxChars) {
    if (text.length <= maxChars) return [text];
    const words = text.split(' ');
    const lines = [];
    let cur = '';
    for (const w of words) {
      if ((cur + ' ' + w).trim().length > maxChars) { lines.push(cur.trim()); cur = w; }
      else cur = (cur + ' ' + w).trim();
    }
    if (cur) lines.push(cur);
    return lines;
  }

  items.forEach((item) => {
    const size = item.size || 11;
    const font = item.bold ? '/F2' : '/F1';
    const color = item.color || [0, 0, 0];
    const maxChars = size >= 16 ? 46 : 78;
    const lines = wrapLine(winAnsiSafe(item.text), maxChars);
    lines.forEach((line) => {
      ops.push(`${color[0]} ${color[1]} ${color[2]} rg`);
      ops.push('BT');
      ops.push(`${font} ${size} Tf`);
      ops.push(`${marginLeft} ${y} Td`);
      ops.push(`(${pdfEscape(line)}) Tj`);
      ops.push('ET');
      y -= size + 6;
    });
    y -= (item.gapAfter != null ? item.gapAfter : 6);
  });

  const contentStream = ops.join('\n');
  const objects = [];
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  objects.push(`<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Contents 4 0 R >>`);
  objects.push(`<< /Length ${Buffer.byteLength(contentStream, 'utf8')} >>\nstream\n${contentStream}\nendstream`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefStart = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    pdf += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, 'binary');
}

module.exports = { buildSimplePdf };
