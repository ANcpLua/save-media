import type { JobPlan, DispatchRefusal } from "@savemedia/core";

export type OutputActionLabel =
  | "direct"
  | "hls-plain"
  | "hls-aes"
  | "dash"
  | "refused";

export function outputActionFromPlan(plan: JobPlan | DispatchRefusal): OutputActionLabel {
  switch (plan.kind) {
    case "direct":     return "direct";
    case "hls-plain":  return "hls-plain";
    case "hls-aes":    return "hls-aes";
    case "dash":       return "dash";
    case "refuse":     return "refused";
  }
}
