const fs = require('fs');
const puppeteer = require('puppeteer');
const path = require('path');
const JSZip = require('jszip');

const OUTPUT_DIR = path.join(__dirname, 'output');
const BOOKS_DIR = path.join(__dirname, 'books');

if (!fs.existsSync(BOOKS_DIR)) {
    fs.mkdirSync(BOOKS_DIR);
}

// Hàm giải mã và extract text từ file epub (blob buffer)
async function extractEpubText(buffer) {
    try {
        const zip = new JSZip();
        const zipContent = await zip.loadAsync(buffer);
        let fullText = '';

        // Duyệt qua tất cả các file HTML/XHTML trong epub
        for (const [filename, fileObj] of Object.entries(zipContent.files)) {
            if (filename.match(/\.(html|xhtml|xml)$/i) && !fileObj.dir) {
                const content = await fileObj.async("string");
                // Regex đơn giản loại bỏ tag HTML để lấy text
                const textOnly = content.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                                        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                                        .replace(/<\/?[^>]+(>|$)/g, " ")
                                        .replace(/\s+/g, ' ').trim();
                if (textOnly) {
                    fullText += textOnly + '\n\n';
                }
            }
        }
        return fullText;
    } catch (err) {
        console.error("Error extracting EPUB:", err.message);
        return null;
    }
}

(async () => {
    // Đọc một file JSON danh sách sách làm ví dụ (bạn có thể lặp qua tất cả file trong thư mục output)
    const sampleCategoryFile = path.join(OUTPUT_DIR, 'Sách điện tử_Chứng khoán - Bất động sản - Đầu tư_371.json');
    if (!fs.existsSync(sampleCategoryFile)) {
        console.error(`Không tìm thấy file danh sách sách: ${sampleCategoryFile}`);
        return;
    }

    const books = JSON.parse(fs.readFileSync(sampleCategoryFile, 'utf8'));
    console.log(`Đã load ${books.length} sách để crawl nội dung.`);

    console.log('Launching browser...');
    // Cần headless: false hoặc thay đổi UserAgent để dễ bypass bot detection nếu Waka chặn
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security']
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Tối ưu chặn load ảnh/font/css trong quá trình đọc
    await page.setRequestInterception(true);
    page.on('request', req => {
        if (['image', 'font', 'media'].includes(req.resourceType())) {
            req.abort();
        } else {
            req.continue();
        }
    });

    console.log('Navigating to waka.vn to initialize session...');
    await page.goto('https://waka.vn', { waitUntil: 'domcontentloaded', timeout: 60000 });

    // YÊU CẦU QUAN TRỌNG: Để đọc full sách, bạn cần Đăng Nhập tài khoản VIP Waka
    // Hiện tại chạy ẩn danh (Guest) thì Waka chỉ cho tải nội dung đọc thử (vài chương đầu)
    console.log("CHÚ Ý: Crawler đang chạy ở chế độ Khách. Chỉ cào được các chương Đọc Thử hoặc sách Miễn phí.");
    console.log("Để cào full, bạn cần truyền Cookie tài khoản VIP Waka vào page.setCookie() trước bước này.");

    for (let i = 0; i < books.length; i++) {
        const book = books[i];
        console.log(`\n[${i+1}/${books.length}] Đang crawl nội dung sách: ${book.title} (ID: ${book.id})`);

        // Tạo slug URL theo chuẩn Waka (waka.vn/ebook/ten-sach-slug-id.html)
        // Lưu ý: Tên sách trên url không cần quá chính xác, Waka chủ yếu parse dựa vào ID ở cuối.
        const bookReadUrl = `https://waka.vn/doc-sach/${book.id}`;

        let bookContentBuffer = null;

        // Định nghĩa handler lắng nghe response API
        const responseHandler = async (response) => {
            const url = response.url();
            // Bắt API trả về nội dung sách
            if (url.includes('/super/getDownloadItemWeb') && url.includes('content_type=book')) {
                try {
                    const status = response.status();
                    if (status !== 200) {
                        console.log(`   [Cảnh báo] API trả về status ${status}`);
                        return;
                    }
                    const json = await response.json();
                    if (json.code === 0 && json.data) {
                        // json.data thường là URL tải file epub/html đã ký, hoặc là cục dữ liệu base64
                        // Ta cần fetch URL tải file này
                        console.log(`   [API] Đã bắt được link tải nội dung: ${json.data.substring(0, 50)}...`);

                        // Nếu Waka trả về link tải thẳng (thường là epub)
                        if (json.data.startsWith('http')) {
                             const downloadRes = await fetch(json.data);
                             if (downloadRes.ok) {
                                 bookContentBuffer = await downloadRes.arrayBuffer();
                             } else {
                                 console.log("   [Lỗi] Không thể tải file từ link của Waka");
                             }
                        } else {
                             // Nếu trả về text hoặc html trực tiếp
                             bookContentBuffer = json.data;
                        }
                    } else {
                        console.log(`   [Lỗi API] ${json.message || 'Không có data'}`);
                    }
                } catch (e) {
                    console.error("   [Lỗi bắt Response]", e.message);
                }
            }
        };

        // Gắn sự kiện lắng nghe
        page.on('response', responseHandler);

        try {
            // Mở trang đọc sách, Waka JS sẽ tự động generate secure_code và gọi API getDownloadItemWeb
            await page.goto(bookReadUrl, { waitUntil: 'networkidle2', timeout: 30000 });

            // Đợi vài giây để API gọi và tải file xong
            await new Promise(r => setTimeout(r, 5000));

            if (bookContentBuffer) {
                const safeTitle = book.title.replace(/[\/\\?%*:|"<>]/g, '-');
                const filePathText = path.join(BOOKS_DIR, `${safeTitle}_${book.id}.txt`);
                const filePathRaw = path.join(BOOKS_DIR, `${safeTitle}_${book.id}.epub`);

                if (bookContentBuffer instanceof ArrayBuffer) {
                    // Lưu file Raw (epub)
                    const buffer = Buffer.from(bookContentBuffer);
                    fs.writeFileSync(filePathRaw, buffer);

                    // Giải nén và lưu file Text
                    console.log(`   Tiến hành giải nén EPUB...`);
                    const text = await extractEpubText(buffer);
                    if (text) {
                        fs.writeFileSync(filePathText, text);
                        console.log(`   => Đã lưu nội dung (Text) vào: ${filePathText}`);
                    } else {
                        console.log(`   => Đã lưu file gốc (Epub) vào: ${filePathRaw}. Không giải nén được text.`);
                    }
                } else if (typeof bookContentBuffer === 'string') {
                     // Nếu API trả thẳng HTML/Text
                     fs.writeFileSync(filePathText, bookContentBuffer);
                     console.log(`   => Đã lưu nội dung trực tiếp vào: ${filePathText}`);
                }
            } else {
                console.log(`   [Thất bại] Không bắt được dữ liệu nội dung từ trang đọc.`);
                // Có thể sách yêu cầu VIP hoặc mã ID sách trên URL chưa đúng
            }

        } catch (err) {
            console.error(`   [Lỗi Crawl] Timeout hoặc sự cố: ${err.message}`);
        } finally {
            // Gỡ sự kiện để không bị trùng lặp ở vòng lặp sau
            page.off('response', responseHandler);
        }

        // Nghỉ 3-5 giây giữa các cuốn sách để tránh Rate Limit (rất quan trọng)
        const delay = 3000 + Math.random() * 2000;
        console.log(`   Đợi ${(delay/1000).toFixed(1)}s để tránh Rate Limit...`);
        await new Promise(r => setTimeout(r, delay));
    }

    console.log('\nHoàn tất quá trình cào nội dung sách!');
    await browser.close();
})();
