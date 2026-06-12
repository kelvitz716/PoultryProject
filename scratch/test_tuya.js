const crypto = require('crypto');
const http = require('https');

const fs = require('fs');
const path = require('path');

// Load environment configurations locally if .env file exists
const dotenvPath = path.join(__dirname, '../.env');
if (fs.existsSync(dotenvPath)) {
    const envConfig = fs.readFileSync(dotenvPath, 'utf8');
    envConfig.split('\n').forEach(line => {
        const parts = line.split('=');
        if (parts.length >= 2) {
            const key = parts[0].trim();
            const value = parts.slice(1).join('=').trim().replace(/(^['"]|['"]$)/g, '');
            process.env[key] = value;
        }
    });
}

const clientId = process.env.TUYA_CLIENT_ID;
const secret = process.env.TUYA_CLIENT_SECRET;
const deviceId = process.env.TUYA_DEVICE_ID;
const region = 'eu';
const baseUrl = `openapi.tuya${region}.com`;

function sign(clientId, secret, t, nonce, stringToSign, accessToken = '') {
    const str = accessToken 
        ? clientId + accessToken + t + nonce + stringToSign 
        : clientId + t + nonce + stringToSign;
    return crypto.createHmac('sha256', secret).update(str, 'utf8').digest('hex').toUpperCase();
}

function request(method, path, body = null, accessToken = '') {
    return new Promise((resolve, reject) => {
        const t = Date.now().toString();
        const nonce = crypto.randomUUID();
        
        const bodyStr = body ? JSON.stringify(body) : '';
        const contentHash = crypto.createHash('sha256').update(bodyStr, 'utf8').digest('hex');
        
        const stringToSign = `${method}\n${contentHash}\n\n${path}`;
        const signature = sign(clientId, secret, t, nonce, stringToSign, accessToken);
        
        const headers = {
            'client_id': clientId,
            'sign': signature,
            't': t,
            'sign_method': 'HMAC-SHA256',
            'nonce': nonce,
            'Content-Type': 'application/json'
        };
        
        if (accessToken) {
            headers['access_token'] = accessToken;
        }
        
        const req = http.request({
            hostname: baseUrl,
            port: 443,
            path: path,
            method: method,
            headers: headers
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    resolve(parsed);
                } catch (e) {
                    reject(new Error(`Invalid JSON response: ${data}`));
                }
            });
        });
        
        req.on('error', reject);
        if (bodyStr) {
            req.write(bodyStr);
        }
        req.end();
    });
}

async function test() {
    try {
        console.log('Fetching access token...');
        const tokenRes = await request('GET', '/v1.0/token?grant_type=1');
        console.log('Token Response:', JSON.stringify(tokenRes, null, 2));
        
        if (!tokenRes.success) {
            throw new Error(`Token request failed: ${tokenRes.msg}`);
        }
        
        const accessToken = tokenRes.result.access_token;
        console.log('Successfully fetched access token:', accessToken);
        
        console.log(`Fetching device status for ${deviceId}...`);
        const statusRes = await request('GET', `/v1.0/devices/${deviceId}/status`, null, accessToken);
        console.log('Status Response:', JSON.stringify(statusRes, null, 2));
        
        console.log(`Fetching device details for ${deviceId}...`);
        const detailRes = await request('GET', `/v1.0/devices/${deviceId}`, null, accessToken);
        console.log('Detail Response:', JSON.stringify(detailRes, null, 2));
    } catch (err) {
        console.error('Test failed:', err);
    }
}

test();
