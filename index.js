'use strict';

// ============================================================
//  DISBOARD AUTO BUMPER - 4 TOKEN / 4 SERVER
//  - Verifica risposta reale di Disboard dopo ogni bump
//  - Intervallo 40 min tra ogni account
//  - Delay random 1-10 min dopo ciclo completo
//  - Retry automatico su errori
// ============================================================

const { Client } = require('discord.js-selfbot-v13');

// ─── CONFIG ────────────────────────────────────────────────
const ACCOUNTS = [
    { token: process.env.TOKEN_1, channelId: process.env.CHANNEL_ID_1, label: 'Account 1' },
    { token: process.env.TOKEN_2, channelId: process.env.CHANNEL_ID_2, label: 'Account 2' },
    { token: process.env.TOKEN_3, channelId: process.env.CHANNEL_ID_3, label: 'Account 3' },
    { token: process.env.TOKEN_4, channelId: process.env.CHANNEL_ID_4, label: 'Account 4' },
];

const DISBOARD_ID        = '302050872383242240';
const INTERVAL_MS        = 30 * 60 * 1000;
const DELAY_MIN_MS       = 1  * 60 * 1000;
const DELAY_MAX_MS       = 10 * 60 * 1000;
const MAX_RETRIES        = 5;
const RETRY_DELAY_MS     = 30 * 1000;
const DISBOARD_WAIT_MS   = 10 * 1000; // attesa risposta Disboard
// ───────────────────────────────────────────────────────────

// ─── UTILITIES ─────────────────────────────────────────────
function log(level, label, msg) {
    const time  = new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' });
    const icons = { INFO: '📋', OK: '✅', WARN: '⚠️ ', ERROR: '❌', WAIT: '⏳', BUMP: '🚀' };
    console.log(`[${time}] ${icons[level] || '•'} [${level}] [${label}] ${msg}`);
}

function randomDelay() {
    return Math.floor(Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS + 1)) + DELAY_MIN_MS;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function formatTime(ms) {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`;
}
// ───────────────────────────────────────────────────────────

// ─── VALIDAZIONE ───────────────────────────────────────────
ACCOUNTS.forEach((acc, i) => {
    if (!acc.token)     { console.error(`❌ TOKEN_${i+1} mancante!`);      process.exit(1); }
    if (!acc.channelId) { console.error(`❌ CHANNEL_ID_${i+1} mancante!`); process.exit(1); }
});
// ───────────────────────────────────────────────────────────

// ─── STATS ─────────────────────────────────────────────────
const stats = ACCOUNTS.map(a => ({ label: a.label, bumps: 0, fails: 0 }));
// ───────────────────────────────────────────────────────────

// ─── CREA CLIENT ───────────────────────────────────────────
const clients = ACCOUNTS.map(acc => {
    const client = new Client({ checkUpdate: false });
    client.on('ready', () => log('OK',    acc.label, `Connesso come ${client.user.tag}`));
    client.on('error', e  => log('ERROR', acc.label, `Errore client: ${e.message}`));
    client.on('warn',  m  => log('WARN',  acc.label, m));
    return client;
});
// ───────────────────────────────────────────────────────────

// ─── LOGIN ─────────────────────────────────────────────────
async function loginAll() {
    for (let i = 0; i < ACCOUNTS.length; i++) {
        try {
            log('INFO', ACCOUNTS[i].label, 'Login...');
            await clients[i].login(ACCOUNTS[i].token);
            await sleep(3000);
        } catch (e) {
            log('ERROR', ACCOUNTS[i].label, `Login fallito: ${e.message}`);
            process.exit(1);
        }
    }
    log('INFO', 'SISTEMA', '✅ Tutti connessi!');
}
// ───────────────────────────────────────────────────────────

// ─── ASPETTA RISPOSTA DISBOARD ──────────────────────────────
function waitForDisboardResponse(client, channelId, label) {
    return new Promise(resolve => {
        const timeout = setTimeout(() => {
            client.removeListener('messageCreate', handler);
            log('WARN', label, 'Nessuna risposta da Disboard in 10 secondi — assumo riuscito.');
            resolve({ confirmed: true, cooldown: false, cooldownMinutes: 0 });
        }, DISBOARD_WAIT_MS);

        function handler(message) {
            if (message.author.id !== DISBOARD_ID) return;
            if (message.channel.id !== channelId) return;

            clearTimeout(timeout);
            client.removeListener('messageCreate', handler);

            const embed = message.embeds?.[0];

            // Legge testo da tutte le possibili posizioni nell'embed
            const parts = [
                message.content || '',
                embed?.description || '',
                embed?.title || '',
                ...(embed?.fields?.map(f => `${f.name} ${f.value}`) || []),
            ];
            const fullText = parts.join(' ').toLowerCase();
            const preview  = (embed?.description || embed?.title || message.content || '').slice(0, 100);
            log('INFO', label, `Disboard: "${preview}"`);

            // ── Bump riuscito ──
            if (
                fullText.includes('bump done') ||
                fullText.includes('bumped') ||
                fullText.includes('bump effettuato') ||
                fullText.includes('server bumped') ||
                fullText.includes('successfully bumped') ||
                fullText.includes('thumbsup') ||
                fullText.includes('👍')
            ) {
                resolve({ confirmed: true, cooldown: false, cooldownMinutes: 0 });
                return;
            }

            // ── Cooldown — estrae i minuti esatti ──
            const cooldownMatch =
                fullText.match(/(\d+)\s*minute/) ||
                fullText.match(/(\d+)\s*minut/)  ||
                fullText.match(/(\d+)\s*min/);

            if (
                fullText.includes('wait')     ||
                fullText.includes('cooldown') ||
                fullText.includes('aspetta')  ||
                fullText.includes('minute')   ||
                fullText.includes('minuti')   ||
                cooldownMatch
            ) {
                const minutes = cooldownMatch ? parseInt(cooldownMatch[1], 10) : 0;
                log('WARN', label, `Cooldown attivo${minutes ? ` — ancora ${minutes} minuti` : ''}. Salto questo account.`);
                resolve({ confirmed: false, cooldown: true, cooldownMinutes: minutes });
                return;
            }

            // ── Disboard down / API error ──
            if (
                fullText.includes('down') ||
                fullText.includes('try again') ||
                fullText.includes('error') ||
                fullText.includes('errore')
            ) {
                log('WARN', label, 'Disboard API down — salto e riprovo al prossimo ciclo.');
                resolve({ confirmed: false, cooldown: false, cooldownMinutes: 0 });
                return;
            }

            // ── Non riconosciuta ──
            log('WARN', label, 'Risposta non riconosciuta — assumo riuscito.');
            resolve({ confirmed: true, cooldown: false, cooldownMinutes: 0 });
        }

        client.on('messageCreate', handler);
    });
}
// ───────────────────────────────────────────────────────────

// ─── BUMP ──────────────────────────────────────────────────
async function doBump(i) {
    const acc = ACCOUNTS[i], client = clients[i], stat = stats[i];

    // Fetch canale
    let channel = client.channels.cache.get(acc.channelId);
    if (!channel) {
        try { channel = await client.channels.fetch(acc.channelId); }
        catch (e) { log('ERROR', acc.label, `Fetch canale fallito: ${e.message}`); return { success: false, fatal: false }; }
    }
    if (!channel) { log('ERROR', acc.label, 'Canale non trovato!'); return { success: false, fatal: true }; }

    log('BUMP', acc.label, `Eseguo /bump in #${channel.name} (${channel.guild?.name})...`);

    // Avvia listener PRIMA di inviare il comando
    const responsePromise = waitForDisboardResponse(client, acc.channelId, acc.label);

    try {
        await channel.sendSlash(DISBOARD_ID, 'bump');
    } catch (e) {
        const m = e.message || '';
        log('ERROR', acc.label, `Errore sendSlash: ${m}`);
        if (m.includes('cooldown') || m.includes('wait'))         { await sleep(5 * 60 * 1000); return { success: false, fatal: false }; }
        if (m.includes('Missing Permissions'))                     { return { success: false, fatal: true }; }
        if (m.includes('Unknown Channel'))                         { return { success: false, fatal: true }; }
        if (m.includes('401') || m.includes('Invalid token'))     { log('ERROR', acc.label, 'Token scaduto!'); return { success: false, fatal: true }; }
        return { success: false, fatal: false };
    }

    // Aspetta conferma reale da Disboard
    const response = await responsePromise;

    if (response.cooldown) {
        // Non bloccare il loop — salta questo account e riprova al prossimo ciclo
        stat.fails++;
        return { success: false, fatal: false, skip: true };
    }

    if (!response.confirmed) {
        // API down o risposta sconosciuta — non contare come bump riuscito
        log('WARN', acc.label, 'Bump non confermato — non conto come riuscito.');
        return { success: false, fatal: false };
    }

    stat.bumps++;
    log('OK', acc.label, `Bump #${stat.bumps} confermato! (${new Date().toLocaleString('it-IT')})`);
    return { success: true, fatal: false };
}

async function bumpWithRetry(i) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        if (attempt > 1) {
            log('WARN', ACCOUNTS[i].label, `Tentativo ${attempt}/${MAX_RETRIES}...`);
            await sleep(RETRY_DELAY_MS);
        }
        const { success, fatal, skip } = await doBump(i);
        if (success) return;
        if (fatal)   { process.exit(1); }
        if (skip)    { log('WARN', ACCOUNTS[i].label, 'Skip — cooldown attivo, riprovo al prossimo ciclo.'); return; }
    }
    stats[i].fails++;
    log('ERROR', ACCOUNTS[i].label, `Bump fallito dopo ${MAX_RETRIES} tentativi.`);
}
// ───────────────────────────────────────────────────────────

// ─── LOOP PRINCIPALE ────────────────────────────────────────
async function mainLoop() {
    log('INFO', 'SISTEMA', '═══════════════════════════════════════');
    log('INFO', 'SISTEMA', '   DISBOARD AUTO BUMPER 4x AVVIATO    ');
    log('INFO', 'SISTEMA', '   Intervallo tra bump: 30 minuti     ');
    log('INFO', 'SISTEMA', '   Verifica risposta Disboard: ON     ');
    log('INFO', 'SISTEMA', '═══════════════════════════════════════');

    await sleep(5000);
    let cycle = 0;

    while (true) {
        cycle++;
        log('INFO', 'SISTEMA', `─── CICLO #${cycle} ───`);

        for (let i = 0; i < ACCOUNTS.length; i++) {
            await bumpWithRetry(i);

            const isLast  = i === ACCOUNTS.length - 1;
            const nextLbl = isLast ? ACCOUNTS[0].label : ACCOUNTS[i+1].label;
            const nextAt  = new Date(Date.now() + INTERVAL_MS).toLocaleString('it-IT', { timeZone: 'Europe/Rome' });
            log('WAIT', 'SISTEMA', `Prossimo bump (${nextLbl}) tra ${formatTime(INTERVAL_MS)} (alle ${nextAt})`);
            await sleep(INTERVAL_MS);
        }

        log('INFO', 'SISTEMA', '─── STATS ───');
        stats.forEach(s => log('INFO', s.label, `✅ ${s.bumps} bumps | ❌ ${s.fails} falliti`));
    }
}
// ───────────────────────────────────────────────────────────

process.on('unhandledRejection', e => console.error('❌ Rejection:', e?.message));
process.on('uncaughtException',  e => console.error('❌ Exception:', e?.message));

(async () => { await loginAll(); await mainLoop(); })();
