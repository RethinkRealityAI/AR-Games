import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
const S = '/tmp/claude-0/-home-user-AR-Games/485ec77e-263d-5fe2-a7c3-a11911d5965b/scratchpad/qp2';
mkdirSync(S, { recursive: true });
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-proxy-server'] });
const errors = [];
const shot = async (p, n) => { await p.screenshot({ path: `${S}/${n}.png` }); console.log('  shot', n); };

async function run(size, theme, label, extra) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 1000 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(9000);
  page.on('pageerror', (e) => errors.push(`${label}: ${e}`));
  await page.goto('http://localhost:4455/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1100);
  await page.getByText('Quantum Pairs', { exact: false }).first().click();
  await page.waitForTimeout(500);
  await page.locator('button').filter({ hasText: /^Solo vs AI/ }).first().click();
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: /^Launch/ }).click();
  await page.waitForTimeout(700);
  if (size)  await page.locator('button').filter({ hasText: new RegExp(`^${size}`) }).first().click();
  if (theme) await page.locator('button').filter({ hasText: new RegExp(`^${theme}`) }).first().click();
  await page.waitForTimeout(400);
  await shot(page, `${label}-settings`);
  await page.getByRole('button', { name: /Begin the opener/ }).click();
  await page.waitForTimeout(700);
  await page.locator('button').filter({ hasText: /Rock|Paper|Scissors/i }).first().click();
  await page.waitForTimeout(3200);
  await shot(page, `${label}-board`);
  if (extra) await extra(page, label);
  await ctx.close();
}

await run('Skirmish', null, 'a-skirmish');
await run('Standard', null, 'b-standard');
await run('Odyssey',  null, 'c-odyssey');
await run('Standard', 'Gambit', 'd-gambit');
await run('Standard', 'Prism',  'e-prism');

// Nova Pulse on Odyssey (biggest spectacle)
await run('Odyssey', null, 'f-nova', async (page, label) => {
  const pulse = page.locator('[data-testid="pulse-0"]');
  if (await pulse.count()) {
    console.log('  pulse state:', await pulse.getAttribute('data-state'));
    await pulse.click({ force: true });
    await page.waitForTimeout(700);  await shot(page, `${label}-pulse-mid`);
    await page.waitForTimeout(900);  await shot(page, `${label}-pulse-full`);
    console.log('  after fire:', await pulse.getAttribute('data-state'));
  } else console.log('  NO PULSE BUTTON');
});
console.log('page errors:', errors.length ? errors : 'none');
await browser.close();
