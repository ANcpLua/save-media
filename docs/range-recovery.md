# Direct-file range recovery

The browser implementation adapts `internal/rescue/downloader.go` and
`internal/rescue/validate.go` from the local Video Rescue checkout at commit
`09e855aa8172e7b83488e134a562f40bd197879d`. Its MIT license is bundled in
`packages/extension/public/licenses/video-rescue-MIT.txt`.

Discovery requests the first 4 KiB of a direct video. It retries network errors,
timeouts, truncated responses, HTTP 408, 429 and 5xx responses up to three
attempts. It rejects unsuccessful HTTP responses before classification and
cancels the response body after a bounded read if the server ignores Range.
Manifest requests still read the complete manifest.

For HTTPS files below the existing 2 GiB browser output limit, a valid range
response plus a strong ETag or Last-Modified validator selects the recovery
engine. Other direct files retain the browser's normal download path.

The engine probes again, then downloads 4 MiB chunks with four concurrent
workers. Each chunk carries `If-Range`, checks its exact Content-Range and byte
count, and gets up to twelve attempts with a capped linear backoff. Changed
validators, inconsistent ranges, encoded ranges, and ignored range requests
stop the job. Cancellation and terminal failures abort and join all workers.
Progress counts accepted bytes once, and chunks are assembled in file order.

Only a complete byte count and successful container check produce a Blob URL.
MP4 checks walk top-level box boundaries and require the file-type, movie, and
media boxes. WebM and Matroska checks identify the EBML header. These are
structural checks, not full decoding or proof that every frame is playable.
The browser adaptation does not perform native FFmpeg validation, calculate a
whole-file checksum, or reuse files from Chrome's download directory.

Tests use generated local media and a local HTTPS server. They cover transient
probe failures, truncated chunks, out-of-order completion, file changes,
authorization failures, cancellation, size limits and exact reconstructed
bytes. Persistent server failures still fail after the retry budget; no URL,
permission, signature, or protected-content handling is added.
