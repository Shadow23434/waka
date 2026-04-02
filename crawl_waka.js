const fs = require('fs');
const puppeteer = require('puppeteer');
const path = require('path');

const GROUP_FILE = path.join(__dirname, 'group.json');
const OUTPUT_DIR = path.join(__dirname, 'output');

if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR);
}

// 1. Load group URLs
const content = fs.readFileSync(GROUP_FILE, 'utf8');
const groupUrls = [...content.matchAll(/"url"\s*:\s*"([^"]+)"/g)].map(m => m[1]);

console.log(`Found ${groupUrls.length} group URLs`);

(async () => {
    console.log('Launching browser...');
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();

    // Disable loading images and CSS to speed up navigation and save memory
    await page.setRequestInterception(true);
    page.on('request', req => {
        if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
            req.abort();
        } else {
            req.continue();
        }
    });

    console.log('Navigating to waka.vn to initialize session and bypass anti-bot protections...');
    // We go to the homepage to initialize Waka's internal logic ($nuxt.$fetcher)
    await page.goto('https://waka.vn', { waitUntil: 'domcontentloaded', timeout: 60000 });

    console.log('Waiting for Waka App instance (window.$nuxt)...');
    await page.waitForFunction('window.$nuxt !== undefined', { timeout: 30000 });

    for (const groupUrl of groupUrls) {
        console.log(`\nProcessing group: ${groupUrl}`);

        // Fetch categories inside browser
        const categories = await page.evaluate(async (url) => {
            try {
                const res = await fetch(url).then(r => r.json());
                if (res && res.data && res.data.category && res.data.category.list) {
                    return res.data.category.list.map(c => ({ id: c.id, name: c.name, title: res.data.category.title }));
                }
            } catch (err) {
                console.error("Error fetching category", err);
            }
            return [];
        }, groupUrl);

        console.log(`Found ${categories.length} categories.`);

        for (const cat of categories) {
            console.log(`\n  -> Crawling category [${cat.id}] ${cat.name}...`);
            let page_no = 1;
            const allBooks = [];
            let consecutiveErrors = 0;

            while (true) {
                console.log(`     Fetching page ${page_no}...`);
                const items = await page.evaluate(async (categoryId, pageNo) => {
                    try {
                        const res = await window.$nuxt.$fetcher.getManual('ITEM_BY_CAT', {
                            category_id: categoryId,
                            page_no: pageNo,
                            page_size: 24,
                            price_filter: 0,
                            is_full: 3,
                            sort: 0,
                            is_brief: 0
                        });

                        if (res && res.data && res.data.data && Array.isArray(res.data.data)) {
                            return res.data.data;
                        }
                    } catch (err) {
                        return { error: err.message };
                    }
                    return null; // Stop
                }, cat.id, page_no);

                if (items && items.error) {
                    console.log(`     API Error: ${items.error}`);
                    consecutiveErrors++;
                    if (consecutiveErrors > 3) {
                        console.log(`     Too many errors. Moving to next category.`);
                        break;
                    }
                    await new Promise(r => setTimeout(r, 2000));
                    continue; // Retry
                }

                consecutiveErrors = 0; // Reset

                if (!items || items.length === 0) {
                    console.log(`     No more items found. Finished category.`);
                    break;
                }

                allBooks.push(...items);
                console.log(`     Got ${items.length} books. Total: ${allBooks.length}`);
                page_no++;

                // Sleep to avoid rate limiting
                await new Promise(r => setTimeout(r, 1000));
            }

            // Save category data
            const safeName = cat.name.replace(/[\/\\?%*:|"<>]/g, '-');
            const safeTitle = cat.title.replace(/[\/\\?%*:|"<>]/g, '-');
            const savePath = path.join(OUTPUT_DIR, `${safeTitle}_${safeName}_${cat.id}.json`);

            fs.writeFileSync(savePath, JSON.stringify(allBooks, null, 2));
            console.log(`  => Saved ${allBooks.length} books to ${savePath}`);
        }
    }

    console.log('\nCrawling completed successfully!');
    await browser.close();
})();