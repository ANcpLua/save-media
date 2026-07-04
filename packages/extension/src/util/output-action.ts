import type { JobPlan, DispatchRefusal } from "@savemedia/core";

export type OutputActionLabel =
  | "direct"
  | "hls-plain"
  | "av-merge"
  | "refused";

export function outputActionFromPlan(plan: JobPlan | DispatchRefusal): OutputActionLabel {
  switch (plan.kind) {
    case "direct":     return "direct";
    case "hls-plain":  return "hls-plain";
    case "av-merge":   return "av-merge";
    case "refuse":     return "refused";
  }
}
