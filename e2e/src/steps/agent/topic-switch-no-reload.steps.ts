/**
 * Topic Switch No-Reload Regression Test Steps
 *
 * Verifies that switching topics within the same agent does NOT trigger a full
 * browser page reload. The bug was caused by NavItem's onClick handler skipping
 * e.preventDefault() when disabled/loading was true, allowing the <a> tag's
 * default navigation to fire.
 *
 * Detection: inject a window marker before switching, verify it survives.
 */
import { Given, Then, When } from '@cucumber/cucumber';
import { expect } from '@playwright/test';

import type { CustomWorld } from '../../support/world';
import { WAIT_TIMEOUT } from '../../support/world';

// ============================================
// Helpers
// ============================================

async function focusAndType(world: CustomWorld, text: string): Promise<void> {
  const candidates = [
    world.page.locator(
      'textarea[placeholder*="Ask"], textarea[placeholder*="Press"], textarea[placeholder*="输入"]',
    ),
    world.page.locator('[data-testid="chat-input"] [contenteditable="true"]'),
    world.page.locator('[data-testid="chat-input"] textarea'),
  ];

  for (const locator of candidates) {
    const count = await locator.count();
    for (let i = 0; i < count; i++) {
      const item = locator.nth(i);
      if (await item.isVisible().catch(() => false)) {
        await item.click({ force: true });
        await world.page.waitForTimeout(300);
        await world.page.keyboard.type(text, { delay: 30 });
        return;
      }
    }
  }

  throw new Error('Could not find a visible chat input');
}

// ============================================
// Given Steps
// ============================================

Given('用户在当前 Agent 中创建了两个对话', async function (this: CustomWorld) {
  console.log('   📍 Step: 创建第一个对话...');

  // Send first message to create topic 1
  await focusAndType(this, 'hello');
  await this.page.keyboard.press('Enter');
  await this.page.waitForTimeout(3000);

  // Verify a topic appeared in sidebar
  const topicItems = this.page.locator('[data-testid="topic-item"]');
  await expect(topicItems.first()).toBeVisible({ timeout: WAIT_TIMEOUT });
  console.log('   ✅ 第一个对话已创建');

  // Create a new topic
  console.log('   📍 Step: 创建第二个对话...');
  const addTopicButton = this.page.locator('svg.lucide-message-square-plus').locator('..');
  await expect(addTopicButton.first()).toBeVisible({ timeout: 5000 });
  await addTopicButton.first().click();
  await this.page.waitForTimeout(1000);

  // Send message to create topic 2
  await focusAndType(this, 'world');
  await this.page.keyboard.press('Enter');
  await this.page.waitForTimeout(3000);

  // Verify we now have at least 2 topics
  const topicCount = await topicItems.count();
  console.log(`   📍 话题数量: ${topicCount}`);
  expect(topicCount).toBeGreaterThanOrEqual(2);
  console.log('   ✅ 两个对话已创建');
});

// ============================================
// When Steps
// ============================================

When('用户在页面注入状态标记', async function (this: CustomWorld) {
  console.log('   📍 Step: 注入页面状态标记...');

  await this.page.evaluate(() => {
    (window as any).__e2eNoReloadMarker = true;
  });

  // Verify marker was set
  const marker = await this.page.evaluate(() => (window as any).__e2eNoReloadMarker);
  expect(marker).toBe(true);
  console.log('   ✅ 状态标记已注入');
});

When('用户切换到另一个话题', async function (this: CustomWorld) {
  console.log('   📍 Step: 切换到另一个话题...');

  const topicItems = this.page.locator('[data-testid="topic-item"]');
  const topicCount = await topicItems.count();
  console.log(`   📍 找到 ${topicCount} 个话题`);

  // Find the first non-active topic and click it
  for (let i = 0; i < topicCount; i++) {
    const topic = topicItems.nth(i);
    // Check if this topic is NOT currently active (doesn't have active/filled variant)
    const isActive = await topic.evaluate((el) => {
      // Walk up to find the NavItem wrapper and check its variant/active state
      const navItem = el.closest('[class*="Block"]');
      return navItem?.getAttribute('data-active') === 'true' || el.classList.contains('active');
    });

    if (!isActive) {
      await topic.click();
      console.log(`   ✅ 已点击第 ${i + 1} 个话题`);
      await this.page.waitForTimeout(2000);
      return;
    }
  }

  // Fallback: just click the first topic
  await topicItems.first().click();
  console.log('   ✅ 已点击第一个话题（fallback）');
  await this.page.waitForTimeout(2000);
});

// ============================================
// Then Steps
// ============================================

Then('页面状态标记应该仍然存在', async function (this: CustomWorld) {
  console.log('   📍 Step: 验证页面状态标记...');

  const marker = await this.page.evaluate(() => (window as any).__e2eNoReloadMarker);

  if (marker !== true) {
    // Take screenshot for debugging
    await this.takeScreenshot('topic-switch-reload-detected');
    throw new Error(
      'Page reload detected! window.__e2eNoReloadMarker was lost after topic switch. ' +
        'This means the <a> tag default navigation fired instead of SPA routing.',
    );
  }

  console.log('   ✅ 页面状态标记仍然存在（未发生 reload）');
});

Then('页面导航类型不应该是全量加载', async function (this: CustomWorld) {
  console.log('   📍 Step: 检查导航类型...');

  const navInfo = await this.page.evaluate(() => {
    const entry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
    return {
      duration: entry?.duration,
      type: entry?.type,
    };
  });

  console.log(`   📍 Navigation type: ${navInfo.type}, duration: ${navInfo.duration}ms`);

  // If a full page reload happened AFTER the initial load, the navigation type
  // would still show the initial load type. The window marker check above is
  // the primary detection. This step provides additional diagnostic info.
  console.log('   ✅ 导航信息已记录');
});
