# savemedia privacy policy

Effective date: 2026-11-23

savemedia runs in your browser. It has no account, no server, no analytics and no ads. It does not sell or share data.

## What savemedia reads

On the pages you visit, only to find, check and save media:

- the page address and title, and the media the page declares: video and source elements, links to media files, and player data in the page's own markup;
- the addresses and response headers of the page's media requests and of the requests its scripts make for data (fetch and XHR), as your browser reports them, to find the media among them, and the network address of the server that answered;
- for the page itself and its frames: only whether the server that answered them is inside your own network. Nothing else of them is read this way;
- the first bytes of a candidate file, or the text of a playlist, to check what it is;
- inside the page, the content of ad descriptions and playlists the page itself loads, only to recognise ads so they are never offered as the page's video. A script of savemedia that runs in the page reads these answers as the page receives them. It requests nothing and changes nothing;
- on the pages of two sites (three in builds made from the source code), the site's own player answers, read the same way, to find the page's video files;
- whether the page's player uses protected playback (DRM), only so savemedia can refuse it;
- a small frame of each video on the page, shown as a thumbnail in the popup;
- the pointer position when you press Alt+S, to find the video or image under it;
- for its own requests: the browser's error code, the server's network address and a redirect to another server, to explain a failed save;
- whether the page your tab last opened failed to load, so savemedia can say so and offer to reload it;
- when you save a file a page links to: your browser's list of interrupted downloads for that file, so your browser can continue it.

Thumbnails, pointer positions and file contents stay in memory and are discarded after use. A key for standard HLS AES-128 is used in memory for that save and is never stored.

## What savemedia stores, and for how long

| What | Where | How long |
| --- | --- | --- |
| Media found on each tab: addresses, response headers, the server's network address, what the page's players last reported (source addresses, sizes, play state, page title) and the state of running saves | memory and browser session storage | until the tab navigates or closes, or the browser closes |
| For up to four earlier pages of a tab: the media addresses and server network addresses the page received, the addresses of video answers its scripts fetched, and the servers inside your own network that your browser loaded something from for it, so going back shows the same list | memory and browser session storage | until the tab closes or the browser closes |
| For the page that is open: the servers inside your own network (scheme, host and port) that your browser itself loaded the page, a frame, media or data from, up to 64 per page | memory and browser session storage | until the tab navigates or closes, or the browser closes. After the tab navigates, they are kept as the row above says |
| Referer rules for savemedia's own requests: the media server's host name and the page's origin | browser session storage and the browser's session rules | while a save or check uses them. Up to 64 unused rules are kept for the next check of the same server, until the browser closes |
| A download your browser is continuing for savemedia: the page address, the file name and the browser's download number | browser session storage | until that download ends or the tab closes |
| A receipt for each saved file or image: a hash, without address or name | browser session storage | until the browser closes |
| An open question about saving a file a second time: the file name and the page address, and for an image its address | browser session storage | until you answer, or the tab navigates or closes |
| Parts of an interrupted file, so Retry save can continue | memory | up to 10 minutes, or until the extension reloads |
| What the browser reported about savemedia's own requests: server host names, network addresses, error codes | memory | not used after 10 minutes, and gone when savemedia's background worker stops |
| Diagnostic events for the current page, up to 128 per tab: times, server host names, kinds of network address, numeric HTTP data and error codes | browser session storage | until the tab reloads, navigates or closes |
| Local downloader settings | extension storage, readable only by savemedia's own pages | until you change them or remove savemedia |

Browser session storage is kept in memory by your browser and is cleared when the browser closes or the extension is updated, reloaded or turned off.

savemedia cannot be turned on in private (incognito) windows. An extension that runs there makes its own requests with the cookies of your normal windows and lists its saves among their downloads, so savemedia stays out of private windows altogether.

## What leaves your device

- Nothing goes to the developer.
- To check and save media, savemedia requests the media addresses your browser loaded for the page, the way the page's own player does. When you open the popup or press Alt+S, it also requests the media addresses the page declares (in its video elements, its player data and its file links), the way the page's player would when you press Play. Such an address can be on a server your browser has not contacted for that page yet. These requests carry your browser's cookies for that server and the page's origin (its scheme and host, without the path) as Referer and Origin. They use your browser's own network settings: its DNS, proxy and certificate checks.
- For a page on the internet, savemedia requests a server inside your own network only when your browser itself loaded something from that same server for that page. A local server a page only names is not requested. savemedia knows such a server by its address, or by a name that only your own network answers (one word such as "nas", or a name ending in .local, .localhost, .home.arpa or .internal). One limit: a public name that leads into your network on savemedia's own request is requested once, because only the answer shows where the name led, and that answer is not used.
- An ad is requested by savemedia only when you press Save on it in the Ads list. Otherwise savemedia lists an ad your browser loaded from what your browser received, and requests nothing.
- Local downloader (optional, off by default): when you turn it on, your browser asks for permission to talk to the savemedia helper, a program you install yourself. savemedia then sends it the page address and your settings (quality and cookie source). The helper runs your own yt-dlp and ffmpeg, which contact the site directly. Unless you choose No cookies, yt-dlp reads the cookies of this browser, or of the browser you pick under Cookies, on your computer. yt-dlp also applies your own yt-dlp configuration. The helper keeps a log of its jobs without page addresses, and yt-dlp's download archive with the site and video ID of each video it saved. Both stay on your computer.
- Diagnostic export: Export diagnostic log saves a file to your Downloads folder. It contains no URL paths, query strings, file names, cookies, authorization headers or response bodies. Servers and pages appear by host name, and a server's network address only as its kind (such as local network or internet). A server or page that is addressed by a number instead of a name, such as a device on your network, appears with that address. You decide whether to share it.

## Permissions

- Access to the sites you visit: to see the media pages load and to request it for saving.
- downloads: to save verified files, to confirm a save finished, and to continue an interrupted download of the same file.
- tabs: to know which page a video belongs to, and to follow the active tab in the savemedia window.
- webRequest: to see which of a page's media and data requests carry media, whether a page or frame was answered from inside your own network, and the error code and server address of savemedia's own requests. savemedia only reads these events. It never blocks or changes a request with them.
- webNavigation: to know which frames a tab has, when one shows a new page, and when a page failed to load, so media is listed for the page that is open now.
- declarativeNetRequestWithHostAccess: to give savemedia's own requests the page's origin as Referer and Origin, as the browser does for the page. It never changes your own browsing. A rule is held while a save or check uses it, and every rule ends with the browser session.
- offscreen (Chrome and Edge): to assemble streams into one file in a hidden extension page.
- storage: for the items in the table above.
- nativeMessaging (optional): only after you turn on the Local downloader.

## Protected media and access

savemedia never saves DRM-protected media. It saves only what your browser already receives, so it adds no access: a server that wants a sign-in, a purchase or a region still decides what it sends. savemedia never operates a site's controls.

## Chrome Web Store Limited Use

savemedia's use of information received from browser extension APIs adheres to the Chrome Web Store User Data Policy, including the Limited Use requirements. It uses data only for its single purpose and does not transfer, sell or use it for anything else.

## Contact

Use the store's developer contact or https://github.com/ANcpLua/save-media.
