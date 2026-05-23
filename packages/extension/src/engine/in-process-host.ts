import type { BackgroundToEngineMessage, EngineToBackgroundMessage } from "../types/messages";
import { createEngineRunner } from "./runner";
import { downloadJob as defaultDownloadJob } from "./download";
import type { DownloadJob } from "./job";

export interface InProcessEngineHost {
  readonly handleMessage: (msg: BackgroundToEngineMessage) => void;
}

export interface InProcessEngineHostDeps {
  readonly sendToBackground: (msg: EngineToBackgroundMessage) => void;
  readonly downloadJob?: DownloadJob;
}

export function createInProcessEngineHost(deps: InProcessEngineHostDeps): InProcessEngineHost {
  const runner = createEngineRunner({
    runtime: {
      sendMessage: msg => deps.sendToBackground(msg as EngineToBackgroundMessage),
    },
    downloadJob: deps.downloadJob ?? defaultDownloadJob,
  });

  return {
    handleMessage(msg) {
      if (msg.type === "start-job") {
        void runner.start(msg.streamId, msg.descriptor, msg.choice);
        return;
      }
      runner.cancel(msg.streamId);
    },
  };
}
