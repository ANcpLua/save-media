'use strict';

let _target = null;
let _streamType = null;

document.addEventListener('mouseover', (e) => { _target = e.target; }, { passive: true, capture: true });

document.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyS' || !(e.altKey || e.ctrlKey)) return;
    e.preventDefault();
    if (!_target) return;

    const media = findMedia(_target);
    if (!media) return;

    if (!chrome.runtime?.id) return;
    chrome.runtime.sendMessage(media);
    toast(media.isVideo ? 'Downloading video...' : 'Saved');
});

// ── Stream detection ──

if (navigator.requestMediaKeySystemAccess) {
    const orig = navigator.requestMediaKeySystemAccess.bind(navigator);
    navigator.requestMediaKeySystemAccess = function(ks, cfg) {
        _streamType = 'drm';
        showBadge('DRM', '#ef4444');
        return orig(ks, cfg);
    };
}

const _fetch = window.fetch;
window.fetch = function(...args) {
    checkHls(typeof args[0] === 'string' ? args[0] : args[0]?.url);
    return _fetch.apply(this, args);
};

const _xhrOpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function(m, url, ...r) {
    checkHls(String(url));
    return _xhrOpen.call(this, m, url, ...r);
};

function checkHls(url) {
    if (!url || _streamType === 'drm' || !/\.m3u8(\?|$)/i.test(url)) return;
    _fetch(url).then(r => r.text()).then(t => {
        if (t.includes('#EXT-X-KEY') && t.includes('AES-128')) {
            _streamType = 'aes-hls';
            showBadge('AES-HLS', '#16a34a');
        } else if (!_streamType) {
            _streamType = 'hls';
            showBadge('HLS', '#2563eb');
        }
    }).catch(e => console.debug('[save-media] m3u8 check failed:', e.message));
}

// ── Media detection ──

function findMedia(el) {
    let cur = el;
    while (cur && cur !== document.body) {
        const r = extract(cur);
        if (r) return r;
        for (const tag of ['video', 'img']) {
            const child = cur.querySelector(tag);
            if (child) { const r2 = extract(child); if (r2) return r2; }
        }
        cur = cur.parentElement;
    }
    return null;
}

function extract(el) {
    const tag = el.tagName?.toLowerCase();

    if (tag === 'img' || tag === 'picture') {
        const img = tag === 'picture' ? el.querySelector('img') : el;
        if (!img) return null;
        const url = enhanceUrl(bestSrc(img));
        return url ? { url, name: nameFrom(url, 'image.png') } : null;
    }

    if (tag === 'video') {
        if (_streamType === 'drm') return { isDrm: true };
        const url = el.src || el.querySelector('source')?.src || el.currentSrc;
        if (url && !url.startsWith('blob:')) return { url, name: nameFrom(url, 'video.mp4') };
        return { pageUrl: location.href, name: 'video.mp4', isVideo: true };
    }

    return null;
}

// ── Helpers ──

function enhanceUrl(url) {
    if (!url) return url;
    if (url.includes('pbs.twimg.com')) {
        url = url.replace(/[?&]name=\w+/, '&name=orig');
        if (!url.includes('name=orig')) url += (url.includes('?') ? '&' : '?') + 'name=orig';
    }
    return url;
}

function bestSrc(img) {
    if (img.srcset) {
        const best = img.srcset.split(',')
            .map(s => { const p = s.trim().split(/\s+/); return { url: p[0], v: parseFloat(p[1]) || 1 }; })
            .sort((a, b) => b.v - a.v)[0]?.url;
        if (best) return best;
    }
    for (const a of ['data-src', 'data-original', 'data-lazy-src', 'data-full-src', 'data-hi-res-src']) {
        const v = img.getAttribute(a);
        if (v) return v;
    }
    return img.src || img.currentSrc;
}

function nameFrom(url, fallback) {
    try {
        const n = new URL(url, location.href).pathname.split('/').pop();
        return n?.includes('.') ? n : fallback;
    } catch { return fallback; }
}

// ── UI ──

function showBadge(label, color) {
    document.getElementById('__sm-badge')?.remove();
    const el = document.createElement('div');
    el.id = '__sm-badge';
    el.textContent = label;
    Object.assign(el.style, {
        position: 'fixed', top: '8px', right: '8px', background: color, color: '#fff',
        padding: '4px 10px', borderRadius: '4px', zIndex: '2147483647', fontSize: '11px',
        fontFamily: 'system-ui', fontWeight: '600', boxShadow: '0 2px 8px rgba(0,0,0,.4)',
        pointerEvents: 'none', opacity: '0.9'
    });
    document.body.appendChild(el);
}

chrome.runtime.onMessage.addListener((msg) => { if (msg.toast) toast(msg.toast); });

function toast(msg) {
    const el = document.createElement('div');
    el.textContent = msg;
    Object.assign(el.style, {
        position: 'fixed', bottom: '20px', right: '20px', background: '#1a1a1a', color: '#fff',
        padding: '10px 18px', borderRadius: '8px', zIndex: '2147483647', fontSize: '14px',
        fontFamily: 'system-ui', boxShadow: '0 4px 12px rgba(0,0,0,.3)',
        transition: 'opacity .3s', opacity: '0', pointerEvents: 'none'
    });
    document.body.appendChild(el);
    requestAnimationFrame(() => { el.style.opacity = '1'; });
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 2000);
}
