// scrape-AUStrainers.js
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const puppeteer = require('puppeteer');
const path = require('path');

// Set Puppeteer to use local cache folder
process.env.PUPPETEER_CACHE_DIR = path.join(__dirname, '.puppeteer-cache');

const SEASON = '2025-2026';

const categories = [
  { name: 'all',        url: 'https://www.racenet.com.au/premierships/trainer/all' },
  { name: 'metro',      url: 'https://www.racenet.com.au/premierships/trainer/metro' },
  { name: 'country',    url: 'https://www.racenet.com.au/premierships/trainer/country' },
  { name: 'provincial', url: 'https://www.racenet.com.au/premierships/trainer/provincial' }
];

const serviceAccount = require('./serviceAccountKey.json');

initializeApp({
  credential: cert(serviceAccount)
});

const db = getFirestore();

async function scrollToLoadMoreRows(page) {
  await page.evaluate(async () => {
    const wrapper = document.querySelector('.premiership-table-wrapper');
    const table = wrapper ? wrapper.querySelector('table.generic-table__table') : null;
    if (!table) return;

    const tbody = table.querySelector('tbody') || table;
    let lastRowCount = 0;
    let attempts = 0;
    const maxAttempts = 30;

    while (attempts < maxAttempts) {
      const currentRows = tbody.querySelectorAll('tr').length;
      if (currentRows === lastRowCount) break;

      lastRowCount = currentRows;
      tbody.scrollTop = tbody.scrollHeight;
      await new Promise(resolve => setTimeout(resolve, 1200));
      attempts++;
    }
  });
}

async function scrapeCategory(page, category) {
  console.log(`\n=== Scraping Trainers: ${category.name.toUpperCase()} ===`);

  try {
    await page.goto(category.url, { 
      waitUntil: 'domcontentloaded', 
      timeout: 90000 
    });

    await new Promise(resolve => setTimeout(resolve, 5000));

    await page.waitForSelector('.premiership-table-wrapper table.generic-table__table', { timeout: 60000 });
    console.log('Table found. Scrolling to load more rows...');

    await scrollToLoadMoreRows(page);

    let trainers = await page.evaluate((season, catName) => {
      const wrapper = document.querySelector('.premiership-table-wrapper');
      const table = wrapper ? wrapper.querySelector('table.generic-table__table') : null;
      if (!table) return [];

      const rows = table.querySelectorAll('tbody tr');
      const data = [];

      rows.forEach(row => {
        const nameLink = row.querySelector('a.profile-link');
        if (!nameLink) return;

        const trainerName = nameLink.textContent.trim();
        const href = nameLink.getAttribute('href');
        const trainerSlug = href.split('/').pop();

        const getText = (selector) => {
          const el = row.querySelector(selector);
          return el ? el.textContent.trim() : '';
        };

        data.push({
          season: season,
          category: catName,
          trainerName,
          trainerSlug,
          profileUrl: `https://www.racenet.com.au${href}`,
          firsts: parseInt(getText('td:nth-child(2)')) || 0,
          seconds: parseInt(getText('td:nth-child(3)')) || 0,
          thirds: parseInt(getText('td:nth-child(4)')) || 0,
          fourths: parseInt(getText('td:nth-child(5)')) || 0,
          fifths: parseInt(getText('td:nth-child(6)')) || 0,
          prizeMoney: parseFloat(getText('td:nth-child(7)').replace(/[$,]/g, '')) || 0,
          strikeRate: parseFloat(getText('td:nth-child(8)').replace('%', '')) || 0,
          starts: parseInt(getText('td:nth-child(9)')) || 0,
          sourceUrl: window.location.href
        });
      });

      return data;
    }, SEASON, category.name);

    trainers = trainers.map(trainer => ({
      ...trainer,
      lastUpdated: FieldValue.serverTimestamp()
    }));

    console.log(`Found ${trainers.length} trainers`);

    const batch = db.batch();
    for (const trainer of trainers) {
      const docId = `${SEASON}_${category.name}_${trainer.trainerSlug}`;
      const docRef = db.collection('AUStrainerPremierships').doc(docId);
      batch.set(docRef, trainer, { merge: true });
    }

    await batch.commit();
    console.log(`✅ Saved ${trainers.length} documents`);

  } catch (error) {
    console.error(`Error scraping ${category.name}:`, error.message);
  }
}

async function main() {
  console.log('Launching browser (Trainers)...');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1400, height: 900 });

  for (const category of categories) {
    await scrapeCategory(page, category);
  }

  await browser.close();
  console.log('\n✅ Finished scraping all Trainer categories.');
}

main().catch(console.error);