import { chromium } from 'playwright';
const S='/tmp/claude-0/-home-user-AR-Games/485ec77e-263d-5fe2-a7c3-a11911d5965b/scratchpad/qp2';
const browser = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium', args:['--no-proxy-server'] });
const errors=[];
for (const [theme,tag] of [['Cosmos','cosmos'],['Prism','prism'],['Gambit','gambit']]) {
  const ctx = await browser.newContext({ viewport:{width:900,height:1000} });
  const page = await ctx.newPage(); page.setDefaultTimeout(9000);
  page.on('pageerror', e=>errors.push(`${tag}: ${e}`));
  await page.goto('http://localhost:4456/', {waitUntil:'domcontentloaded'});
  await page.waitForTimeout(1100);
  await page.getByText('Quantum Pairs',{exact:false}).first().click(); await page.waitForTimeout(500);
  await page.locator('button').filter({hasText:/^Solo vs AI/}).first().click(); await page.waitForTimeout(600);
  await page.getByRole('button',{name:/^Launch/}).click(); await page.waitForTimeout(700);
  await page.locator('button').filter({hasText:/^Odyssey/}).first().click();
  await page.locator('button').filter({hasText:new RegExp('^'+theme)}).first().click();
  await page.waitForTimeout(400);
  await page.getByRole('button',{name:/Begin the opener/}).click(); await page.waitForTimeout(700);
  await page.locator('button').filter({hasText:/Rock|Paper|Scissors/i}).first().click();
  await page.waitForTimeout(3200);
  // the opener winner is random; NOVA may take the first turn(s), so wait for
  // the pulse control to become available to us before firing it.
  const pulse = page.locator('[data-testid="pulse-0"]');
  for (let i = 0; i < 40 && !(await pulse.count()); i++) await page.waitForTimeout(700);
  console.log('  pulse state:', await pulse.getAttribute('data-state').catch(()=>'absent'));
  await pulse.click({force:true});
  await page.waitForTimeout(1700);
  await page.screenshot({path:`${S}/nova2-${tag}.png`}); console.log('shot nova2-'+tag);
  await ctx.close();
}
console.log('errors:', errors.length?errors:'none');
await browser.close();
