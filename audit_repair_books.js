const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT_DIR = __dirname;
const BOOKS_DIR = path.join(ROOT_DIR, 'books');
const CRAWLER_SCRIPT = path.join(ROOT_DIR, 'crawl_book_content.js');

const argv = process.argv.slice(2);
const hasArg = (name) => argv.includes(name);
const getArgValue = (prefix, fallback) => {
    const item = argv.find((x) => x.startsWith(prefix));
    if (!item) return fallback;
    return item.slice(prefix.length);
};

const DRY_RUN = hasArg('--dry-run');
const RECRAWL = !hasArg('--no-recrawl');
const BATCH_SIZE = Math.max(1, Number(getArgValue('--batch-size=', '20')) || 20);

function extractIdFromFileName(fileName) {
    const match = fileName.match(/_(\d+)\.json$/i);
    return match ? Number(match[1]) : null;
}

function readTextFileSafe(filePath) {
    try {
        return fs.readFileSync(filePath, 'utf8');
    } catch (_) {
        return '';
    }
}

function isNonEmptyTextFile(filePath) {
    if (!fs.existsSync(filePath)) return false;
    const content = readTextFileSafe(filePath);
    return content.trim().length > 0;
}

function getBookId(data, fileName) {
    const id = Number(data?.item_id || data?.input_book?.id || extractIdFromFileName(fileName));
    return Number.isFinite(id) && id > 0 ? id : null;
}

function getChapterTexts(data) {
    const chapters = Array.isArray(data?.chapters) ? data.chapters : [];
    return chapters
        .map((c) => (typeof c?.text === 'string' ? c.text.trim() : ''))
        .filter(Boolean);
}

function chunkArray(arr, size) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
    }
    return chunks;
}

function hasContentForId(id, idToJsonFiles) {
    const files = idToJsonFiles.get(id) || [];

    for (const jsonPath of files) {
        try {
            const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
            const chapterTexts = getChapterTexts(data);
            const fullText = typeof data?.full_text === 'string' ? data.full_text.trim() : '';
            const txtPath = jsonPath.replace(/\.json$/i, '.txt');
            const txtOk = isNonEmptyTextFile(txtPath);

            if ((fullText || chapterTexts.length > 0) && txtOk) {
                return true;
            }
        } catch (_) {
            // ignore and continue
        }
    }

    return false;
}

function runRecrawl(ids) {
    if (ids.length === 0) return { batches: 0, failedBatches: 0 };

    const batches = chunkArray(ids, BATCH_SIZE);
    let failedBatches = 0;

    for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        console.log(`\n[Re-crawl batch ${i + 1}/${batches.length}] ${batch.length} IDs`);

        const env = {
            ...process.env,
            BOOK_IDS: batch.join(','),
            SKIP_EXISTING: '0',
            MAX_BOOKS: '0'
        };

        const result = spawnSync(process.execPath, [CRAWLER_SCRIPT], {
            cwd: ROOT_DIR,
            env,
            stdio: 'inherit'
        });

        if (result.status !== 0) {
            failedBatches++;
            console.warn(`[Warn] Batch ${i + 1} exit code: ${result.status}`);
        }
    }

    return { batches: batches.length, failedBatches };
}

(function main() {
    if (!fs.existsSync(BOOKS_DIR)) {
        console.error(`Không tìm thấy thư mục books: ${BOOKS_DIR}`);
        process.exit(1);
    }

    const jsonFiles = fs
        .readdirSync(BOOKS_DIR)
        .filter((name) => name.toLowerCase().endsWith('.json'))
        .map((name) => path.join(BOOKS_DIR, name));

    const stats = {
        totalJson: jsonFiles.length,
        rebuiltFullText: 0,
        fixedTxt: 0,
        unresolvedCount: 0,
        invalidJson: 0
    };

    const unresolvedIds = new Set();
    const idToJsonFiles = new Map();

    for (const jsonPath of jsonFiles) {
        const fileName = path.basename(jsonPath);
        const txtPath = jsonPath.replace(/\.json$/i, '.txt');

        let data;
        try {
            data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        } catch (error) {
            stats.invalidJson++;
            console.warn(`[Warn] JSON lỗi, bỏ qua: ${fileName} (${error?.message || String(error)})`);
            continue;
        }

        const bookId = getBookId(data, fileName);
        if (bookId) {
            if (!idToJsonFiles.has(bookId)) idToJsonFiles.set(bookId, []);
            idToJsonFiles.get(bookId).push(jsonPath);
        }

        const chapterTexts = getChapterTexts(data);
        const rebuiltText = chapterTexts.join('\n\n').trim();
        const fullText = typeof data?.full_text === 'string' ? data.full_text.trim() : '';
        const txtOk = isNonEmptyTextFile(txtPath);

        let changedJson = false;
        let txtContentToWrite = '';

        if (!fullText && rebuiltText) {
            data.full_text = rebuiltText;
            changedJson = true;
            stats.rebuiltFullText++;
        }

        const effectiveText =
            (typeof data?.full_text === 'string' ? data.full_text.trim() : '') || rebuiltText;

        if (!txtOk && effectiveText) {
            txtContentToWrite = effectiveText;
            stats.fixedTxt++;
        }

        if (!DRY_RUN) {
            if (changedJson) {
                fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf8');
            }
            if (txtContentToWrite) {
                fs.writeFileSync(txtPath, txtContentToWrite, 'utf8');
            }
        }

        const stillMissingContent = !effectiveText;
        const stillMissingTxt = !txtOk && !txtContentToWrite;

        if ((stillMissingContent || stillMissingTxt) && bookId) {
            unresolvedIds.add(bookId);
        }
    }

    stats.unresolvedCount = unresolvedIds.size;

    console.log('\n=== AUDIT SUMMARY ===');
    console.log(`JSON scanned: ${stats.totalJson}`);
    console.log(`Rebuilt full_text from chapters: ${stats.rebuiltFullText}${DRY_RUN ? ' (dry-run)' : ''}`);
    console.log(`Fixed missing/empty TXT: ${stats.fixedTxt}${DRY_RUN ? ' (dry-run)' : ''}`);
    console.log(`Invalid JSON skipped: ${stats.invalidJson}`);
    console.log(`Unresolved books: ${stats.unresolvedCount}`);

    const unresolvedList = Array.from(unresolvedIds).sort((a, b) => a - b);
    if (unresolvedList.length > 0) {
        console.log(`Unresolved IDs: ${unresolvedList.join(', ')}`);
    }

    if (DRY_RUN || !RECRAWL || unresolvedList.length === 0) {
        process.exit(0);
    }

    const recrawlResult = runRecrawl(unresolvedList);

    const remaining = unresolvedList.filter((id) => !hasContentForId(id, idToJsonFiles));

    console.log('\n=== RE-CRAWL SUMMARY ===');
    console.log(`Batches: ${recrawlResult.batches}`);
    console.log(`Failed batches: ${recrawlResult.failedBatches}`);
    console.log(`Remaining unresolved after re-crawl: ${remaining.length}`);
    if (remaining.length > 0) {
        console.log(`Remaining IDs: ${remaining.join(', ')}`);
        process.exitCode = 1;
    }
})();
