const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const app = express();

// ========== CONFIG ==========
const PUSATWA_BASE = 'https://pusatwa.com/api/user/devices';
const DEFAULT_DELAY = 1000;

// ========== MIDDLEWARE ==========
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ========== HELPER FUNCTIONS ==========

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Generate browser-like headers
const getHeaders = (isBrowser = true) => {
    // 🔥 FIX: .trim() otomatis buang \r, \n, atau spasi tersembunyi di token
    const token = (process.env.WA_TOKEN || '').trim();

    const base = {
        'accept': '*/*',
        'authorization': token,
        'content-type': 'application/json',
        'user-agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Mobile Safari/537.36'
    };

    if (isBrowser) {
        return {
            ...base,
            'sec-ch-ua': '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
            'sec-ch-ua-mobile': '?1',
            'sec-ch-ua-platform': '"Android"',
            'origin': 'https://pusatwa.com',
            'referer': 'https://pusatwa.com/user/devices',
            'sec-fetch-site': 'same-origin',
            'sec-fetch-mode': 'cors',
            'sec-fetch-dest': 'empty',
            'accept-encoding': 'gzip, deflate, br, zstd',
            'accept-language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
            'priority': 'u=1, i'
        };
    }
    return base;
};

// Fetch with retry logic
const fetchWithRetry = async (url, options = {}, retries = 3, backoff = 1000) => {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const response = await fetch(url, {
                ...options,
                headers: {
                    ...getHeaders(options.browserMode !== false),
                    ...(options.headers || {})
                }
            });
            
            if (response.status === 429) {
                const retryAfter = response.headers.get('retry-after') || backoff * attempt;
                await delay(parseInt(retryAfter));
                continue;
            }
            
            return response;
        } catch (error) {
            console.warn(`[Fetch Retry ${attempt}/${retries}] ${url} - ${error.message}`);
            if (attempt === retries) throw error;
            await delay(backoff * attempt);
        }
    }
};

// Validasi nomor WhatsApp
const validatePhone = (phone) => {
    if (!phone) return false;
    const cleaned = phone.replace(/\D/g, '');
    return /^62\d{9,13}$/.test(cleaned) || /^8\d{9,13}$/.test(cleaned);
};

// Format nomor ke format 62
const formatPhone = (phone) => {
    const cleaned = phone.replace(/\D/g, '');
    if (cleaned.startsWith('0')) return '62' + cleaned.slice(1);
    if (cleaned.startsWith('62')) return cleaned;
    return cleaned;
};

// ========== ROUTES ==========

// 🏠 Root endpoint
app.get('/', (req, res) => {
    res.json({
        status: '🟢 API Online',
        service: 'PusatWA Bridge',
        version: '2.1.0',
        timestamp: new Date().toISOString(),
        endpoints: [
            'GET /api/pair?no=628xxx&name=DeviceName&mode=off',
            'GET /api/qr?name=DeviceName',
            'GET /api/devices',
            'GET /api/mode?id=dev_xxx&mode=on',
            'GET /api/check-status?id=DeviceName',
            'GET /api/user/dashboard'
        ]
    });
});

// 🔐 Endpoint 1: Request Pairing Code
app.get('/api/pair', async (req, res) => {
    const { no, name, mode } = req.query;
    
    if (!no) return res.status(400).json({ error: 'Parameter "no" (nomor WhatsApp) wajib diisi' });
    if (!validatePhone(no)) return res.status(400).json({ error: 'Format nomor tidak valid. Gunakan format: 628xxx atau 08xxx' });
    if (!process.env.WA_TOKEN) return res.status(500).json({ error: 'WA_TOKEN belum dikonfigurasi di environment variables' });

    const phoneNumber = formatPhone(no);
    const deviceName = name || `WACUAN-WA-${phoneNumber.slice(-6)}`;
    const modePilihan = mode || 'off';

    try {
        console.log(`[PAIR] Memulai pairing untuk ${phoneNumber}...`);

        const createRes = await fetchWithRetry(`${PUSATWA_BASE}`, {
            method: 'POST',
            body: JSON.stringify({ name: deviceName }),
            browserMode: true
        });
        const createData = await createRes.json();
        
        if (!createRes.ok) {
            console.error('[PAIR] Create device failed:', createData);
            return res.status(createRes.status).json({ error: 'Gagal membuat sesi perangkat', detail: createData });
        }

        const deviceId = createData.id || createData.data?.id;
        if (!deviceId) return res.status(400).json({ error: 'Device ID tidak ditemukan', detail: createData });

        await delay(DEFAULT_DELAY);

        await fetchWithRetry(`${PUSATWA_BASE}/${deviceId}/scan-qr`, {
            method: 'POST',
            browserMode: true
        }).catch(err => console.warn('[PAIR] Scan-QR bypass warning:', err.message));

        await delay(800);

        await fetchWithRetry(`${PUSATWA_BASE}/${deviceId}/mode`, {
            method: 'PUT',
            body: JSON.stringify({ mode: modePilihan }),
            browserMode: true
        }).catch(err => console.warn('[PAIR] Set mode warning:', err.message));

        await delay(DEFAULT_DELAY);

        const pairRes = await fetchWithRetry(`${PUSATWA_BASE}/${deviceId}/pair`, {
            method: 'POST',
            body: JSON.stringify({ phone: phoneNumber }),
            browserMode: true
        });
        const pairData = await pairRes.json();

        if (!pairRes.ok) {
            console.error('[PAIR] Pairing failed:', pairData);
            return res.status(pairRes.status).json({ error: 'Gagal mendapatkan kode pairing', detail: pairData });
        }

        console.log(`[PAIR] Success: ${deviceId}`);
        res.json({
            success: true,
            device_id: deviceId,
            device_name: deviceName,
            phone: phoneNumber,
            pairing_code: pairData.code || pairData.pairing_code,
            ...pairData
        });

    } catch (error) {
        console.error('[PAIR] Critical error:', error);
        res.status(500).json({ error: 'Internal server error', message: error.message, tip: 'Cek log Vercel untuk detail error' });
    }
});

// 📱 Endpoint 2: Generate QR Code
app.get('/api/qr', async (req, res) => {
    const { name } = req.query;
    
    if (!process.env.WA_TOKEN) return res.status(500).json({ error: 'WA_TOKEN belum dikonfigurasi' });

    const deviceName = name || `WACUAN-QR-${Date.now()}`;

    try {
        console.log(`[QR] Generating QR for ${deviceName}...`);

        const createRes = await fetchWithRetry(`${PUSATWA_BASE}`, {
            method: 'POST',
            body: JSON.stringify({ name: deviceName }),
            browserMode: true
        });
        const createData = await createRes.json();
        
        if (!createRes.ok) return res.status(createRes.status).json({ error: 'Gagal membuat sesi', detail: createData });

        const deviceId = createData.id || createData.data?.id;
        if (!deviceId) return res.status(400).json({ error: 'Device ID tidak ditemukan' });

        await delay(DEFAULT_DELAY);

        await fetchWithRetry(`${PUSATWA_BASE}/${deviceId}/scan-qr`, {
            method: 'POST',
            browserMode: true
        }).catch(err => console.warn('[QR] Trigger warning:', err.message));

        await delay(1500);

        const qrRes = await fetchWithRetry(`${PUSATWA_BASE}/${deviceId}/qr`, {
            method: 'GET',
            browserMode: true
        });
        const qrData = await qrRes.json();

        if (!qrRes.ok) return res.status(qrRes.status).json({ error: 'Gagal mengambil QR', detail: qrData });

        console.log(`[QR] Success: ${deviceId}`);
        res.json({
            success: true,
            device_id: deviceId,
            device_name: deviceName,
            qr_code: qrData.qr || qrData.code || qrData.data?.qr,
            ...qrData
        });

    } catch (error) {
        console.error('[QR] Critical error:', error);
        res.status(500).json({ error: 'Gagal generate QR', message: error.message });
    }
});

// 📊 Endpoint 3: Get All Devices
app.get('/api/devices', async (req, res) => {
    if (!process.env.WA_TOKEN) return res.status(500).json({ error: 'WA_TOKEN belum dikonfigurasi' });

    try {
        const response = await fetchWithRetry(`${PUSATWA_BASE}`, {
            method: 'GET',
            browserMode: true
        });
        const data = await response.json();

        if (!response.ok) return res.status(response.status).json({ error: 'Gagal mengambil data', detail: data });

        res.json({
            success: true,
            total: data.data?.length || data.length || 0,
            devices: data.data || data || []
        });

    } catch (error) {
        console.error('[DEVICES] Error:', error);
        res.status(500).json({ error: 'Gagal mengambil daftar perangkat', message: error.message });
    }
});

// ⚙️ Endpoint 4: Change Device Mode
app.get('/api/mode', async (req, res) => {
    const { id, mode } = req.query;
    
    if (!id || !mode) return res.status(400).json({ error: 'Parameter "id" dan "mode" wajib diisi' });
    if (!['on', 'off', 'maintenance'].includes(mode.toLowerCase())) return res.status(400).json({ error: 'Mode tidak valid. Pilih: on, off, atau maintenance' });
    if (!process.env.WA_TOKEN) return res.status(500).json({ error: 'WA_TOKEN belum dikonfigurasi' });

    try {
        const response = await fetchWithRetry(`${PUSATWA_BASE}/${id}/mode`, {
            method: 'PUT',
            body: JSON.stringify({ mode: mode.toLowerCase() }),
            browserMode: true
        });
        const data = await response.json();

        if (!response.ok) return res.status(response.status).json({ error: 'Gagal mengubah mode', detail: data });

        res.json({ success: true, device_id: id, mode: mode.toLowerCase(), ...data });

    } catch (error) {
        console.error('[MODE] Error:', error);
        res.status(500).json({ error: 'Gagal mengubah mode', message: error.message });
    }
});

// 🔍 Endpoint 5: Check Device Status
app.get('/api/check-status', async (req, res) => {
    const { id } = req.query;
    
    if (!id) return res.status(400).json({ error: 'Parameter "id" (nama device) wajib diisi' });
    if (!process.env.WA_TOKEN) return res.status(500).json({ error: 'WA_TOKEN belum dikonfigurasi' });

    try {
        const response = await fetchWithRetry(`${PUSATWA_BASE}`, {
            method: 'GET',
            browserMode: true
        });
        const data = await response.json();

        if (!response.ok) return res.status(response.status).json({ error: 'Gagal cek status', detail: data });

        const devices = Array.isArray(data) ? data : (data.data || []);
        const device = devices.find(d => d.name === id || d.id === id);

        if (!device) return res.json({ status: 'not_found', message: `Device dengan id/nama "${id}" tidak ditemukan`, searched: id });

        const isConnected = device.status === 'connected' || device.state === 'connected';
        
        res.json({
            success: true,
            status: isConnected ? 'connected' : 'pending',
            device: {
                id: device.id,
                name: device.name,
                status: device.status,
                phone: device.phone || device.number,
                last_seen: device.lastSeen || device.updated_at
            }
        });

    } catch (error) {
        console.error('[STATUS] Error:', error);
        res.status(500).json({ error: 'Gagal cek status', message: error.message });
    }
});

// 🗑️ Endpoint 6: Delete Device
app.delete('/api/device/:id', async (req, res) => {
    const { id } = req.params;
    
    if (!id) return res.status(400).json({ error: 'Device ID wajib diisi' });
    if (!process.env.WA_TOKEN) return res.status(500).json({ error: 'WA_TOKEN belum dikonfigurasi' });

    try {
        const response = await fetchWithRetry(`${PUSATWA_BASE}/${id}`, {
            method: 'DELETE',
            browserMode: true
        });
        const data = await response.json();

        if (!response.ok) return res.status(response.status).json({ error: 'Gagal menghapus device', detail: data });

        res.json({ success: true, message: 'Device berhasil dihapus', device_id: id, ...data });

    } catch (error) {
        console.error('[DELETE] Error:', error);
        res.status(500).json({ error: 'Gagal menghapus device', message: error.message });
    }
});

// ==========================================
// 🔥 ENDPOINT BARU: DASHBOARD
// ==========================================
app.get('/api/user/dashboard', async (req, res) => {
    if (!process.env.WA_TOKEN) return res.status(500).json({ error: 'WA_TOKEN belum dikonfigurasi' });

    try {
        console.log('[DASHBOARD] Fetching dashboard data...');

        const response = await fetchWithRetry('https://pusatwa.com/api/user/dashboard', {
            method: 'GET',
            browserMode: true,
            headers: {
                // Override referer khusus dashboard sesuai request HTTP/2 kamu
                'referer': 'https://pusatwa.com/user'
            }
        });

        const data = await response.json();

        if (!response.ok) {
            console.error('[DASHBOARD] PusatWA error:', data);
            return res.status(response.status).json({ error: 'Gagal mengambil data dashboard', detail: data });
        }

        res.json({
            success: true,
            timestamp: new Date().toISOString(),
            data: data.data || data
        });

    } catch (error) {
        console.error('[DASHBOARD] Critical error:', error);
        res.status(500).json({ error: 'Gangguan saat mengambil dashboard', message: error.message });
    }
});

// ❌ 404 Handler
app.use((req, res) => {
    res.status(404).json({ 
        error: 'Endpoint not found', 
        path: req.path,
        hint: 'Gunakan GET / untuk melihat daftar endpoint yang tersedia'
    });
});

// 🌐 Error Handler Global
app.use((err, req, res, next) => {
    console.error('[GLOBAL ERROR]', err);
    res.status(500).json({
        error: 'Internal Server Error',
        message: process.env.NODE_ENV === 'production' ? 'Something went wrong' : err.message,
        ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
    });
});

// 🚀 Export untuk Vercel Serverless
module.exports = app;

// 🖥️ Fallback untuk running lokal
if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`🚀 PusatWA Bridge running on http://localhost:${PORT}`);
    });
}
