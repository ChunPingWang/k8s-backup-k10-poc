const { chromium } = require('playwright-core');
const fs = require('fs');

const TOKEN = fs.readFileSync('/tmp/k10_token.txt', 'utf8').trim();
const BASE = 'http://localhost:8080/k10/';
const OUT = '/home/rexwang/workspace/k8s-backup-k10-poc/screenshots';

(async () => {
  const browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  // Step 1: Login page
  console.log('1. Loading login page...');
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${OUT}/01-login.png` });
  console.log('   Captured: 01-login.png');

  // Step 2: Enter token and submit
  console.log('2. Logging in with token...');
  const tokenInput = page.locator('input').first();
  await tokenInput.fill(TOKEN);
  await page.waitForTimeout(500);
  await page.locator('button:has-text("Sign In"), button[type="submit"]').first().click();
  await page.waitForTimeout(8000);
  console.log('   Logged in. URL:', page.url());

  // Step 3: Handle EULA
  const eulaEmail = page.locator('input[type="email"], input[name="email"]').first();
  if (await eulaEmail.isVisible({ timeout: 3000 }).catch(() => false)) {
    console.log('3. EULA page detected, filling form...');
    await eulaEmail.fill('poc@example.com');
    await page.waitForTimeout(300);

    const companyInput = page.locator('input').nth(1);
    if (await companyInput.isVisible({ timeout: 1000 }).catch(() => false)) {
      await companyInput.fill('PoC Lab');
    }
    await page.waitForTimeout(300);

    // Click the Accept Terms button
    const acceptBtn = page.locator('button:has-text("Accept")');
    if (await acceptBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await acceptBtn.click();
      console.log('   Clicked Accept Terms');
      await page.waitForTimeout(10000);
      console.log('   URL after accept:', page.url());
    }
  }

  // Check if still on EULA - try force navigation
  if (page.url().includes('dashboard')) {
    // Try direct API check
    const html = await page.content();
    if (html.includes('EULA') || html.includes('License Agreement') || html.includes('Accept Terms')) {
      console.log('   EULA still showing, trying force click...');
      // Try clicking by coordinates or more specific selector
      await page.evaluate(() => {
        const buttons = document.querySelectorAll('button');
        for (const b of buttons) {
          if (b.textContent.includes('Accept')) {
            b.click();
            break;
          }
        }
      });
      await page.waitForTimeout(10000);
      console.log('   URL after force click:', page.url());
    }
  }

  // Step 4: Dashboard
  console.log('4. Capturing Dashboard...');
  await page.goto(`${BASE}#/dashboard`, { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(5000);
  await page.screenshot({ path: `${OUT}/02-dashboard.png` });
  console.log('   Captured: 02-dashboard.png');

  // Step 5: Applications
  console.log('5. Capturing Applications...');
  await page.goto(`${BASE}#/applications`, { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(5000);
  await page.screenshot({ path: `${OUT}/03-applications.png` });
  console.log('   Captured: 03-applications.png');

  // Step 6: Policies
  console.log('6. Capturing Policies...');
  await page.goto(`${BASE}#/policies`, { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(5000);
  await page.screenshot({ path: `${OUT}/04-policies.png` });
  console.log('   Captured: 04-policies.png');

  // Step 7: Settings > Locations
  console.log('7. Capturing Locations...');
  await page.goto(`${BASE}#/settings/locations`, { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(5000);
  await page.screenshot({ path: `${OUT}/05-locations.png` });
  console.log('   Captured: 05-locations.png');

  // Step 8: Activity
  console.log('8. Capturing Activity...');
  await page.goto(`${BASE}#/activity`, { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(5000);
  await page.screenshot({ path: `${OUT}/06-activity.png` });
  console.log('   Captured: 06-activity.png');

  await browser.close();
  console.log('\nAll screenshots captured!');
})();
