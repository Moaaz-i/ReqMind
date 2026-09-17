import type { AdaptiveMetrics, HttpMethod } from "../types.js";
import type { EndpointAdaptiveState } from "./decisions.js";
import type { AdaptiveEngine } from "./engine.js";

/** Public inspect/control surface exposed as `client.adaptive()`. */
export interface AdaptiveController {
  /**
   * Full readout: enabled flag + per-endpoint adaptive state (effective
   * concurrency, pressure mode, explainable reasons, observed signals).
   */
  snapshot(): { enabled: boolean; endpoints: Record<string, EndpointAdaptiveState> };
  /** Readout for one endpoint (`METHOD pathname`). */
  endpoint(method: HttpMethod, path: string): EndpointAdaptiveState | undefined;
  /** Rolled-up adaptive counters (also surfaced under `intelligence().snapshot()`). */
  metrics(): AdaptiveMetrics;
  /** Forget every learned profile and counters; ceilings return to configured. */
  reset(): void;
}

export function createAdaptiveController(engine: AdaptiveEngine): AdaptiveController {
  return {
    snapshot: () => engine.snapshot(),
    endpoint: (method: HttpMethod, path: string) => engine.endpoint(method + " " + path),
    metrics: () => engine.metrics(),
    reset: () => engine.reset(),
  };
}