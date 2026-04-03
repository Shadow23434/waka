const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const OUTPUT_DIR = path.join(__dirname, 'output');
const BOOKS_DIR = path.join(__dirname, 'books');

// Nếu set INPUT_FILE thì chỉ crawl file đó; nếu không sẽ crawl toàn bộ *.json trong thư mục output
const INPUT_FILE = process.env.INPUT_FILE ? path.resolve(process.env.INPUT_FILE) : null;
const OUTPUT_FILE_FILTER = String(process.env.OUTPUT_FILE_FILTER || '').trim().toLowerCase();
const SKIP_EXISTING = String(process.env.SKIP_EXISTING || '0') === '1';

const MAX_BOOKS = Number(process.env.MAX_BOOKS || 0); // 0 = crawl all
const MAX_STEPS_PER_BOOK = Number(process.env.MAX_STEPS_PER_BOOK || 180);
const BOOK_IDS = String(process.env.BOOK_IDS || '')
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((x) => Number.isFinite(x) && x > 0);

if (!fs.existsSync(BOOKS_DIR)) {
    fs.mkdirSync(BOOKS_DIR);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const safeFileName = (name) => name.replace(/[\/\\?%*:|"<>]/g, '-').trim();

function isDetachedFrameError(error) {
    const msg = String(error?.message || error || '').toLowerCase();
    return msg.includes('detached frame') || msg.includes('execution context was destroyed');
}

async function waitNuxtReady(page) {
    await page.waitForFunction(
        () => window.$nuxt && window.$nuxt.$fetcher && window.$nuxt.$fetcher.getManual,
        { timeout: 30000 }
    );
}

async function configurePage(page) {
    await page.setViewport({ width: 1366, height: 900 });
    await page.setRequestInterception(true);
    page.on('request', (req) => {
        if (['image', 'font', 'media'].includes(req.resourceType())) {
            req.abort();
        } else {
            req.continue();
        }
    });
}

async function createCrawlerPage(browser) {
    const page = await browser.newPage();
    await configurePage(page);
    console.log('Khởi tạo session waka.vn...');
    await page.goto('https://waka.vn', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitNuxtReady(page);
    return page;
}

async function ensurePageAlive(browser, page) {
    if (page && !page.isClosed()) {
        try {
            await page.evaluate(() => true);
            return page;
        } catch (_) {
            // page hỏng / detached, tạo lại
        }
    }

    if (page && !page.isClosed()) {
        try {
            await page.close();
        } catch (_) {
            // ignore
        }
    }

    return createCrawlerPage(browser);
}

async function getItemInfoById(page, itemId) {
    return page.evaluate(async (id) => {
        try {
            const res = await window.$nuxt.$fetcher.getManual('GET_ITEM_INFO', {
                item_id: id,
                content_type: 'book'
            });
            return {
                ok: true,
                code: res?.data?.code,
                message: res?.data?.message,
                data: res?.data?.data || null
            };
        } catch (error) {
            return {
                ok: false,
                code: -1,
                message: error?.message || String(error),
                data: null
            };
        }
    }, itemId);
}

async function clickReadAndCaptureDownload(page, itemId) {
    const responsePromise = page.waitForResponse(
        (response) => {
            const url = response.url();
            return (
                url.includes('/super/getDownloadItemWeb') &&
                url.includes(`item_id=${itemId}`) &&
                url.includes('content_type=book')
            );
        },
        { timeout: 30000 }
    ).catch(() => null);

    const clickInfo = await page.evaluate(() => {
        const normalize = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const preferredLabels = ['Đọc sách', 'Đọc thử', 'Đọc ngay'];

        let target = null;

        // Ưu tiên button trước để tránh click nhầm link menu
        const buttons = Array.from(document.querySelectorAll('button'));
        for (const label of preferredLabels) {
            target = buttons.find((el) => normalize(el.innerText || el.textContent) === label);
            if (target) break;
        }

        if (!target) {
            const candidates = Array.from(document.querySelectorAll('button,a,[role="button"]'));
            for (const label of preferredLabels) {
                target = candidates.find((el) => normalize(el.innerText || el.textContent) === label);
                if (target) break;
            }
        }

        if (!target) {
            return {
                clicked: false,
                reason: 'Không tìm thấy nút Đọc sách/Đọc thử/Đọc ngay'
            };
        }

        const info = {
            clicked: true,
            text: normalize(target.innerText || target.textContent),
            tag: target.tagName,
            className: String(target.className || '').slice(0, 120)
        };

        target.click();
        return info;
    });

    const downloadResponse = await responsePromise;
    let downloadStatus = null;
    let downloadJson = null;

    if (downloadResponse) {
        downloadStatus = downloadResponse.status();
        try {
            downloadJson = await downloadResponse.json();
        } catch (error) {
            downloadJson = {
                code: -1,
                message: `Không parse được JSON: ${error?.message || String(error)}`
            };
        }
    }

    try {
        await page.waitForFunction(() => location.pathname.includes('/reader/'), { timeout: 25000 });
    } catch (_) {
        // Có thể sách bị chặn / yêu cầu mua, không vào reader
    }

    return {
        clickInfo,
        downloadStatus,
        downloadJson,
        currentUrl: page.url(),
        inReader: page.url().includes('/reader/')
    };
}

async function extractReaderSnapshot(page) {
    return page.evaluate(() => {
        const readerState = window.$nuxt?.$store?.state?.reader || {};
        const chapterReading = readerState.chapterReading || {};
        const chapterList = readerState.listChapterReading || [];

        const chapterLabel = chapterList.find((it) =>
            it?.id === chapterReading?.index || it?.href === chapterReading?.href
        )?.label || null;

        const iframe = document.querySelector('iframe[id^="epubjs-view-"]') || document.querySelector('iframe');
        const iframeDoc = iframe?.contentDocument || null;
        const body = iframeDoc?.body || null;

        const chapterText = (body?.innerText || body?.textContent || '')
            .replace(/\u00a0/g, ' ')
            .replace(/\r/g, '')
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();

        const pageText = document.body?.innerText || '';
        const progressMatch = pageText.match(/\b(\d{1,3})%\b/);

        return {
            chapterIndex: chapterReading.index || null,
            chapterHref: chapterReading.href || null,
            chapterUrl: chapterReading.url || null,
            chapterLabel,
            chapterCount: Array.isArray(chapterList) ? chapterList.length : 0,
            progress: progressMatch ? Number(progressMatch[1]) : null,
            text: chapterText
        };
    });
}

async function collectReaderText(page, maxSteps) {
    const chapters = new Map();
    let lastProgress = null;
    let sameProgressCount = 0;

    for (let step = 0; step < maxSteps; step++) {
        const snap = await extractReaderSnapshot(page);

        const chapterKey = snap.chapterIndex || `unknown_step_${step}`;
        if (snap.text && !chapters.has(chapterKey)) {
            chapters.set(chapterKey, {
                chapterIndex: snap.chapterIndex,
                chapterHref: snap.chapterHref,
                chapterUrl: snap.chapterUrl,
                chapterLabel: snap.chapterLabel,
                progress: snap.progress,
                text: snap.text
            });
        }

        if (typeof snap.progress === 'number' && snap.progress === lastProgress) {
            sameProgressCount++;
        } else {
            sameProgressCount = 0;
            lastProgress = snap.progress;
        }

        if (snap.chapterCount > 0 && chapters.size >= snap.chapterCount) {
            break;
        }

        if (typeof snap.progress === 'number' && snap.progress >= 99) {
            break;
        }

        // Tiến trình không thay đổi quá lâu -> dừng để tránh lặp vô hạn
        if (sameProgressCount >= 90) {
            break;
        }

        await page.keyboard.press('ArrowRight');
        await sleep(randomInt(250, 450));
    }

    return Array.from(chapters.values());
}

function getInputFiles() {
    if (INPUT_FILE) {
        if (!fs.existsSync(INPUT_FILE)) {
            throw new Error(`Không tìm thấy file input: ${INPUT_FILE}`);
        }
        return [INPUT_FILE];
    }

    const files = fs
        .readdirSync(OUTPUT_DIR)
        .filter((name) => name.toLowerCase().endsWith('.json'))
        .filter((name) => !OUTPUT_FILE_FILTER || name.toLowerCase().includes(OUTPUT_FILE_FILTER))
        .map((name) => path.join(OUTPUT_DIR, name));

    if (files.length === 0) {
        throw new Error(`Không tìm thấy file JSON nào trong thư mục output${OUTPUT_FILE_FILTER ? ` (filter: ${OUTPUT_FILE_FILTER})` : ''}`);
    }

    return files;
}

function loadBooksFromInputFiles(inputFiles) {
    const booksById = new Map();

    for (const filePath of inputFiles) {
        const raw = fs.readFileSync(filePath, 'utf8');
        let arr;

        try {
            arr = JSON.parse(raw);
        } catch (error) {
            console.warn(`[Warn] Bỏ qua file lỗi JSON: ${filePath} (${error?.message || String(error)})`);
            continue;
        }

        if (!Array.isArray(arr)) {
            console.warn(`[Warn] Bỏ qua file không phải mảng: ${filePath}`);
            continue;
        }

        for (const item of arr) {
            const id = Number(item?.id);
            if (!Number.isFinite(id) || id <= 0) continue;

            if (!booksById.has(id)) {
                booksById.set(id, {
                    ...item,
                    id,
                    __source_files: [filePath]
                });
            } else {
                const existing = booksById.get(id);
                if (!existing.__source_files.includes(filePath)) {
                    existing.__source_files.push(filePath);
                }
            }
        }
    }

    return Array.from(booksById.values()).sort((a, b) => a.id - b.id);
}

function getExistingCrawledBookIds() {
    const done = new Set();

    const files = fs
        .readdirSync(BOOKS_DIR)
        .filter((name) => name.toLowerCase().endsWith('.json'));

    for (const name of files) {
        const match = name.match(/_(\d+)\.json$/i);
        if (match) {
            done.add(Number(match[1]));
        }
    }

    return done;
}

function filterBooksByEnv(books) {
    let filtered = books;

    if (BOOK_IDS.length > 0) {
        const idSet = new Set(BOOK_IDS);
        filtered = filtered.filter((b) => idSet.has(Number(b.id)));
    }

    if (SKIP_EXISTING) {
        const done = getExistingCrawledBookIds();
        filtered = filtered.filter((b) => !done.has(Number(b.id)));
    }

    if (MAX_BOOKS > 0) {
        filtered = filtered.slice(0, MAX_BOOKS);
    }

    return filtered;
}

async function crawlOneBook(page, book, index, total) {
    const startTime = Date.now();

    console.log(`\n[${index + 1}/${total}] ${book.title} (ID: ${book.id})`);

    const output = {
        item_id: book.id,
        title: book.title,
        content_type: book.content_type,
        crawl_time: new Date().toISOString(),
        input_book: book,
        item_info: null,
        read_flow: null,
        chapters: [],
        full_text: ''
    };

    try {
        const itemInfo = await getItemInfoById(page, book.id);
        output.item_info = itemInfo;

        if (!itemInfo.ok || itemInfo.code !== 0 || !itemInfo.data?.detail_url) {
            console.log(`   [Skip] Không lấy được detail_url: ${itemInfo.message || 'Unknown error'}`);
        } else {
            const detailUrl = itemInfo.data.detail_url;
            console.log(`   Detail: ${detailUrl}`);

            await page.goto(detailUrl, { waitUntil: 'networkidle2', timeout: 60000 });
            await sleep(randomInt(700, 1200));

            const readFlow = await clickReadAndCaptureDownload(page, book.id);
            output.read_flow = readFlow;

            if (readFlow.downloadJson) {
                const code = readFlow.downloadJson.code;
                const msg = readFlow.downloadJson.message;
                console.log(`   getDownloadItemWeb => code=${code}, message=${msg}`);
            } else {
                console.log('   [Warn] Không bắt được response getDownloadItemWeb');
            }

            if (readFlow.inReader) {
                await sleep(randomInt(1200, 2000));

                const chapters = await collectReaderText(page, MAX_STEPS_PER_BOOK);
                output.chapters = chapters;
                output.full_text = chapters.map((c) => c.text).filter(Boolean).join('\n\n');

                console.log(`   Reader URL: ${readFlow.currentUrl}`);
                console.log(`   Trích xuất được ${chapters.length} chapter có text`);
            } else {
                console.log('   [Info] Không vào được reader (sách yêu cầu mua hoặc bị chặn)');
            }
        }
    } catch (error) {
        console.log(`   [Lỗi] ${error?.message || String(error)}`);
        output.error = error?.message || String(error);
    }

    const safeTitle = safeFileName(book.title || `book_${book.id}`);
    const basePath = path.join(BOOKS_DIR, `${safeTitle}_${book.id}`);

    fs.writeFileSync(`${basePath}.json`, JSON.stringify(output, null, 2), 'utf8');
    if (output.full_text) {
        fs.writeFileSync(`${basePath}.txt`, output.full_text, 'utf8');
    }

    const spent = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`   => Saved: ${basePath}.json${output.full_text ? ' + .txt' : ''} (${spent}s)`);

    return output;
}

(async () => {
    let browser = null;
    let page = null;

    try {
        const inputFiles = getInputFiles();
        const allBooks = loadBooksFromInputFiles(inputFiles);
        const books = filterBooksByEnv(allBooks);

        console.log(`Input files: ${inputFiles.length}`);
        if (INPUT_FILE) {
            console.log(`Input mode: single file (${INPUT_FILE})`);
        } else {
            console.log(`Input mode: all output JSON${OUTPUT_FILE_FILTER ? ` (filter: ${OUTPUT_FILE_FILTER})` : ''}`);
        }
        console.log(`Đã load ${books.length}/${allBooks.length} sách (unique by id).`);
        if (BOOK_IDS.length > 0) {
            console.log(`Filter BOOK_IDS: ${BOOK_IDS.join(', ')}`);
        }
        if (SKIP_EXISTING) {
            console.log('SKIP_EXISTING=1: Bỏ qua sách đã có file .json trong thư mục books');
        }
        console.log('Launching browser...');

        if (books.length === 0) {
            console.log('Không có sách nào cần crawl theo bộ lọc hiện tại.');
            return;
        }

        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        page = await createCrawlerPage(browser);

        for (let i = 0; i < books.length; i++) {
            const book = books[i];
            let retriedForDetachedFrame = false;

            while (true) {
                page = await ensurePageAlive(browser, page);
                const output = await crawlOneBook(page, book, i, books.length);

                if (output.error && isDetachedFrameError(output.error) && !retriedForDetachedFrame) {
                    retriedForDetachedFrame = true;
                    console.log('   [Retry] Gặp detached frame, khởi tạo lại page và thử lại cuốn này...');

                    if (page && !page.isClosed()) {
                        try {
                            await page.close();
                        } catch (_) {
                            // ignore
                        }
                    }
                    page = await createCrawlerPage(browser);
                    continue;
                }

                break;
            }

            const delay = randomInt(4500, 7500);
            console.log(`   Đợi ${(delay / 1000).toFixed(1)}s để tránh rate limit...`);
            await sleep(delay);
        }

        console.log('\nHoàn tất crawl nội dung sách.');
    } catch (error) {
        console.error(`[Fatal] ${error?.message || String(error)}`);
        process.exitCode = 1;
    } finally {
        if (page && !page.isClosed()) {
            try {
                await page.close();
            } catch (_) {
                // ignore
            }
        }

        if (browser) {
            try {
                await browser.close();
            } catch (error) {
                // Windows + Chromium profile cleanup đôi khi EBUSY, không coi là fail của crawl data
                console.warn(`[Warn] browser.close lỗi: ${error?.message || String(error)}`);
                try {
                    const proc = browser.process();
                    if (proc && !proc.killed) {
                        proc.kill('SIGKILL');
                    }
                } catch (_) {
                    // ignore
                }
            }
        }
    }
})();
