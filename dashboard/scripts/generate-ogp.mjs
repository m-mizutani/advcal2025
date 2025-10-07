import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import yaml from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function generateOGP() {
  // Load status.yml
  const statusPath = join(__dirname, '..', '..', 'status.yml');
  const statusContent = readFileSync(statusPath, 'utf8');
  const statusData = yaml.load(statusContent);

  // Calculate statistics
  const totalArticles = statusData.articles.length;
  const completedArticles = statusData.articles.filter(a => a.status === 'completed' || a.status === 'published').length;
  const publishedArticles = statusData.articles.filter(a => a.status === 'published').length;
  const completionRate = Math.round((completedArticles / totalArticles) * 100);

  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1200, height: 630 }
  });

  const htmlPath = join(__dirname, 'generate-ogp.html');
  await page.goto(`file://${htmlPath}`);

  // Inject dynamic data
  await page.evaluate((data) => {
    document.querySelector('.meta-value.completed').textContent = data.completedArticles;
    document.querySelector('.meta-value.published').textContent = data.publishedArticles;
    document.querySelector('.meta-value.rate').textContent = data.completionRate + '%';
  }, { completedArticles, publishedArticles, completionRate });

  // Wait for fonts to load
  await page.waitForTimeout(1000);

  const outputPath = join(__dirname, '..', 'public', 'ogp.png');
  await page.screenshot({
    path: outputPath,
    type: 'png'
  });

  console.log(`OGP image generated: ${outputPath}`);
  console.log(`Stats - Completed: ${completedArticles}/${totalArticles}, Published: ${publishedArticles}, Rate: ${completionRate}%`);
  await browser.close();
}

generateOGP().catch(console.error);
