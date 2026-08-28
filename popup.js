'use strict';

const $ = (s) => document.querySelector(s);
const API = 'https://lulustream.com/api';
let apiKey = '';
let allFiles = [];

chrome.storage.local.get(['lulu_key', 'quality'], (d) => {
    if (d.quality) $('#quality').value = d.quality;
    if (d.lulu_key) { $('#apiKey').value = d.lulu_key; apiKey = d.lulu_key; loadFiles(); }
});

$('#quality').addEventListener('change', () => chrome.storage.local.set({ quality: $('#quality').value }));
$('#loadBtn').addEventListener('click', () => {
    apiKey = $('#apiKey').value.trim();
    if (apiKey) { chrome.storage.local.set({ lulu_key: apiKey }); loadFiles(); }
});
$('#refresh').addEventListener('click', loadFiles);
$('#dlAll').addEventListener('click', () => allFiles.forEach(f => dl(f.file_code, f.title)));

async function loadFiles() {
    setStatus('Loading...');
    try {
        const all = [];
        let p = 1, pages = 1;
        do {
            const r = await api('file/list', { per_page: 50, page: p });
            if (r.status !== 200) throw new Error(r.msg);
            all.push(...(r.result.files || []));
            pages = r.result.pages || 1;
        } while (++p <= pages && p <= 20);

        allFiles = all;
        render(all);
        $('#toolbar').style.display = 'flex';
        $('#count').textContent = `${all.length} files`;
        setStatus('');
    } catch (e) { setStatus('Error: ' + e.message); }
}

function render(files) {
    const el = $('#files');
    if (!files.length) { el.innerHTML = '<div class="empty">No files</div>'; return; }
    el.innerHTML = files.map(f => `
        <div class="file" data-code="${f.file_code}">
            <img src="${f.thumbnail || ''}" alt="" loading="lazy">
            <div class="info">
                <div class="title" title="${esc(f.title)}">${esc(f.title || f.file_code)}</div>
                <div class="meta">${f.views || 0} views · ${dur(f.length)} · ${f.uploaded || ''}</div>
            </div>
            <button class="dl-btn">Save</button>
        </div>`).join('');

    el.querySelectorAll('.dl-btn').forEach(btn => btn.addEventListener('click', () => {
        const row = btn.closest('.file');
        btn.disabled = true; btn.textContent = '...';
        dl(row.dataset.code, row.querySelector('.title').textContent);
    }));
}

function dl(code, title) {
    chrome.runtime.sendMessage({
        isVideo: true, pageUrl: `https://lulustream.com/${code}.html`,
        quality: $('#quality').value, name: (title || code) + '.mp4'
    });
}

async function api(ep, params = {}) {
    const url = new URL(`${API}/${ep}`);
    url.searchParams.set('key', apiKey);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return (await fetch(url)).json();
}

function setStatus(msg) { const el = $('#status'); el.textContent = msg; el.style.display = msg ? 'block' : 'none'; }
function esc(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }
function dur(s) { return s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : '?'; }
