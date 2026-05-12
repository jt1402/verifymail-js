/**
 * Response types — mirror the backend Pydantic models in app/models/check.py.
 * Kept hand-written rather than codegen so the surface stays small and readable.
 */

export type Recommendation = "allow" | "allow_with_flag" | "block";
export type RiskLevel = "low" | "medium" | "high" | "critical";
export type ConfidenceLevel = "low" | "medium" | "high";
export type RiskProfile = "strict" | "balanced" | "permissive";
export type ModelPhase = "bootstrap" | "calibrated" | "optimised";
export type SignalDirection = "risk" | "trust";

export interface Meta {
  request_id: string;
  email: string;
  domain: string;
  checked_at: string;
  latency_ms: number;
  api_version: string;
  model_phase: ModelPhase;
  model_version: string;
  path_taken: string;
  cached: boolean;
  cache_age_seconds: number | null;
}

export interface Verdict {
  recommendation: Recommendation;
  risk_level: RiskLevel;
  disposable: boolean;
  catch_all: boolean | null;
  catch_all_checked: boolean;
  valid_address: boolean;
  safe_to_send: boolean;
  summary: string;
  degraded_mode?: boolean;
  degraded_reason?: string | null;
}

export interface ScoreComponents {
  strong_signals: number;
  corroborating: number;
  trust_adjustments: number;
  compounding_bonus: number;
  final_clamped: number;
}

export interface Thresholds {
  block_at: number;
  flag_at: number;
  your_profile: RiskProfile;
}

export interface CatchAllDetail {
  detected: boolean;
  probability: number;
  confidence: number;
  legitimate_use_likely: boolean;
  type: "confirmed" | "suspected" | "cleared";
}

export interface Score {
  value: number;
  confidence: number;
  confidence_level: ConfidenceLevel;
  components: ScoreComponents;
  thresholds: Thresholds;
  catch_all_detail: CatchAllDetail | null;
}

export interface Signal {
  name: string;
  category: string;
  direction: SignalDirection;
  weight: number;
  description: string;
  value?: unknown;
  unit?: string | null;
  probe_result?: Record<string, unknown> | null;
  extra?: Record<string, unknown>;
}

export interface Compounding {
  applied: boolean;
  signal_count: number;
  bonus_applied: number;
  explanation: string;
}

export interface Signals {
  fired: Signal[];
  trust_signals: Signal[];
  suppressed?: { name: string; reason: string }[];
  compounding: Compounding;
}

export interface CheckStep {
  name: string;
  status: string;
  duration_ms: number;
  result: string | null;
  probe_detail?: Record<string, unknown> | null;
}

export interface ChecksBlock {
  run: CheckStep[];
  skipped?: CheckStep[];
  failed?: CheckStep[];
  path_explanation: string;
}

/** Full /v1/check response (5-block schema). */
export interface CheckResponse {
  meta: Meta;
  verdict: Verdict;
  score: Score;
  signals: Signals;
  checks: ChecksBlock;
}

export interface BulkSummary {
  total: number;
  credits_charged: number;
  credits_remaining: number;
  elapsed_ms: number;
}

export interface BulkCheckResponse {
  items: CheckResponse[];
  summary: BulkSummary;
}

/** One line from /v1/check/bulk/stream. */
export type BulkStreamEvent =
  | { index: number; result: CheckResponse }
  | {
      event: "summary";
      total: number;
      credits_charged: number;
      credits_remaining: number;
      elapsed_ms: number;
    };

export interface AsyncCheckResponse {
  request_id: string;
  status: "pending";
  preliminary: CheckResponse;
  webhook_url: string;
  estimated_completion_ms: number;
}

export interface ReportRequest {
  domain: string;
  outcome: "confirmed_throwaway" | "confirmed_legitimate" | "suspected_throwaway";
  notes?: string;
}

export interface ReportResponse {
  accepted: boolean;
  queued_for_review: boolean;
  review_sla_hours: number;
  report_id: string;
  message: string;
}

export interface UsageMeResponse {
  total_checks: number;
  checks_this_period: number;
  period_start: string;
  blocks: number;
  allow_with_flag: number;
  allows: number;
  avg_latency_ms: number;
  cache_hit_rate: number;
  credit_balance_checks: number;
}

export interface StatusResponse {
  status: "ok" | "degraded";
  components: {
    redis: "ok" | "degraded";
    postgres: "ok" | "degraded";
    dns: "ok" | "degraded";
  };
  latency_ms: number;
}

/** Async webhook event posted to the customer's webhook_url. */
export interface CheckCompletedEvent {
  request_id: string;
  event: "check.completed";
  result: CheckResponse;
}
