'use strict';

const { Client } = require('discord.js-selfbot-v13');

const ACCOUNTS = [
    { token: process.env.TOKEN_1, channelId: process.env.CHANNEL_ID_1, label: 'Account 1' },
    { token: process.env.TOKEN_2, channelId: process.env.CHANNEL_ID_2, label: 'Account 2' },
    { token: process.env.TOKEN_3, channelId: process.env.CHANNEL_ID_3, label: 'Account 3' },
    { token: process.env.TOKEN_4, channelId: process.env.CHANNEL_ID_4, label: 'Account 4' },
];

const DISBOARD_ID      = '302050872383242240';
const INTERVAL_MS      = 30 * 60 * 1000;
const MAX_RETRIES      = 5;
const RETRY_DELAY_MS   = 30 * 1000;
const DISBOARD_WAIT_MS = 10 * 1000;

function log(level, label, msg) {
    const time  = new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' });
    const icons = { INFO: '📋', OK: '✅', WARN: '⚠️ ', ERROR: '❌', WAIT: '⏳', BUMP: '🚀' };
    console.log(`[${time}] ${icons[level] || '•'} [${level}] [${label}] ${msg}`);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function formatTime(ms) {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`;
}

ACCOUNTS.forEach((acc, i) => {
    if (!acc.token)     { console.error(`❌ TOKEN_${i+1} mancante!`);      process.exit(1); }
    if (!acc.channelId) { console.error(`❌ CHANNEL_ID_${i+1} mancante!`); process.exit(1); }
});

const stats   = ACCOUNTS.map(a => ({ label: a.label, bumps: 0, fails: 0, skips: 0 }));
const clients = ACCOUNTS.map(acc => {
    const client = new Client({ checkUpdate: false });
    client.on('ready', () => log('OK',    acc.label, `Connesso come ${client.user.tag}`));
    client.on('error', e  => log('ERROR', acc.label, `Errore client: ${e.message}`));
    return client;
});

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

function waitForDisboardResponse(client, channelId, label) {
    return new Promise(resolve => {
        const timeout = setTimeout(() => {
            client.removeListener('messageCreate', handler);
            log('WARN', label, 'Nessuna risposta da Disboard — assumo riuscito.');
            resolve({ confirmed: true, cooldown: false });
        }, DISBOARD_WAIT_MS);

        function handler(message) {
            if (message.author.id !== DISBOARD_ID) return;
            if (message.channel.id !== channelId)  return;
            clearTimeout(timeout);
            client.removeListener('messageCreate', handler);

            const embed    = message.embeds?.[0];
            const parts    = [
                message.content || '',
                embed?.description || '',
                embed?.title || '',
                ...(embed?.fields?.map(f => `${f.name} ${f.value}`) || []),
            ];
            const fullText = parts.join(' ').toLowerCase();
            const preview  = (embed?.description || embed?.title || message.content || '').slice(0, 100);
            log('INFO', label, `Disboard: "${preview}"`);

            // Bump riuscito
            if (fullText.includes('bump done') || fullText.includes('bumped') ||
                fullText.includes('server bumped') || fullText.includes('successfully bumped') ||
                fullText.includes('thumbsup') || fullText.includes('👍')) {
                resolve({ confirmed: true, cooldown: false });
                return;
            }
            // Cooldown
            const m = fullText.match(/(\d+)\s*min/);
            if (fullText.includes('wait') || fullText.includes('cooldown') ||
                fullText.includes('aspetta') || fullText.includes('minute') || m) {
                const mins = m ? parseInt(m[1]) : 0;
                log('WARN', label, `Cooldown${mins ? ` — ${mins} min` : ''} — skip.`);
                resolve({ confirmed: false, cooldown: true });
                return;
            }
            // API down
            if (fullText.includes('down') || fullText.includes('try again')) {
                log('WARN', label, 'Disboard down — skip.');
                resolve({ confirmed: false, cooldown: false });
                return;
            }
            log('WARN', label, 'Risposta non riconosciuta — assumo riuscito.');
            resolve({ confirmed: true, cooldown: false });
        }
        client.on('messageCreate', handler);
    });
}

async function doBump(i) {
    const acc = ACCOUNTS[i], client = clients[i], stat = stats[i];

    let channel = client.channels.cache.get(acc.channelId);
    if (!channel) {
        try { channel = await client.channels.fetch(acc.channelId); }
        catch (e) { log('ERROR', acc.label, `Fetch canale fallito: ${e.message}`); return { success: false, fatal: false }; }
    }
    if (!channel) { log('ERROR', acc.label, 'Canale non trovato!'); return { success: false, fatal: true }; }

    log('BUMP', acc.label, `Eseguo /bump in #${channel.name} (${channel.guild?.name})...`);
    const responsePromise = waitForDisboardResponse(client, acc.channelId, acc.label);

    try {
        // Prima prova application_commands() — più affidabile di sendSlash
        let bumped = false;
        try {
            const appCmds = await channel.application_commands();
            const bumpCmd = appCmds.find(c => c.name === 'bump' && c.application_id === DISBOARD_ID);
            if (bumpCmd) { await bumpCmd(); bumped = true; }
            else { log('WARN', acc.label, '/bump non in application_commands — fallback sendSlash'); }
        } catch (e) {
            log('WARN', acc.label, `application_commands fallito (${e.message}) — fallback sendSlash`);
        }

        if (!bumped) {
            await channel.sendSlash(DISBOARD_ID, 'bump');
        }
    } catch (e) {
        const m = e.message || '';
        log('ERROR', acc.label, `Errore bump: ${m}`);
        if (m.includes('cooldown') || m.includes('wait'))         return { success: false, fatal: false, skip: true };
        if (m.includes('Missing Permissions'))                     return { success: false, fatal: true };
        if (m.includes('Unknown Channel'))                         return { success: false, fatal: true };
        if (m.includes('401') || m.includes('Invalid token'))    { log('ERROR', acc.label, 'Token scaduto!'); return { success: false, fatal: true }; }
        return { success: false, fatal: false };
    }

    const response = await responsePromise;

    if (response.cooldown) { stat.skips++; return { success: false, fatal: false, skip: true }; }
    if (!response.confirmed) {
        stat.fails++;
        log('WARN', acc.label, 'Bump non confermato.');
        return { success: false, fatal: false };
    }

    stat.bumps++;
    log('OK', acc.label, `Bump #${stat.bumps} confermato! (${new Date().toLocaleString('it-IT')})`);
    return { success: true, fatal: false };
}

async function bumpWithRetry(i) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        if (attempt > 1) { log('WARN', ACCOUNTS[i].label, `Tentativo ${attempt}/${MAX_RETRIES}...`); await sleep(RETRY_DELAY_MS); }
        const { success, fatal, skip } = await doBump(i);
        if (success) return;
        if (fatal)   process.exit(1);
        if (skip)  { log('WARN', ACCOUNTS[i].label, 'Skip — riprovo al prossimo ciclo.'); return; }
    }
    stats[i].fails++;
    log('ERROR', ACCOUNTS[i].label, `Bump fallito dopo ${MAX_RETRIES} tentativi.`);
}

async function mainLoop() {
    log('INFO', 'SISTEMA', '══════════════════════════════════════');
    log('INFO', 'SISTEMA', '  DISBOARD AUTO BUMPER 4x            ');
    log('INFO', 'SISTEMA', '  Intervallo: 30 min | Retry: 5x     ');
    log('INFO', 'SISTEMA', '══════════════════════════════════════');
    await sleep(5000);
    let cycle = 0;

    while (true) {
        cycle++;
        log('INFO', 'SISTEMA', `─── CICLO #${cycle} ───`);

        for (let i = 0; i < ACCOUNTS.length; i++) {
            await bumpWithRetry(i);
            const nextLbl = ACCOUNTS[(i + 1) % ACCOUNTS.length].label;
            const nextAt  = new Date(Date.now() + INTERVAL_MS).toLocaleString('it-IT', { timeZone: 'Europe/Rome' });
            log('WAIT', 'SISTEMA', `Prossimo bump (${nextLbl}) tra ${formatTime(INTERVAL_MS)} (alle ${nextAt})`);
            await sleep(INTERVAL_MS);
        }

        log('INFO', 'SISTEMA', '─── STATS ───');
        stats.forEach(s => log('INFO', s.label, `✅ ${s.bumps} bumps | ⏭️  ${s.skips} skip | ❌ ${s.fails} falliti`));
    }
}

process.on('unhandledRejection', e => console.error('❌ Rejection:', e?.message));
process.on('uncaughtException',  e => console.error('❌ Exception:', e?.message));

(async () => { await loginAll(); await mainLoop(); })();
        
