// 走本地代理的无头浏览器抓取脚本
// 用法:
//   node scripts/fetch-page.mjs <url> [--screenshot out.png] [--html] [--wait 3000] [--no-proxy]
// 默认输出渲染后的正文文本；--html 输出完整 DOM；--screenshot 存整页截图。

import { chromium } from 'playwright';

const args = process.argv.slice(2);
const url = args[0];
if (!url) {
  console.error('用法: node scripts/fetch-page.mjs <url> [--screenshot out.png] [--html] [--wait 3000] [--no-proxy]');
  process.exit(1);
}

const getFlag = (name) => {
  const i = args.indexOf(name);
  return i !== -1 ? (args[i + 1] ?? true) : undefined;
};

const shotPath = getFlag('--screenshot');
const wantHtml = args.includes('--html');
const waitMs = Number(getFlag('--wait') ?? 2500);
const noProxy = args.includes('--no-proxy');

const PROXY = 'socks5://127.0.0.1:7897';

const launchOpts = { headless: true };
if (!noProxy) launchOpts.proxy = { server: PROXY };

const browser = await chromium.launch(launchOpts);
try {
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForTimeout(waitMs);

  if (shotPath && typeof shotPath === 'string') {
    await page.screenshot({ path: shotPath, fullPage: true });
    console.error(`[截图已保存] ${shotPath}`);
  }

  if (wantHtml) {
    console.log(await page.content());
  } else {
    const text = await page.evaluate(() => document.body?.innerText ?? '');
    console.log(`TITLE: ${await page.title()}`);
    console.log('---');
    console.log(text);
  }
} catch (err) {
  console.error(`[抓取失败] ${err.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
