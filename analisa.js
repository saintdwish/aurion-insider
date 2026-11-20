// analisa.js - modul Analisa untuk AURION Insider (VPS)
// Pasang di server.js, setelah fungsi authenticate dan sebelum app.listen:
//   require('./analisa')(app, { authenticate, axios, httpsAgent, webpush });

const fs = require('fs');
const path = require('path');

module.exports = function (app, { authenticate, axios, httpsAgent, webpush }) {
    // ================= KONFIGURASI =================
    const AI_KEY = process.env.ANTHROPIC_API_KEY || '';
    const AI_MODEL = process.env.AI_MODEL || 'claude-sonnet-5-5';
    const AI_MOCK = process.env.AI_MOCK === '1' || !AI_KEY;          // tanpa API key otomatis mock
    const DAILY_LIMIT = parseInt(process.env.AI_DAILY_LIMIT || '12', 10);
    const PRICE_URL = process.env.PRICE_URL || 'https://script.google.com/macros/s/AKfycbzZuDUnA32CUSdU194CFo4MXBFk621PFfTeAlrY0IjJB7U2LHwEepP4dLvmDFsKxiCZ/exec';
    const PRICE_OFFSET = parseFloat(process.env.PRICE_OFFSET || '0') || 0;
    const SETUP_TTL_MIN = parseInt(process.env.SETUP_TTL_MIN || '75', 10);     // masa berlaku sebelum entry
    const MAX_IN_TRADE_MIN = parseInt(process.env.MAX_IN_TRADE_MIN || '360', 10); // batas waktu setelah entry
    const GEX_OLD_MIN = parseInt(process.env.GEX_OLD_MIN || '180', 10);         // GEX dianggap lama
    const ICON = 'https://saintdwish.github.io/aurion-insider/icon.png';

    const F = n => path.join(__dirname, n);
    const readJSON = (file, def) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return def; } };
    const writeJSON = (file, v) => fs.writeFileSync(file, JSON.stringify(v, null, 2));

    let log = readJSON(F('analysis_log.json'), []);
    let active = readJSON(F('active_setup.json'), null);
    let subs = readJSON(F('insider_subs.json'), []);
    const saveLog = () => writeJSON(F('analysis_log.json'), log.slice(0, 300));
    const saveActive = () => writeJSON(F('active_setup.json'), active);
    const saveSubs = () => writeJSON(F('insider_subs.json'), subs);

    console.log('[ANALISA] mode:', AI_MOCK ? 'MOCK (tanpa panggilan API)' : 'CLAUDE ' + AI_MODEL,
        '| setup aktif:', active ? active.status : 'tidak ada', '| device push:', subs.length);

    // ================= HELPER =================
    const num = v => { const n = parseFloat(String(v == null ? '' : v).replace(',', '.')); return isFinite(n) ? n : null; };
    const f2 = n => Number(n).toFixed(2);
    const sgn = n => (n > 0 ? '+' : '') + f2(n);
    const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
    const stampNow = () => new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
    const LABEL = { WAIT: 'WAIT', WAITING: 'Menunggu', NEAR: 'Mendekat', ENTRY: 'Entry tersentuh', SL: 'SL kena', CANCELLED: 'Batal', EXPIRED: 'Kedaluwarsa', REPLACED: 'Diganti' };
    const labelOf = r => {
        if (r.status === 'TP') return 'TP' + (r.tpHit || 1) + ' tercapai';
        if (r.status === 'SL' && r.tpHit > 0) return 'TP' + r.tpHit + ' lalu SL';
        if (r.status === 'ENTRY' && r.tpHit > 0) return 'Entry, TP' + r.tpHit + ' tercapai';
        return LABEL[r.status] || r.status;
    };
    const textOf = r => (r.side === 'WAIT' ? 'Tidak ada setup' : `${r.side} ${f2(r.entry)}`) + (r.hasGex ? '' : ' (tanpa GEX)') + (r.mock ? ' (contoh)' : '') + (r.sim ? ' (simulasi)' : '');

    // ================= PUSH KE ADMIN =================
    async function pushAdmin(title, body, tag) {
        if (!subs.length) { console.warn('[PUSH-INSIDER] belum ada device terdaftar'); return; }
        const payload = JSON.stringify({ title, body, icon: ICON, tag: tag || undefined });
        await Promise.all(subs.map(async s => {
            try { await webpush.sendNotification(s, payload, { TTL: 600, urgency: 'high' }); console.log('[PUSH-INSIDER] OK:', title); }
            catch (e) {
                console.error('[PUSH-INSIDER] GAGAL', e.statusCode, e.body || e.message);
                if (e.statusCode === 404 || e.statusCode === 410) { subs = subs.filter(x => x.endpoint !== s.endpoint); saveSubs(); }
            }
        }));
    }

    // ================= MESIN STATUS SETUP =================
    function syncRec(a) {
        const r = log.find(x => x.id === a.id);
        if (r) Object.assign(r, { status: a.status, mae: a.mae, mfe: a.mfe, tpHit: a.tpHit, entryAt: a.entryAt, endedAt: a.endedAt, sim: !!a.sim });
        saveLog();
    }
    function notify(a, msg) { pushAdmin((a.sim ? '[SIMULASI] ' : '') + `${a.side} ${f2(a.entry)}`, msg, 'setup-' + a.id).catch(() => {}); }

    function finish(status, msg, silent) {
        if (!active) return;
        active.status = status; active.endedAt = Date.now();
        syncRec(active);
        if (!silent) notify(active, msg);
        console.log('[SETUP] selesai:', status, '-', msg);
        active = null; saveActive();
    }

    function onPrice(raw) {
        if (!active) return;
        const a = active, p = raw + PRICE_OFFSET, buy = a.side === 'BUY', now = Date.now();
        a.lastPrice = p; a.lastPriceAt = now;

        if (a.status === 'WAITING' || a.status === 'NEAR') {
            if (now > a.expiresAt) return finish('EXPIRED', 'Setup kedaluwarsa, entry tidak tersentuh.');
            const touched = buy ? p <= a.entry : p >= a.entry;
            const ranAway = buy ? p >= a.tps[0] : p <= a.tps[0];
            const dist = buy ? p - a.entry : a.entry - p;
            if (touched) {
                a.status = 'ENTRY'; a.entryAt = now; a.mae = 0; a.mfe = 0; a.tpHit = 0;
                notify(a, `Entry tersentuh di ${f2(p)}. SL ${f2(a.sl)} | TP1 ${f2(a.tps[0])}`);
            } else if (ranAway) {
                return finish('CANCELLED', 'Harga langsung ke TP1 tanpa menyentuh entry. Setup dibatalkan.');
            } else if (a.status === 'WAITING' && dist <= a.nearDist) {
                a.status = 'NEAR';
                notify(a, `Mendekati entry. Jarak ${f2(dist)} poin. SL ${f2(a.sl)} | TP1 ${f2(a.tps[0])}`);
            }
        }

        if (a.status === 'ENTRY') {
            const fav = buy ? p - a.entry : a.entry - p;
            a.mfe = Math.max(a.mfe || 0, fav);
            a.mae = Math.max(a.mae || 0, -fav);
            if (buy ? p <= a.sl : p >= a.sl) return finish('SL', `SL kena di ${f2(p)}.${a.tpHit ? ' (setelah TP' + a.tpHit + ')' : ''}`);
            while (a.tpHit < a.tps.length && (buy ? p >= a.tps[a.tpHit] : p <= a.tps[a.tpHit])) {
                a.tpHit++;
                if (a.tpHit < a.tps.length) notify(a, `TP${a.tpHit} tercapai di ${f2(p)}.`);
            }
            if (a.tpHit >= a.tps.length) return finish('TP', `TP${a.tpHit} tercapai di ${f2(p)}. Setup selesai.`);
            if (now > a.entryAt + MAX_IN_TRADE_MIN * 60000) return finish('EXPIRED', 'Setup sudah terlalu lama berjalan, pelacakan dihentikan.');
        }
        syncRec(a);
    }

    // ---- pemantau harga: hanya bekerja kalau ada setup aktif ----
    let simQ = [], lastFetch = 0;
    async function tick() {
        if (!active) { simQ = []; return; }
        if (simQ.length) return onPrice(simQ.shift());
        if (Date.now() - lastFetch < 6000) return;
        lastFetch = Date.now();
        try {
            const r = await axios.get(PRICE_URL, { timeout: 8000, httpsAgent });
            const p = parseFloat(r.data && r.data.price);
            if (r.data && r.data.status === 'success' && p > 0) onPrice(p);
        } catch (e) { console.error('[MONITOR] ambil harga gagal:', e.message); }
    }
    setInterval(tick, 3000);

    function buildSim(a, mode) {
        const d = a.side === 'BUY' ? 1 : -1, near = a.nearDist, pr = x => +x.toFixed(2);
        const reward = Math.abs(a.tps[0] - a.entry), risk = Math.abs(a.entry - a.sl);
        const far = a.entry + d * Math.min(near * 3, reward * 0.8);
        const nr = a.entry + d * Math.min(near * 0.7, reward * 0.5);
        const seq = [pr(far), pr((far + nr) / 2), pr(nr)];
        if (mode === 'cancel') return seq.concat([pr(a.entry + d * reward * 0.6), pr(a.tps[0])]);
        seq.push(pr(a.entry - d * 0.1));                                     // entry tersentuh
        if (mode === 'sl') return seq.concat([pr(a.entry - d * risk * 0.5), pr(a.sl)]);
        return seq.concat(a.tps.map(pr));                                    // tp
    }

    // ================= PROMPT CLAUDE =================
    const SYSTEM = `Kamu analis order flow XAUUSD. Input: snapshot dari EA COBSystems, level GEX opsional (Put Wall, Call Wall, Zero Gamma), umur data GEX, dan sesi pasar.
Aturan:
- Pakai hanya angka yang ada di snapshot atau input. Jangan mengarang level.
- Pertimbangkan struktur multi timeframe, VWAP, walls (wall yang cepat dibatalkan di wall trail itu lemah), delta, absorption, big trades, indikator.
- Wall GEX itu zona, bukan garis. Harga sering diseret sampai sekitar 10 poin melewati wall lalu balik. Kalau entry di wall GEX, SL harus ketat tepat di balik wall, TP1 di tengah antara entry dan zero gamma, TP2 di zero gamma.
- GEX dari sesi sebelumnya (umur data besar) hanya konteks, bobotnya lebih rendah, dan entry harus menunggu konfirmasi order flow.
- Kalau GEX kosong, jangan sebut level opsi. Level lahir dari struktur dan order flow.
- Kalau kondisi belum jelas, side = "WAIT". Instant hanya true kalau harga sudah di level dan order flow searah.
- Bahasa Indonesia, kalimat pendek. Jangan pakai tanda pisah panjang.
Balas HANYA JSON valid tanpa teks lain:
{"side":"BUY|SELL|WAIT","badge_text":"contoh: SELL LIMIT di area LH M1","entry":0,"sl":0,"tp":[0,0,0],
"instant_buy":false,"instant_sell":false,"wait_text":"apa yang dipasang atau ditunggu",
"extra_levels":[{"label":"Swing high M5","price":0}],
"confirm":["..."],"invalidation":"...","reasons":["..."],"confidence":0}`;

    async function callClaude(userText) {
        const r = await axios.post('https://api.anthropic.com/v1/messages', {
            model: AI_MODEL, max_tokens: 1800, system: SYSTEM,
            messages: [{ role: 'user', content: userText }]
        }, { headers: { 'x-api-key': AI_KEY, 'anthropic-version': '2023-06-01' }, timeout: 90000, httpsAgent });
        const txt = r.data.content.filter(b => b.type === 'text').map(b => b.text).join('');
        return JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1));
    }

    let mockN = 0;
    function mockAI(p, gex) {
        const side = ['SELL', 'BUY', 'WAIT'][mockN++ % 3];
        if (side === 'WAIT') return { side: 'WAIT', entry: null, sl: null, tp: [], wait_text: 'tidak ada setup', extra_levels: [],
            confirm: ['Struktur M1 dan M5 searah dulu', 'Harga menyentuh wall terdekat lalu bertahan'],
            invalidation: 'Belum ada setup.', reasons: ['Data contoh dari server', 'Struktur multi timeframe saling bertentangan'], confidence: 35 };
        const sell = side === 'SELL';
        const entry = sell ? (gex.call != null ? gex.call : p + 4.5) : (gex.put != null ? gex.put : p - 4.5);
        const sl = sell ? entry + 2.4 : entry - 2.4;
        const t1 = gex.zero != null ? gex.zero : (sell ? entry - 8 : entry + 8);
        return { side, badge_text: (sell ? 'SELL' : 'BUY') + ' LIMIT (contoh server)', entry, sl,
            tp: [t1, sell ? t1 - 4 : t1 + 4, sell ? t1 - 10 : t1 + 10], instant_buy: false, instant_sell: false,
            wait_text: 'pasang ' + (sell ? 'sell' : 'buy') + ' limit',
            extra_levels: [{ label: sell ? 'Swing high M5' : 'Swing low M5', price: sell ? p + 7 : p - 7 }],
            confirm: ['Delta 30 detik searah di area entry', 'Wall dekat entry tidak dibatalkan'],
            invalidation: sell ? `Batal jika M5 close di atas ${f2(sl)}.` : `Batal jika M5 close di bawah ${f2(sl)}.`,
            reasons: ['Data contoh dari server, bukan analisa asli', 'Dipakai untuk menguji alur sebelum API aktif'], confidence: 65 };
    }

    // ================= ENDPOINT: ANALISA =================
    app.post('/api/admin/analyze', authenticate(true), async (req, res) => {
        const snap = String(req.body.snapshot || '').slice(0, 60000);
        const bidM = /Bid:\s*([\d.]+)/.exec(snap), askM = /Ask:\s*([\d.]+)/.exec(snap);
        if (!bidM || !askM) return res.status(400).json({ status: 'error', message: 'Snapshot tidak dikenali (Bid/Ask tidak ada).' });
        if (log.filter(r => r.day === today()).length >= DAILY_LIMIT)
            return res.status(429).json({ status: 'error', message: `Batas ${DAILY_LIMIT} analisa per hari sudah tercapai.` });

        const symbol = (/Symbol:\s*(\S+)/.exec(snap) || [, 'XAUUSD'])[1];
        const snapTime = (/Time:\s*([\d.]+ [\d:]+)/.exec(snap) || [, ''])[1];
        const atrM = /ATR14:\s*([\d.]+)/.exec(snap);
        const nearDist = atrM ? Math.max(parseFloat(atrM[1]) * 0.5, 0.8) : 1.5;
        const price = (parseFloat(bidM[1]) + parseFloat(askM[1])) / 2;
        const gex = { put: num(req.body.putWall), call: num(req.body.callWall), zero: num(req.body.zeroGamma) };
        const hasGex = gex.put !== null || gex.call !== null || gex.zero !== null;
        const gexAge = Math.max(0, num(req.body.gexAgeMin) || 0);
        const gexOld = hasGex && gexAge >= GEX_OLD_MIN;
        const session = ['ASIA', 'EROPA', 'US'].includes(req.body.session) ? req.body.session : '-';

        try {
            const ai = AI_MOCK ? mockAI(price, gex) : await callClaude(
                `SESI: ${session}\nHARGA SEKARANG: ${f2(price)}\nPUT WALL: ${gex.put ?? '-'}\nCALL WALL: ${gex.call ?? '-'}\nZERO GAMMA: ${gex.zero ?? '-'}\n` +
                `UMUR DATA GEX: ${hasGex ? (gexAge ? Math.round(gexAge / 60 * 10) / 10 + ' jam' + (gexOld ? ' (LAMA, hanya konteks)' : '') : 'baru') : '-'}\n\nSNAPSHOT:\n${snap}`);

            let side = ['BUY', 'SELL'].includes(ai.side) ? ai.side : 'WAIT';
            const entry = num(ai.entry), sl = num(ai.sl);
            const tps = (ai.tp || []).map(num).filter(x => x !== null).slice(0, 3);
            if (side !== 'WAIT') {
                const ok = entry !== null && sl !== null && tps.length &&
                    (side === 'BUY' ? sl < entry && entry < tps[0] : sl > entry && entry > tps[0]);
                if (!ok) side = 'WAIT';
            }
            let conf = Math.max(0, Math.min(100, Math.round(num(ai.confidence) || 0)));
            if (!hasGex || gexOld) conf = Math.min(conf, 60);
            if (side === 'WAIT') conf = Math.min(conf, 40);

            const C = { call: '#4ade80', put: '#f87171', tp: '#facc15', sl: '#f87171', ent: '#4ade80', info: '#94a3b8', now: '#fff' };
            const L = [['HARGA SEKARANG', C.now, price, 1]];
            if (gex.call !== null) L.push(['CALL WALL', C.call, gex.call]);
            if (gex.put !== null) L.push(['PUT WALL', C.put, gex.put]);
            if (gex.zero !== null) L.push(['ZERO GAMMA', C.tp, gex.zero]);
            (ai.extra_levels || []).slice(0, 4).forEach(x => { const q = num(x.price); if (q !== null) L.push([String(x.label).slice(0, 30), C.info, q]); });
            if (side !== 'WAIT') { L.push(['ENTRY', C.ent, entry], ['SL', C.sl, sl]); tps.forEach((q, i) => L.push(['TP' + (i + 1), C.tp, q])); }
            L.sort((a, b) => b[2] - a[2]);

            const risk = side !== 'WAIT' ? Math.abs(entry - sl) : 0, reward = side !== 'WAIT' ? Math.abs(tps[0] - entry) : 0;

            const rec = { id: Date.now(), ts: new Date().toISOString(), day: today(), stamp: stampNow(), session, hasGex, gexOld, mock: AI_MOCK,
                side, entry, sl, tps, conf, status: side === 'WAIT' ? 'WAIT' : 'WAITING', mae: null, mfe: null, tpHit: 0 };
            log.unshift(rec); saveLog();

            if (side !== 'WAIT') {
                if (active) finish('REPLACED', 'Diganti analisa baru.', true);
                active = { id: rec.id, side, entry, sl, tps, nearDist, symbol, status: 'WAITING', createdAt: Date.now(),
                    expiresAt: Date.now() + SETUP_TTL_MIN * 60000, lastPrice: null, sim: false, mae: null, mfe: null, tpHit: 0 };
                saveActive();
            }

            let banner = null;
            if (!hasGex) banner = ['MODE TANPA GEX', 'Kolom Put Wall, Call Wall, dan Zero Gamma kosong. Level diambil dari struktur dan order flow snapshot saja. Tingkat keyakinan dibatasi maksimal 60.'];
            else if (gexOld) banner = ['GEX LAMA', `Level GEX berumur ${Math.round(gexAge / 60 * 10) / 10} jam dari sesi sebelumnya. Dipakai sebagai konteks, bukan konfirmasi. Tingkat keyakinan dibatasi maksimal 60.`];

            res.json({ status: 'success', data: {
                meta: `${symbol} | ${snapTime} | Harga ${f2(price)} | ${session}${AI_MOCK ? ' | DATA CONTOH' : ''}`,
                banner,
                badge: [side === 'SELL' ? 'b-sell' : side === 'BUY' ? 'b-buy' : 'b-wait', side === 'WAIT' ? 'TIDAK ADA SETUP' : String(ai.badge_text || side).slice(0, 60)],
                e: side === 'WAIT' ? '-' : f2(entry), sl: side === 'WAIT' ? '-' : f2(sl), tp: side === 'WAIT' ? '-' : f2(tps[0]),
                x: side !== 'WAIT' && tps.length > 1 ? tps.slice(1).map((q, i) => `TP${i + 2} ${f2(q)}`).join(' | ') : null,
                rr: side === 'WAIT' ? null : [f2(risk), f2(reward), '1 : ' + (reward / risk).toFixed(1)],
                lv: L.map(x => [x[0], x[1], f2(x[2]), sgn(x[2] - price), x[3] ? 1 : 0]),
                dec: [['INSTANT BUY', side === 'BUY' && ai.instant_buy === true ? 1 : 0], ['INSTANT SELL', side === 'SELL' && ai.instant_sell === true ? 1 : 0],
                      ['WAIT: ' + String(ai.wait_text || 'tunggu konfirmasi').slice(0, 60), (side === 'WAIT' || ai.wait_text) ? 1 : 0]],
                cf: (ai.confirm || []).slice(0, 5).map(String), inv: String(ai.invalidation || '-'), why: (ai.reasons || []).slice(0, 5).map(String), conf,
                his: log.slice(0, 5).map(r => [r.stamp, textOf(r), labelOf(r)])
            } });
        } catch (e) {
            console.error('[ANALISA]', e.response && e.response.data ? JSON.stringify(e.response.data) : e.message);
            res.status(500).json({ status: 'error', message: 'Analisa gagal. Coba lagi.' });
        }
    });

    // ================= ENDPOINT: SETUP AKTIF, RIWAYAT, PUSH, SIMULASI =================
    app.get('/api/admin/active', authenticate(true), (req, res) => {
        if (!active) return res.json({ status: 'success', active: null });
        const a = active, buy = a.side === 'BUY';
        res.json({ status: 'success', active: {
            side: a.side, entry: a.entry, sl: a.sl, tps: a.tps, status: a.status, tpHit: a.tpHit || 0, sim: !!a.sim,
            lastPrice: a.lastPrice, distance: a.lastPrice != null ? (buy ? a.lastPrice - a.entry : a.entry - a.lastPrice) : null,
            expiresInMin: Math.max(0, Math.round((a.expiresAt - Date.now()) / 60000)), mae: a.mae, mfe: a.mfe
        } });
    });

    app.post('/api/admin/cancel_setup', authenticate(true), (req, res) => {
        if (!active) return res.json({ status: 'error', message: 'Tidak ada setup aktif.' });
        finish('CANCELLED', 'Dibatalkan manual.', true);
        res.json({ status: 'success', message: 'Setup dibatalkan.' });
    });

    app.get('/api/admin/analysis_log', authenticate(true), (req, res) =>
        res.json({ status: 'success', data: log.slice(0, 50).map(r => ({
            stamp: r.stamp, session: r.session, text: textOf(r), label: labelOf(r), conf: r.conf, mae: r.mae, mfe: r.mfe, hasGex: r.hasGex, sim: !!r.sim })) }));

    app.post('/api/admin/subscribe_push', authenticate(true), (req, res) => {
        const s = req.body;
        if (!s || typeof s.endpoint !== 'string' || !s.endpoint.startsWith('https://') || !s.keys) return res.status(400).json({ status: 'error', message: 'Subscription tidak valid.' });
        subs = subs.filter(x => x.endpoint !== s.endpoint);
        subs.unshift({ endpoint: s.endpoint, expirationTime: s.expirationTime || null, keys: s.keys });
        subs = subs.slice(0, 3);
        saveSubs();
        console.log('[PUSH-INSIDER] device terdaftar, total:', subs.length);
        res.status(201).json({ status: 'success', message: 'Notifikasi aktif di perangkat ini.' });
    });

    app.post('/api/admin/push_test', authenticate(true), async (req, res) => {
        if (!subs.length) return res.json({ status: 'error', message: 'Belum ada perangkat terdaftar. Aktifkan notifikasi dulu.' });
        await pushAdmin('Uji notifikasi', 'Kalau ini muncul di layar, notifikasi insider sudah jalan.', 'uji');
        res.json({ status: 'success', message: 'Notifikasi uji dikirim.' });
    });

    app.post('/api/admin/simulate', authenticate(true), (req, res) => {
        const mode = ['tp', 'sl', 'cancel'].includes(req.body.mode) ? req.body.mode : 'tp';
        if (!active || active.status !== 'WAITING') return res.json({ status: 'error', message: 'Butuh setup aktif berstatus Menunggu. Jalankan satu analisa (BUY atau SELL) dulu.' });
        active.sim = true; syncRec(active);
        simQ = buildSim(active, mode);
        res.json({ status: 'success', message: `Simulasi ${mode.toUpperCase()} berjalan, ${simQ.length} langkah (tiap 3 detik).` });
    });
};
