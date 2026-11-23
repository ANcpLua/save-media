import { useId, useState } from "react";
import type { StreamDescriptor, TechnicalDetail, UserMessage } from "@savemedia/core";
import { dispatch, formatBytes, friendlyVideoCodec, friendlyAudioCodec, userMessage } from "@savemedia/core";
import type { JobStatus } from "../../types/messages";
import { describeTransfer, type TransferState } from "../../util/transfer-progress";
import { TransferProgress } from "./TransferProgress";
import { expectedSize, sizeText } from "../../util/expected-size";
import { compareDownloads, downloadOptions } from "../../util/downloadable";
import { dispatchRefusalToError } from "../../util/dispatch-refusal";
import { suggestFilename } from "../../util/filename";
import { sourceAddress } from "../../util/media-address";
import { formatDuration } from "../format";
import type { PreviewView as Preview } from "../../types/page-facts";
import { TechnicalDetails } from "./TechnicalDetails";
import { FailureMessage, offersRetry } from "./FailureMessage";
import { LocalOfferSlot } from "./LocalOffer";
import { DownloadIcon, PlayIcon } from "./Icons";
import { useAnnounce } from "./Announcer";
import { ask } from "../request";
import { ANNOUNCE, BUTTON, CONTAINER_NAMES, ITEM, POPUP, STREAM_TYPES, savedText } from "../../ui/text";

export type { JobStatus } from "../../types/messages";

interface Props {
  readonly descriptor: StreamDescriptor;
  /** Save the page's main video, as the popup shows it. `allowRepeat`: the user chose "Save another copy". */
  readonly onSaveBest?: ((allowRepeat: boolean) => void) | undefined;
  /** The primary card's file save is starting, or the browser is continuing its own download of it. */
  readonly preparing?: TransferState | undefined;
  readonly originalName?: string | undefined;
  /** The primary card's Save did not get as far as a save: why. */
  readonly startFailure?: UserMessage | undefined;
  readonly status?: JobStatus | undefined;
  readonly onCancel?: ((streamId: StreamDescriptor["id"]) => void) | undefined;
  readonly preview?: Preview | null | undefined;
  readonly isMain?: boolean | undefined;
  /** A page's ad response named this address: it is labelled as an ad. */
  readonly ad?: boolean | undefined;
  /** The stream is still being produced: it is labelled and has no Save. */
  readonly live?: boolean | undefined;
  readonly pageTitle?: string | null | undefined;
  readonly alternatives?: readonly StreamDescriptor[] | undefined;
  readonly statuses?: Readonly<Record<string, JobStatus>> | undefined;
  /** The background no longer knows this row (the page moved on, or its list was lost): look at the page again. */
  readonly onListingExpired?: (() => void) | undefined;
  /** Show the "you can close this popup" line under this card's running save. */
  readonly closeHint?: boolean | undefined;
}

type ButtonState = "save" | "retry" | "again" | "cancel" | "saving" | "preparing";

const BUTTON_LABEL: Readonly<Record<ButtonState, string>> = {
  save: BUTTON.save, retry: BUTTON.retry, again: BUTTON.again, cancel: BUTTON.cancel, saving: BUTTON.saving, preparing: BUTTON.preparing,
};

export function DetectedItem({ descriptor: initialDescriptor, status: initialStatus, onSaveBest, preparing, originalName, startFailure, alternatives = [], statuses, onCancel, preview = null, isMain = false, ad = false, live = false, pageTitle = null, onListingExpired, closeHint = false }: Props) {
  const titleId = useId();
  const announce = useAnnounce();
  const [chosenVariantId, setChosenVariantId] = useState<string | null>(null);
  const [chosenStreamId, setChosenStreamId] = useState<string | null>(null);
  const directChoices = [initialDescriptor, ...alternatives].sort(compareDownloads);
  const active = directChoices.find(d => statuses?.[d.id]?.phase === "active");
  const retained = originalName && directChoices.find(d => statuses?.[d.id]?.fileName === originalName
    && statuses[d.id]?.phase === "failed" && statuses[d.id]?.retained);
  const descriptor = active ?? directChoices.find(d => d.id === chosenStreamId) ?? (retained || directChoices[0]!);
  const status = statuses?.[descriptor.id] ?? (descriptor.id === initialDescriptor.id ? initialStatus : undefined);

  const options = downloadOptions(descriptor);
  const selection = options.find(o => o.variant?.id === chosenVariantId) ?? options[0];
  const variant = selection?.variant ?? descriptor.variants[0];
  const qualityChoices = options.flatMap(o => o.variant ? [o.variant] : []);
  const displayTitle = status?.fileName ?? originalName ?? descriptor.title ?? pageTitle ?? hostOf(descriptor.pageUrl);
  const previewSize = preview && preview.width > 0 && preview.height > 0 ? `${preview.width}×${preview.height}` : null;
  const sizeOf = (d: StreamDescriptor, choice: typeof variant) => expectedSize(d, choice, preview?.duration);
  const size = sizeOf(descriptor, variant);
  const vcodec = variant?.videoCodec ?? descriptor.codecs.video;
  const acodec = variant?.audioCodec ?? descriptor.codecs.audio;
  // A row listed from the browser's own answer was never checked: what it is, is found out when the user saves it.
  const unchecked = descriptor.unchecked === true;
  const isDownloadable = (!!selection || unchecked) && !live;
  const error = status?.phase === "failed" ? status.error : undefined;
  // "Choose a lower quality" is said only where this card lists one below the quality that was too large.
  const tooLarge = error?.code === "output_too_large_for_browser";
  const lowerListed = directChoices.indexOf(descriptor) < directChoices.length - 1
    || (!!selection?.variant && qualityChoices.indexOf(selection.variant) < qualityChoices.length - 1);
  const failure = error ? userMessage(error.code === "output_too_large_for_browser" && lowerListed ? { ...error, lowerQuality: true } : error) : null;
  const running = status?.phase === "active" ? describeTransfer(status) : null;

  function download(allowRepeat: boolean) {
    if ((!selection && !unchecked) || descriptor.drm) return;
    announce(ANNOUNCE.saving(displayTitle));
    if (selection && onSaveBest && (descriptor === directChoices[0] || descriptor === retained) && selection === options[0]) {
      onSaveBest(allowRepeat);
      return;
    }
    const choice = selection?.choice ?? { outputMode: "Original" as const, filename: suggestFilename(descriptor), variantId: null, audioRenditionId: null };
    ask({ type: "download", streamId: descriptor.id, choice, ...(allowRepeat ? { allowRepeat } : {}) }, reply => {
      if (reply?.outcome === "listing-expired") onListingExpired?.();
    });
  }

  function cancel() {
    if (onCancel) {
      onCancel(descriptor.id);
      return;
    }
    ask({ type: "cancel", streamId: descriptor.id }, () => undefined);
  }

  if (descriptor.drm) {
    // Protection is stated the same way here, in the Alt+S toast and for a refused save: one text from one error.
    return (
      <li className="rounded-lg bg-surface border border-line p-3 text-xs" data-testid="drm-card" data-deferred={descriptor.drm.reason === "clearkey_deferred"}>
        {descriptor.title && <p className="font-medium truncate mb-1" title={descriptor.title}>{descriptor.title}</p>}
        <FailureMessage message={userMessage(dispatchRefusalToError(descriptor.drm.reason, descriptor))}/>
      </li>
    );
  }

  const state: ButtonState | null = running ? (running.cancellable ? "cancel" : "saving")
    : preparing ? "preparing"
      : !isDownloadable ? null
        : status?.phase === "failed" || startFailure
          ? (offersRetry(failure ?? startFailure ?? null, status?.retained) ? "retry" : "save")
          : status?.phase === "complete" ? "again" : "save";
  const buttonColor = state === "cancel" || state === "saving" || state === "preparing" ? "bg-surface-2 text-white"
    : state === "retry" ? "bg-orange-950 text-orange-200" : "bg-emerald-400 text-ink";
  const resolution = variant && variant.width && variant.height ? `${variant.width}×${variant.height}`
    : variant?.height ? `${variant.height}p` : previewSize;
  const codecs = vcodec ? `${friendlyVideoCodec(vcodec)}${acodec ? ` + ${friendlyAudioCodec(acodec)}` : ""}` : CONTAINER_NAMES[descriptor.container] ?? null;
  const refusal = !isDownloadable && !live && !status ? unsupportedError(descriptor) : null;

  return (
    <li className={`rounded-lg bg-surface border p-3 text-xs ${isMain ? "border-muted/60" : "border-line"}`} data-main={isMain || undefined}>
      <div className="flex gap-2.5">
        {/* Only a frame captured in the page: the popup never requests an address a page names. */}
        {preview?.thumbnail?.startsWith("data:image/") ? (
          <img
            src={preview.thumbnail}
            alt=""
            className="w-[88px] h-[50px] rounded object-cover bg-surface-2 shrink-0"
            data-testid="preview-thumb"
          />
        ) : (
          <div className="w-[88px] h-[50px] rounded bg-surface-2 shrink-0 flex items-center justify-center text-neutral-500">
            <PlayIcon className="w-5 h-5"/>
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {isMain && <span className="shrink-0 rounded bg-surface-2 text-muted font-semibold px-1 text-[10px]" data-testid="main-badge">{POPUP.mainBadge}</span>}
            {ad && <span className="shrink-0 rounded bg-surface-2 text-muted font-semibold px-1 text-[10px]" data-testid="ad-badge">{POPUP.adBadge}</span>}
            {live && <span className="shrink-0 rounded bg-surface-2 text-amber-400 font-semibold px-1 text-[10px]" data-testid="live-badge">{POPUP.liveBadge}</span>}
            <span id={titleId} className="font-medium truncate flex-1" title={displayTitle} data-testid="item-title">{displayTitle}</span>
          </div>
          <div className="text-muted leading-relaxed mt-0.5" data-testid="item-meta">
            {[
              resolution,
              preview?.duration ? formatDuration(preview.duration) : null,
              size ? <span key="size" data-testid="expected-size" title={size.exact ? ITEM.exactTitle : ITEM.estimateTitle}>{sizeText(size)}</span> : null,
              codecs,
            ].filter(part => part !== null && part !== undefined && part !== "").flatMap((part, index) => index === 0 ? [part] : [" · ", part])}
          </div>
        </div>
      </div>

      {directChoices.length > 1 && status?.phase !== "active" && (
        <label className="mt-2 ml-5 flex items-center gap-2 text-muted">
          {POPUP.quality}
          <select className="bg-surface-2 rounded-md px-1.5 py-0.5 text-[12px] text-white"
            value={descriptor.id} onChange={e => { setChosenStreamId(e.target.value); setChosenVariantId(null); }}
            data-testid="quality-select">
            {directChoices.map(d => {
              const choiceSize = sizeOf(d, downloadOptions(d)[0]?.variant ?? d.variants[0]);
              return (
                <option key={d.id} value={d.id}>
                  {d.variants[0]?.height ? `${d.variants[0].height}p` : POPUP.original}{choiceSize ? ` · ${sizeText(choiceSize)}` : ""}
                </option>
              );
            })}
          </select>
        </label>
      )}

      {directChoices.length === 1 && qualityChoices.length > 1 && (!status || tooLarge) && (
        <label className="mt-2 ml-5 flex items-center gap-2 text-muted">
          {POPUP.quality}
          <select
            className="bg-surface-2 rounded-md px-1.5 py-0.5 text-[12px] text-white"
            value={variant?.id ?? ""}
            onChange={e => setChosenVariantId(e.target.value)}
            data-testid="quality-select"
          >
            {qualityChoices.map((v, index) => (
              <option key={v.id} value={v.id}>{qualityLabel(v, index, sizeOf(descriptor, v))}</option>
            ))}
          </select>
        </label>
      )}

      {running ? <div className="ml-5">
        <TransferProgress status={status!}/>
        {closeHint && <p className="mt-1 text-muted" data-testid="close-hint">{POPUP.closeHint}</p>}
      </div>
        : preparing ? <div className="ml-5"><TransferProgress status={preparing}/></div>
        : startFailure && !failure && <FailureMessage className="mt-2 ml-5" testId="could-not-start" message={startFailure}/>}

      {!preparing && error && failure && (
        <FailureMessage className="mt-2 ml-5" testId="job-error" message={failure} retained={status?.retained} extra={<LocalOfferSlot error={error}/>}/>
      )}

      {!preparing && status?.phase === "complete" && (
        <p className="mt-2 ml-5 text-emerald-400" data-testid="job-complete">
          {savedText(status.savedAs, status.bytesTotal ? formatBytes(status.bytesTotal) : null)}
        </p>
      )}

      {live && !status && (
        <FailureMessage className="mt-2 ml-5" testId="live-card" message={userMessage({ code: "hls_live_unsupported", severity: "terminal", manifestUrl: sourceAddress(descriptor) })}/>
      )}

      {refusal && <FailureMessage className="mt-2 ml-5" testId="unsupported-card" message={userMessage(refusal)} extra={<LocalOfferSlot error={refusal}/>}/>}

      <div className="mt-2 ml-5">
        <TechnicalDetails about="item" rows={itemRows(descriptor, variant, size, vcodec, acodec)}/>
      </div>

      {state && (
        <div className="mt-2 ml-5 flex items-center gap-2">
          {/* A user's own cancel is a neutral end: the card goes back to Save and says so quietly. */}
          {status?.phase === "cancelled" && !running && !preparing && <span className="text-muted" data-testid="job-cancelled">{POPUP.cancelled}</span>}
          {/* One button for the card's whole life: its label changes, the element and the keyboard focus stay. */}
          <button
            type="button"
            aria-describedby={titleId}
            disabled={state === "saving" || state === "preparing"}
            onClick={() => state === "cancel" ? cancel() : download(state === "again")}
            className={`ml-auto inline-flex items-center gap-1 hover:brightness-110 disabled:opacity-60 font-medium px-2.5 py-1 rounded-md text-xs ${buttonColor}`}
            data-testid="item-action"
          >
            {(state === "save" || state === "retry" || state === "again") && <DownloadIcon/>}
            {BUTTON_LABEL[state]}
          </button>
        </div>
      )}
    </li>
  );
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

const megabits = (bitrate: number): string => `${(bitrate / 1e6).toFixed(1)} Mbps`;

/**
 * One line of the Quality menu: "1080p 60 · 245.3 MB". A stream need not state its picture height: such a
 * quality is named by its bitrate, or by its place in the list. A variant's id is an address and is never shown.
 */
function qualityLabel(v: StreamDescriptor["variants"][number], index: number, size: ReturnType<typeof expectedSize>): string {
  const name = v.height ? `${v.height}p${v.frameRate && v.frameRate > 30 ? ` ${Math.round(v.frameRate)}` : ""}`
    : v.bitrate ? megabits(v.bitrate) : POPUP.qualityNumber(index + 1);
  const amount = size ? sizeText(size) : v.height && v.bitrate ? megabits(v.bitrate) : null;
  return amount ? `${name} · ${amount}` : name;
}


/** Why a listed item has no Save: the reason dispatch gives for it, as the error every surface words the same way. */
function unsupportedError(d: StreamDescriptor) {
  const plan = dispatch(d, { outputMode: "Original", filename: suggestFilename(d), variantId: null, audioRenditionId: null });
  return plan.kind === "refuse" ? dispatchRefusalToError(plan.reason, d, plan)
    : dispatchRefusalToError("unsupported_output", d);
}

/** The technical facts of an item, in words. They live behind the disclosure, never in the card's first lines. */
function itemRows(d: StreamDescriptor, variant: StreamDescriptor["variants"][number] | undefined, size: ReturnType<typeof expectedSize>,
  vcodec: StreamDescriptor["codecs"]["video"], acodec: StreamDescriptor["codecs"]["audio"]): TechnicalDetail[] {
  const rows: (TechnicalDetail | null)[] = [
    CONTAINER_NAMES[d.container] ? { label: ITEM.format, value: CONTAINER_NAMES[d.container]! } : null,
    { label: ITEM.streamType, value: d.source.kind === "media-element" ? STREAM_TYPES.element : d.protocol === "hls" ? STREAM_TYPES.hls
      : d.protocol === "dash" ? STREAM_TYPES.dash : STREAM_TYPES.direct },
    vcodec ? { label: ITEM.video, value: friendlyVideoCodec(vcodec) } : null,
    acodec ? { label: ITEM.audio, value: friendlyAudioCodec(acodec) } : null,
    variant?.bitrate ? { label: ITEM.bitrate, value: megabits(variant.bitrate) } : null,
    size ? { label: ITEM.size, value: size.exact ? ITEM.sizeExact(sizeText(size)) : ITEM.sizeEstimate(sizeText(size)) } : null,
    variant?.frameRate ? { label: ITEM.frameRate, value: `${Math.round(variant.frameRate)} fps` } : null,
    hostOfAddress(sourceAddress(d)) ? { label: ITEM.server, value: hostOfAddress(sourceAddress(d))! } : null,
  ];
  return rows.filter((row): row is TechnicalDetail => row !== null);
}

function hostOfAddress(url: string): string | null {
  try { return new URL(url).host || null; } catch { return null; }
}
