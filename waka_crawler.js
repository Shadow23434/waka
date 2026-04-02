const crypto = require('crypto');
const axios = require('axios');

// Constants
const BASE_URL = 'https://beta-api.waka.vn';
const OS = 'web';
const ID = '1ba301711dfbeaacbe6b431ac942a0bb'; // Random device ID
const ACCOUNT = 'guest';
const PAGE = 'ebook';

// MD5 hashing for the "tid" (which is used as HMAC key)
function getTid(account) {
    return crypto.createHash('md5').update(account).digest('hex');
}

// Function to URL encode a string like JS encodeURIComponent but handling some specific characters if needed
// waka frontend uses a custom encode function k(t): encodeURIComponent(t).replace(/[!'()*]/g, function(t){return"%"+t.charCodeAt(0).toString(16)})
function customEncode(str) {
    if (typeof str !== 'string') {
        str = String(str);
    }
    return encodeURIComponent(str).replace(/[!'()*]/g, function(c) {
        return '%' + c.charCodeAt(0).toString(16);
    });
}

// HMAC-SHA1 to generate secure_code
function generateSecureCode(apiKeys, params, tid) {
    let strToHash = "";
    for (const key of apiKeys) {
        let val = params[key];
        if (typeof val === 'string') {
            val = val.trim();
        }
        strToHash += " " + customEncode(val);
    }
    strToHash = strToHash.slice(1);
    
    // HMAC SHA1
    const hmac = crypto.createHmac('sha1', tid);
    hmac.update(strToHash);
    return hmac.digest('base64');
}

async function getCategories() {
    const apiKeys = ["account", "page", "id", "os"];
    const params = {
        account: ACCOUNT,
        page: PAGE,
        id: ID,
        os: OS
    };
    
    const tid = getTid(ACCOUNT);
    const secureCode = generateSecureCode(apiKeys, params, tid);
    params.secure_code = secureCode;
    
    try {
        const response = await axios.get(`${BASE_URL}/super/listCategoryByPage`, { params });
        if (response.data.code === 0 && response.data.data.category) {
            return response.data.data.category.list;
        }
        throw new Error(response.data.message || 'Failed to fetch categories');
    } catch (error) {
        console.error('Error fetching categories:', error.message);
        return [];
    }
}

async function getBooksByCategory(categoryId, pageNo = 1, pageSize = 24) {
    const apiKeys = ["account", "is_brief", "category_id", "page_no", "page_size", "id", "os"];
    const params = {
        account: ACCOUNT,
        is_brief: 0,
        category_id: categoryId,
        page_no: pageNo,
        page_size: pageSize,
        price_filter: 0,
        is_full: 3,
        sort: 0,
        id: ID,
        os: OS
    };
    
    const tid = getTid(ACCOUNT);
    const secureCode = generateSecureCode(apiKeys, params, tid);
    params.secure_code = secureCode;
    
    try {
        const response = await axios.get(`${BASE_URL}/super/getItemByCat`, { params });
        if (response.data.code === 0) {
            return response.data.data || [];
        } else if (response.data.code === 101) {
             console.log('Session Expired Code 101');
             return [];
        }
        throw new Error(response.data.message || 'Failed to fetch books');
    } catch (error) {
        console.error(`Error fetching books for category ${categoryId} page ${pageNo}:`, error.message);
        return [];
    }
}

async function start() {
    console.log('Fetching categories...');
    const categories = await getCategories();
    console.log(`Found ${categories.length} categories.`);
    
    for (const category of categories) {
        console.log(`\n=== Category: ${category.name} (ID: ${category.id}) ===`);
        let pageNo = 1;
        let hasMore = true;
        let totalBooks = 0;
        
        while (hasMore && pageNo <= 2) { // Just get 2 pages for demo
            console.log(`Fetching page ${pageNo}...`);
            const books = await getBooksByCategory(category.id, pageNo);
            
            if (books.length > 0) {
                totalBooks += books.length;
                console.log(`Got ${books.length} books. Examples:`);
                for (let i = 0; i < Math.min(3, books.length); i++) {
                    console.log(`  - [${books[i].id}] ${books[i].title}`);
                }
                
                if (books.length < 24) {
                    hasMore = false; // Reached end of category
                } else {
                    pageNo++;
                }
            } else {
                hasMore = false;
            }
            
            // Be nice, wait a bit
            await new Promise(r => setTimeout(r, 500));
        }
        console.log(`Total books fetched for ${category.name}: ${totalBooks}`);
        break; // Only do 1 category for demo
    }
}

start();
