// Renders the DELIBERATELY POOR fixture the design's §3 acceptance demands:
// the same ChairMaker price list, creased, angled and half-lit — the misread
// it produces is the test. Re-run to regenerate; output is committed so the
// suite never depends on Chrome being present.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const html = `<!doctype html><meta charset="utf-8">
<style>
  body { margin: 0; background: #4a4238; display: grid; place-items: center; height: 100vh; }
  .paper {
    width: 560px; padding: 36px 40px; background: #efe9dc;
    font-family: Georgia, serif; color: #2a2118;
    transform: perspective(900px) rotateZ(-7deg) rotateY(14deg) rotateX(4deg);
    box-shadow: 0 18px 40px rgba(0,0,0,.55);
    position: relative; filter: blur(0.6px) contrast(0.82) brightness(0.9);
  }
  /* The crease: a fold line with a lighting discontinuity across it. */
  .paper::before {
    content: ''; position: absolute; inset: 0;
    background: linear-gradient(102deg,
      rgba(0,0,0,0) 44%, rgba(0,0,0,.28) 49%, rgba(255,255,255,.14) 52%, rgba(0,0,0,0) 58%);
  }
  /* Half-lit: one side falls into shadow. */
  .paper::after {
    content: ''; position: absolute; inset: 0;
    background: linear-gradient(75deg, rgba(0,0,0,0) 38%, rgba(20,12,4,.5) 78%);
  }
  h1 { font-size: 22px; margin: 0 0 2px; letter-spacing: 1px; }
  .sub { font-size: 12px; margin-bottom: 18px; color: #5a4a38; }
  table { width: 100%; border-collapse: collapse; font-size: 15px; }
  th, td { text-align: left; padding: 7px 4px; border-bottom: 1px solid #b8ab95; }
  th { font-size: 12px; text-transform: uppercase; letter-spacing: .5px; }
  .num { text-align: right; }
  .smudge { position: relative; }
  .smudge::after {
    content: ''; position: absolute; inset: -2px -6px;
    background: radial-gradient(ellipse at 60% 50%, rgba(42,33,24,.34), rgba(0,0,0,0) 68%);
  }
</style>
<div class="paper">
  <h1>THE CHAIRMAKER</h1>
  <div class="sub">Workshop price list &mdash; wholesale, ex-works Bengaluru</div>
  <table>
    <tr><th>Code</th><th>Item</th><th class="num">Price (INR)</th></tr>
    <tr><td>CM-STOOL-1</td><td>Teak workshop stool</td><td class="num">4,500</td></tr>
    <tr class="smudge"><td>CM-BENCH-2</td><td>4ft teak bench</td><td class="num">12,500</td></tr>
    <tr><td>CM-CHAIR-1</td><td>Oak dining chair</td><td class="num">18,000</td></tr>
    <tr><td></td><td>Rosewood side table (new)</td><td class="num">9,750</td></tr>
  </table>
</div>`;

const dir = mkdtempSync(path.join(tmpdir(), 'poor-fixture-'));
const page = path.join(dir, 'page.html');
writeFileSync(page, html);
const out = path.join(dir, 'shot.png');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
execFileSync(chrome, [
  '--headless', '--disable-gpu', '--force-device-scale-factor=1',
  `--screenshot=${out}`, '--window-size=760,900', `file://${page}`,
]);
const dest = path.join(path.dirname(new URL(import.meta.url).pathname), 'chairmaker_price_list_poor.png');
copyFileSync(out, dest);
rmSync(dir, { recursive: true, force: true });
console.log('wrote', dest);
