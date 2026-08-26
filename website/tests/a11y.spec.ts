import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('axe has no detected accessibility violations', async ({ page }) => {
  await page.goto('/');
  for (const selector of ['[data-motion-label="surface-engine-handoff"]', '[data-motion-label="proof-loop"]', '[data-motion-label="claim-verdict"]']) {
    await page.locator(selector).scrollIntoViewIfNeeded();
    await page.waitForTimeout(900);
    const result = await new AxeBuilder({ page }).analyze();
    expect(result.violations).toEqual([]);
  }
});
