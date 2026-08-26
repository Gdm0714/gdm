import { test, expect } from '@playwright/test';

const sizes = [
  { width: 375, height: 812, name: '375x812' },
  { width: 768, height: 1024, name: '768x1024' },
  { width: 1440, height: 900, name: '1440x900' },
];

for (const size of sizes) {
  test(`responsive ${size.name}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize(size);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /Agents run/ })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
    const clippedControls = await page.evaluate(() => [...document.querySelectorAll('button')].filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && (rect.left < -1 || rect.right > document.documentElement.clientWidth + 1);
    }).map((element) => element.textContent?.trim()));
    expect(clippedControls).toEqual([]);
    if (size.width === 375) {
      const undersizedButtons = await page.evaluate(() => [...document.querySelectorAll('button')].filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && (rect.width < 44 || rect.height < 44);
      }).map((element) => ({ label: element.getAttribute('aria-label') ?? element.textContent?.trim(), width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height })));
      expect(undersizedButtons).toEqual([]);
    }
    await page.screenshot({ path: `artifacts/screenshots/${size.name}.png`, fullPage: true });
    expect(errors).toEqual([]);
  });
}

test('workbench Play, Pause, Replay, stage selection, and copy work', async ({ page }) => {
  await page.goto('/');
  await page.locator('#workbench').scrollIntoViewIfNeeded();
  const play = page.getByRole('button', { name: 'Play animation', exact: true });
  const pause = page.getByRole('button', { name: 'Pause animation', exact: true });
  await expect(play.or(pause)).toBeVisible();
  if (await play.isVisible()) await play.click();
  await expect(pause).toBeVisible();
  await pause.click();
  await expect(play).toBeVisible();
  await page.getByRole('button', { name: /7단계 PROVE/ }).click();
  await expect(page.locator('.proof-counter strong').first()).toHaveText('3/3');
  await page.getByRole('button', { name: 'Replay animation' }).click();
  await expect(pause).toBeVisible();
  await page.getByRole('button', { name: '설치 명령 복사' }).click();
  await expect(page.getByText('Copied ✓')).toBeVisible();
});

test('workbench pauses when it leaves the viewport', async ({ page }) => {
  await page.goto('/');
  await page.locator('.workbench-demo').evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await expect(page.getByRole('button', { name: 'Pause animation', exact: true })).toBeVisible();
  await page.locator('#product').scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: 'Play animation', exact: true })).toBeAttached();
  await page.locator('.workbench-demo').evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(1500);
  await expect(page.getByRole('button', { name: 'Play animation', exact: true })).toBeVisible();
});

test('mobile menu and Tasks, Agents, Proof tabs work', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  const menu = page.getByRole('button', { name: 'Menu' });
  await menu.click();
  await expect(page.locator('#nav-links')).toHaveClass(/nav-links-open/);
  await page.getByRole('link', { name: 'Safety' }).click();
  await expect(page.locator('#nav-links')).not.toHaveClass(/nav-links-open/);
  await page.locator('#workbench').scrollIntoViewIfNeeded();
  await page.getByRole('tab', { name: 'Agents' }).click();
  await expect(page.getByRole('tabpanel')).toContainText('interactive PTY');
  await page.getByRole('tab', { name: 'Proof' }).click();
  await expect(page.getByRole('tabpanel')).toContainText('PROOF RAIL');
  await page.getByRole('tab', { name: 'Tasks' }).click();
  await expect(page.getByRole('tabpanel')).toContainText('fix-login');
  await page.getByRole('button', { name: /4단계 RUN/ }).click();
  await expect(page.getByRole('tab', { name: 'Agents' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: /7단계 PROVE/ }).click();
  await expect(page.getByRole('tab', { name: 'Proof' })).toHaveAttribute('aria-selected', 'true');
});

test('reduced motion settles immediately without playback', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.locator('.proof-counter strong').first()).toHaveText('3/3');
  await expect(page.getByRole('button', { name: 'Play animation', exact: true })).toBeAttached();
});

test('keyboard operates menu, stages, tabs, and copy feedback', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  const menu = page.getByRole('button', { name: 'Menu' });
  await menu.focus();
  await page.keyboard.press('Enter');
  const close = page.getByRole('button', { name: 'Close' });
  await expect(close).toHaveAttribute('aria-expanded', 'true');
  await close.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: /7단계 PROVE/ }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tab', { name: 'Proof' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Proof' }).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('tab', { name: 'Agents' })).toHaveAttribute('aria-selected', 'true');
  const copy = page.getByRole('button', { name: '설치 명령 복사' });
  await copy.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Copied ✓')).toBeVisible();
});

test('essential product explanation remains when JavaScript is disabled', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, baseURL: 'http://127.0.0.1:4173' });
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Agents run. Evidence decides.' })).toBeVisible();
  await expect(page.getByText('터미널은 그대로. 혼란만 걷어냅니다.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'GitHub에서 gdm 보기' })).toHaveAttribute('href', GITHUB_FALLBACK);
  await context.close();
});

test('supporting motion runs only while each product explanation is visible', async ({ page }) => {
  await page.goto('/');
  const handoff = page.locator('[data-motion-label="surface-engine-handoff"]');
  await handoff.scrollIntoViewIfNeeded();
  await expect(handoff).toHaveAttribute('data-motion', 'running');
  const packet = handoff.locator('.handoff-packet');
  const runningAnimation = await packet.evaluate((element) => getComputedStyle(element).animationName);
  expect(runningAnimation).toContain('handoff-packet-run');

  const proofLoop = page.locator('[data-motion-label="proof-loop"]');
  await proofLoop.scrollIntoViewIfNeeded();
  await expect(proofLoop).toHaveAttribute('data-motion', 'running');
  await expect(handoff).toHaveAttribute('data-motion', 'settled');
  expect(await packet.evaluate((element) => getComputedStyle(element).animationName)).toBe('none');

  const verdict = page.locator('[data-motion-label="claim-verdict"]');
  await verdict.scrollIntoViewIfNeeded();
  await expect(verdict).toHaveAttribute('data-motion', 'running');
  expect(await verdict.locator('.verdict-route i').evaluate((element) => getComputedStyle(element).animationName)).toBe('verdict-node-run');

  const closing = page.locator('[data-motion-label="final-proof-dock"]');
  await closing.scrollIntoViewIfNeeded();
  await expect(closing).toHaveAttribute('data-motion', 'running');
  expect(await closing.locator('.closing-node').evaluate((element) => getComputedStyle(element).animationName)).toBe('closing-node-dock');
});

test('supporting motion settles without animation in reduced motion mode', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  for (const label of ['hero-proof', 'surface-engine-handoff', 'proof-loop', 'claim-verdict', 'final-proof-dock']) {
    await expect(page.locator(`[data-motion-label="${label}"]`)).toHaveAttribute('data-motion', 'settled');
  }
  expect(await page.locator('.handoff-packet').evaluate((element) => getComputedStyle(element).animationName)).toBe('none');
  expect(await page.locator('.closing-node').evaluate((element) => getComputedStyle(element).backgroundColor)).toBe('rgb(95, 208, 138)');
});

const GITHUB_FALLBACK = 'https://github.com/Gdm0714/gdm';
