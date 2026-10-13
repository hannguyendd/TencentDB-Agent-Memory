/**
 * CreditCalculator — computes Credit consumption from token usage and model coefficients
 *
 * Rules (anchor: MiniMax M2.7):
 * - Input:  1.0 Credit / 1k tokens
 * - Cache:  0.2 Credit / 1k tokens
 * - Output: 4.0 Credit / 1k tokens
 * - Model coefficients: M2.7=1.0, flagship=15.0, high-speed=0.8
 */

export interface TokenUsage {
  inputTokens: number;
  cacheTokens?: number;
  outputTokens: number;
}

export interface CreditRates {
  inputRate: number;   // Credit per 1k input tokens (default: 1.0)
  cacheRate: number;   // Credit per 1k cache tokens (default: 0.2)
  outputRate: number;  // Credit per 1k output tokens (default: 4.0)
}

/** Model coefficient table (extensible via configuration) */
const DEFAULT_MODEL_MULTIPLIERS: Record<string, number> = {
  "minimax-m2.7": 1.0,
  "MiniMax-M1": 1.0,
  // flagship
  "gpt-4o": 15.0,
  "gpt-5": 15.0,
  "claude-4.5-sonnet": 15.0,
  // high-speed
  "deepseek-v3.2": 0.8,
  "deepseek-v3": 0.8,
};

const DEFAULT_RATES: CreditRates = {
  inputRate: 1.0,
  cacheRate: 0.2,
  outputRate: 4.0,
};

export class CreditCalculator {
  private rates: CreditRates;
  private modelMultipliers: Record<string, number>;
  private defaultMultiplier: number;

  constructor(opts?: {
    rates?: Partial<CreditRates>;
    modelMultipliers?: Record<string, number>;
    defaultMultiplier?: number;
  }) {
    this.rates = { ...DEFAULT_RATES, ...opts?.rates };
    this.modelMultipliers = { ...DEFAULT_MODEL_MULTIPLIERS, ...opts?.modelMultipliers };
    this.defaultMultiplier = opts?.defaultMultiplier ?? 1.0;
  }

  /**
   * Compute the Credit consumption of a single LLM call
   * @returns Credits consumed (raw float, kept strictly consistent with the monitoring side)
   */
  calculate(usage: TokenUsage, model: string): number {
    const multiplier = this.modelMultipliers[model] ?? this.defaultMultiplier;

    const inputCredits = (usage.inputTokens / 1000) * this.rates.inputRate;
    const cacheCredits = ((usage.cacheTokens ?? 0) / 1000) * this.rates.cacheRate;
    const outputCredits = (usage.outputTokens / 1000) * this.rates.outputRate;

    const total = (inputCredits + cacheCredits + outputCredits) * multiplier;

    return total;
  }

  /** Get the model coefficient */
  getMultiplier(model: string): number {
    return this.modelMultipliers[model] ?? this.defaultMultiplier;
  }
}
