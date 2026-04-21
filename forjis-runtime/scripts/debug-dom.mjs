import { chromium } from 'playwright';

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1680, height: 1050 } });
await context.addInitScript(() => { window.setInterval = () => 0; });
const page = await context.newPage();
await page.goto('http://127.0.0.1:4242', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

const info = await page.evaluate(() => {
  const articles = document.querySelectorAll('article');
  if (articles.length === 0) return { error: 'no articles' };
  const first = articles[0];
  const copyBtns = first.querySelectorAll('button[aria-label^="Copy branch"]');
  const allBtns = first.querySelectorAll('button');
  return {
    articleCount: articles.length,
    firstArticleClass: first.className,
    copyBtnCount: copyBtns.length,
    allBtnCount: allBtns.length,
    allBtnLabels: Array.from(allBtns).map((b) => b.getAttribute('aria-label')),
    branchLikeClasses: Array.from(first.querySelectorAll('*'))
      .map((el) => el.className)
      .filter((c) => typeof c === 'string' && /branch/i.test(c))
      .slice(0, 10),
    firstArticleHtml: first.outerHTML.slice(0, 1200),
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
