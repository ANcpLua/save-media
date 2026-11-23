import type { StreamDescriptor } from "@savemedia/core";
import type { BackgroundToEngineMessage, EngineEvent, EngineHello } from "../types/messages";
import { createEngineRunner } from "./runner";
import { downloadJob as defaultDownloadJob } from "./download";
import type { DownloadJob } from "./job";
import { holdsCheckpoint, onCheckpointRelease, retainedScope } from "./net/range-checkpoint";
import { isJobError, type JobError } from "@savemedia/core";
import { observedAmong } from "../util/address-space";
import { runImageJob, type ImageJobResult } from "./jobs/image";

export interface InProcessEngineHost {
  readonly handleMessage: (msg: BackgroundToEngineMessage) => void;
  /** What the engine is doing now, for the hello a background gets when the port opens. */
  readonly snapshot: () => Pick<EngineHello, "active" | "retained" | "idle">;
}

export interface InProcessEngineHostDeps {
  readonly sendToBackground: (msg: EngineEvent) => void;
  readonly downloadJob?: DownloadJob;
  /** Gives a job's media hosts the page's Referer; settles when the rules are in place. */
  readonly prepareRequests?: (streamId: StreamDescriptor["id"], urls: readonly string[]) => Promise<void>;
  readonly imageJob?: (url: string, signal: AbortSignal, pageUrl?: string, localOrigins?: readonly string[]) => Promise<ImageJobResult>;
}

/**
 * Runs engine jobs and reports "idle" whenever nothing keeps the engine
 * document needed: no active job, no output Blob the background has not
 * released, and no retained bytes waiting for Retry save.
 */
export function createInProcessEngineHost(deps: InProcessEngineHostDeps): InProcessEngineHost {
  const outputs = new Set<string>();
  const runner = createEngineRunner({
    runtime: {
      sendMessage: msg => {
        const message = msg as EngineEvent;
        if (message.type === "complete") outputs.add(message.blobUrl);
        deps.sendToBackground(message);
      },
    },
    ...(deps.prepareRequests ? { prepareRequests: deps.prepareRequests } : {}),
    downloadJob: deps.downloadJob ?? ((descriptor, choice, context) => defaultDownloadJob(descriptor, choice, {
      ...context,
      reportHttp: observation => deps.sendToBackground({type: "transfer-http", streamId: descriptor.id, observation}),
    })),
  });

  /** The image jobs under way, each with the switch that ends its request. */
  const images = new Map<string, AbortController>();
  const idle = (): boolean => !runner.active().length && !images.size && !outputs.size && !holdsCheckpoint();
  function reportIdle(): void {
    if (idle()) deps.sendToBackground({ type: "idle" });
  }

  /** The verified bytes become the output: the background saves that Blob, never the address again. */
  async function saveImage(streamId: string, url: string, pageUrl?: string, localOrigins?: readonly string[]): Promise<void> {
    const controller = new AbortController();
    images.set(streamId, controller);
    try {
      const run = deps.imageJob ?? ((address, signal, page, origins) => runImageJob(address, signal, undefined, page, observedAmong(origins)));
      const result = await run(url, controller.signal, pageUrl, localOrigins);
      if (result.kind === "refused") {
        deps.sendToBackground({ type: "image-refused", streamId, received: result.received });
        return;
      }
      const blobUrl = URL.createObjectURL(result.blob);
      outputs.add(blobUrl);
      deps.sendToBackground({ type: "image-complete", streamId, blobUrl, filename: result.filename });
    } catch (error) {
      const failure: JobError = controller.signal.aborted ? { code: "user_cancelled", severity: "terminal" }
        : isJobError(error) ? error
        : { code: "engine_job_failed", severity: "terminal", at: "direct", detail: error instanceof Error ? error.message : String(error) };
      deps.sendToBackground({ type: "image-failed", streamId, error: failure });
    } finally {
      images.delete(streamId);
      reportIdle();
    }
  }
  onCheckpointRelease(reportIdle);

  return {
    snapshot: () => ({ active: runner.snapshot(), retained: retainedScope(), idle: idle() }),
    handleMessage(msg) {
      if (msg.type === "start-job") {
        void runner.start(msg.streamId, msg.descriptor, msg.choice, msg.resumeKey, msg.localOrigins).then(reportIdle);
        return;
      }
      if (msg.type === "start-image") {
        void saveImage(msg.streamId, msg.url, msg.pageUrl, msg.localOrigins);
        return;
      }
      if (msg.type === "release-output") {
        URL.revokeObjectURL(msg.blobUrl);
        outputs.delete(msg.blobUrl);
        reportIdle();
      } else if (msg.type === "cancel-job") {
        // An image job ends its request at once; a video job is told to stop.
        const image = images.get(msg.streamId);
        if (image) image.abort(new DOMException("The image save was given up", "AbortError"));
        else runner.cancel(msg.streamId);
      }
      // welcome, ack and requests-prepared belong to the link between the two contexts, not to a job.
    },
  };
}
