import WebSocket from 'ws';

import { makeRequest } from '../../utils/http.js';

const DEFAULT_USER_AGENT = process.env.HTTP_STREAM_USER_AGENT
    || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
const DEFAULT_FINGERPRINT = process.env.XDMOVIES_PROTECTOR_FINGERPRINT || '0123456789abcdef0123456789abcdef';
const XDMOVIES_LINK_HOSTS = ['link.xdmovies.site', 'link.xdmovies.wtf'];
const XDMOVIES_PROTECTOR_STEP_VISIBLE_MS = Math.max(
    12_000,
    parseInt(process.env.XDMOVIES_PROTECTOR_STEP_VISIBLE_MS || '15000', 10) || 15_000
);
const XDMOVIES_PROTECTOR_STEP_TIMEOUT_MS = Math.max(
    XDMOVIES_PROTECTOR_STEP_VISIBLE_MS + 10_000,
    parseInt(process.env.XDMOVIES_PROTECTOR_STEP_TIMEOUT_MS || '30000', 10) || 30_000
);

function isXdMoviesLinkHost(url = '') {
    return XDMOVIES_LINK_HOSTS.some(host => String(url).includes(host));
}

function isXdMoviesProtectorUrl(url = '') {
    return /\/r\/[A-Za-z0-9_-]+(?:$|[/?#])/.test(String(url || ''));
}

function getSetCookieValues(headers) {
    if (!headers) return [];
    if (typeof headers.getSetCookie === 'function') {
        return headers.getSetCookie();
    }

    const single = headers.get?.('set-cookie');
    return single ? [single] : [];
}

function mergeCookieHeader(existing = '', setCookieValues = []) {
    const cookieMap = new Map();

    existing.split(';').forEach(cookie => {
        const trimmed = cookie.trim();
        if (!trimmed) return;
        const separator = trimmed.indexOf('=');
        if (separator <= 0) return;
        cookieMap.set(trimmed.slice(0, separator), trimmed.slice(separator + 1));
    });

    for (const rawCookie of setCookieValues) {
        const firstPart = String(rawCookie || '').split(';')[0].trim();
        if (!firstPart) continue;
        const separator = firstPart.indexOf('=');
        if (separator <= 0) continue;
        cookieMap.set(firstPart.slice(0, separator), firstPart.slice(separator + 1));
    }

    return Array.from(cookieMap.entries())
        .map(([name, value]) => `${name}=${value}`)
        .join('; ');
}

function createMouseData(durationMs, phase = 1) {
    const duration = Math.max(1000, durationMs | 0);
    const steps = Math.max(6, Math.floor(duration / 1000));
    return {
        eventCount: 12 + (steps * 2) + phase,
        moveCount: 8 + steps + phase,
        clickCount: Math.min(3, phase + 1),
        totalDistance: 180 + (steps * 90),
        hasMovement: true,
        duration
    };
}

async function openAndTrackProtectorSocket({ socketUrl, baseUrl, cookies, bindToken, userAgent, durationMs }) {
    return await new Promise((resolve, reject) => {
        const ws = new WebSocket(socketUrl, {
            headers: {
                'User-Agent': userAgent,
                'Cookie': cookies,
                'Origin': baseUrl
            }
        });

        let timer = null;
        let interval = null;
        let startedAt = 0;
        let finished = false;

        const finish = (error = null) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            clearInterval(interval);
            try {
                ws.close();
            } catch {
                // Ignore close failures.
            }
            if (error) {
                reject(error);
            } else {
                resolve();
            }
        };

        timer = setTimeout(() => {
            finish(new Error('xdmovies protector websocket timeout'));
        }, Math.max(XDMOVIES_PROTECTOR_STEP_TIMEOUT_MS, durationMs + 10_000));

        ws.on('message', (data) => {
            const message = data.toString();

            if (message.startsWith('0')) {
                ws.send('40');
                return;
            }

            if (message === '2') {
                ws.send('3');
                return;
            }

            if (message.startsWith('40') && !startedAt) {
                startedAt = Date.now();
                ws.send(`42["bind",${JSON.stringify(bindToken)}]`);
                ws.send('42["visibility","visible"]');

                interval = setInterval(() => {
                    const elapsed = Math.max(1000, Date.now() - startedAt);
                    ws.send('42["heartbeat"]');
                    ws.send('42["visibility","visible"]');
                    ws.send(`42["mouseActivity",${JSON.stringify(createMouseData(elapsed, 2))}]`);
                }, 1000);

                setTimeout(() => finish(), durationMs);
            }
        });

        ws.on('error', (error) => finish(error));
    });
}

export async function resolveXDMoviesProtectedUrl(url, options = {}) {
    if (!url) return null;
    if (!isXdMoviesLinkHost(url) && !isXdMoviesProtectorUrl(url)) return url;

    const userAgent = options.userAgent || DEFAULT_USER_AGENT;
    const fingerprint = options.fingerprint || DEFAULT_FINGERPRINT;

    let protectorUrl = url;
    if (isXdMoviesLinkHost(url)) {
        try {
            const redirect = await makeRequest(url, {
                allowRedirects: false,
                parseHTML: false,
                timeout: 10_000,
                headers: {
                    'User-Agent': userAgent
                }
            });

            const location = redirect.headers?.location || redirect.headers?.Location;
            if (location) {
                protectorUrl = new URL(location, url).toString();
            } else if (redirect.url && redirect.url !== url) {
                protectorUrl = redirect.url;
            }
        } catch (error) {
            console.log(`[XDMovies] Failed to fetch redirector ${url}: ${error.message}`);
            return url;
        }
    }

    if (!protectorUrl) return url;

    const protectorParsed = new URL(protectorUrl);
    const pathParts = protectorParsed.pathname.split('/').filter(Boolean);
    const rIndex = pathParts.findIndex(part => part.toLowerCase() === 'r');
    const code = rIndex >= 0 ? pathParts[rIndex + 1] : null;
    if (!code) {
        return protectorUrl;
    }

    const baseUrl = `${protectorParsed.protocol}//${protectorParsed.host}`;
    const socketUrl = `${protectorParsed.protocol === 'https:' ? 'wss' : 'ws'}://${protectorParsed.host}/socket.io/?EIO=4&transport=websocket`;
    let cookies = '';

    try {
        const sessionResponse = await fetch(`${baseUrl}/api/session`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': userAgent,
                'Referer': protectorUrl,
                'Origin': baseUrl
            },
            body: JSON.stringify({
                code,
                fingerprint,
                mouseData: createMouseData(2500, 1)
            })
        });

        cookies = mergeCookieHeader(cookies, getSetCookieValues(sessionResponse.headers));
        const sessionData = await sessionResponse.json().catch(() => ({}));
        if (!sessionResponse.ok || !sessionData?.sessionId || !sessionData?.token) {
            console.log(`[XDMovies] Protector session failed for ${protectorUrl}: ${sessionData?.error || sessionResponse.status}`);
            return protectorUrl;
        }

        await openAndTrackProtectorSocket({
            socketUrl,
            baseUrl,
            cookies,
            bindToken: sessionData.token,
            userAgent,
            durationMs: XDMOVIES_PROTECTOR_STEP_VISIBLE_MS
        });

        const step2Url = `${baseUrl}/r/${encodeURIComponent(code)}?step=2&sid=${encodeURIComponent(sessionData.sessionId)}`;
        const step2Response = await fetch(step2Url, {
            headers: {
                'User-Agent': userAgent,
                'Cookie': cookies,
                'Referer': protectorUrl
            }
        });
        cookies = mergeCookieHeader(cookies, getSetCookieValues(step2Response.headers));

        const rebindResponse = await fetch(`${baseUrl}/api/session/rebind`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': userAgent,
                'Cookie': cookies,
                'Referer': step2Url,
                'Origin': baseUrl
            },
            body: JSON.stringify({ fingerprint })
        });
        cookies = mergeCookieHeader(cookies, getSetCookieValues(rebindResponse.headers));
        const rebindData = await rebindResponse.json().catch(() => ({}));
        if (!rebindResponse.ok || !rebindData?.token) {
            console.log(`[XDMovies] Protector rebind failed for ${protectorUrl}: ${rebindData?.error || rebindResponse.status}`);
            return protectorUrl;
        }

        await openAndTrackProtectorSocket({
            socketUrl,
            baseUrl,
            cookies,
            bindToken: rebindData.token,
            userAgent,
            durationMs: XDMOVIES_PROTECTOR_STEP_VISIBLE_MS
        });

        const completeResponse = await fetch(`${baseUrl}/api/session/complete`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': userAgent,
                'Cookie': cookies,
                'Referer': step2Url,
                'Origin': baseUrl
            },
            body: JSON.stringify({
                fingerprint,
                mouseData: createMouseData((XDMOVIES_PROTECTOR_STEP_VISIBLE_MS * 2) + 2500, 3),
                honeypot: ''
            })
        });
        cookies = mergeCookieHeader(cookies, getSetCookieValues(completeResponse.headers));
        const completeData = await completeResponse.json().catch(() => ({}));
        if (!completeResponse.ok || !completeData?.token) {
            console.log(`[XDMovies] Protector completion failed for ${protectorUrl}: ${completeData?.error || completeResponse.status}`);
            return protectorUrl;
        }

        const goUrl = `${baseUrl}/go/${encodeURIComponent(sessionData.sessionId)}?t=${encodeURIComponent(completeData.token)}`;
        const goResponse = await fetch(goUrl, {
            redirect: 'manual',
            headers: {
                'User-Agent': userAgent,
                'Cookie': cookies,
                'Referer': step2Url
            }
        });
        const finalLocation = goResponse.headers.get('location');
        if (finalLocation) {
            return new URL(finalLocation, baseUrl).toString();
        }

        if (goResponse.url && goResponse.url !== goUrl) {
            return goResponse.url;
        }

        console.log(`[XDMovies] Protector go endpoint returned no redirect for ${protectorUrl}`);
    } catch (error) {
        console.log(`[XDMovies] Protector resolution failed for ${protectorUrl}: ${error.message}`);
    }

    return protectorUrl;
}
