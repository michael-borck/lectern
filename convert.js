// convert.js — uploaded PDF/PPTX -> slide PNGs in presentations/<handle>/<slug>/
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 180000, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} failed: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });
}

function hasBinary(name) {
  const paths = (process.env.PATH || '').split(path.delimiter);
  return paths.some((p) => {
    try {
      fs.accessSync(path.join(p, name), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

// uploadPath: tmp file on disk; kind: 'pdf' | 'pptx'; outDir: deck folder
// returns number of slides written
async function convert(uploadPath, kind, outDir) {
  if (!hasBinary('pdftoppm')) {
    throw new Error('server is missing pdftoppm (poppler) — cannot convert');
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'present-'));
  try {
    let pdfPath = uploadPath;
    if (kind === 'pptx') {
      if (!hasBinary('soffice') && !hasBinary('libreoffice')) {
        throw new Error('PPTX conversion is not available on this server — upload a PDF instead');
      }
      const bin = hasBinary('soffice') ? 'soffice' : 'libreoffice';
      await run(bin, [
        '--headless', '--norestore',
        '--convert-to', 'pdf',
        '--outdir', tmp,
        uploadPath,
      ], { env: { ...process.env, HOME: tmp } });
      const produced = fs.readdirSync(tmp).find((f) => f.toLowerCase().endsWith('.pdf'));
      if (!produced) throw new Error('LibreOffice produced no PDF');
      pdfPath = path.join(tmp, produced);
    }

    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    await run('pdftoppm', ['-png', '-r', '150', pdfPath, path.join(outDir, 'slide')]);

    const slides = fs.readdirSync(outDir).filter((f) => /^slide-.*\.png$/i.test(f));
    if (slides.length === 0) throw new Error('no slides produced');
    return slides.length;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(uploadPath, { force: true });
  }
}

module.exports = { convert };
