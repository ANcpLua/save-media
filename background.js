'use strict';

let _busy = false;

chrome.runtime.onMessage.addListener((msg, sender) => {
    const tab = sender.tab?.id;

    if (msg.isDrm) return notify(tab, 'Widevine DRM — not possible');

    if (msg.isVideo) {
        if (_busy) return notify(tab, 'Download running — wait');
        _busy = true;

        chrome.storage.local.get('quality', (d) => {
            chrome.runtime.sendNativeMessage('com.savemedia.host',
                { url: msg.pageUrl, quality: msg.quality || d.quality || 'best' },
                (resp) => {
                    _busy = false;
                    if (chrome.runtime.lastError)
                        return notify(tab, 'Native host: ' + chrome.runtime.lastError.message);
                    notify(tab, resp?.success
                        ? 'Video saved'
                        : resp?.error || resp?.output?.match(/ERROR: (.+)/)?.[1] || 'Failed — check log');
                }
            );
        });
        return;
    }

    if (msg.url || msg.dataUrl) {
        const url = msg.dataUrl || msg.url;
        const name = (msg.name || 'download').replace(/[^a-zA-Z0-9._-]/g, '_');
        chrome.downloads.download({ url, filename: name }, () => {
            if (chrome.runtime.lastError)
                chrome.downloads.download({ url });
        });
    }
});

function notify(tab, msg) {
    if (tab) chrome.tabs.sendMessage(tab, { toast: msg });
}
