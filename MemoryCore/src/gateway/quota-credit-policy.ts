/**
 * Credit reporting policy -- decides the CreditDelta value reported to UpdateMemoryPlusUsage
 * when kernel L1/L2/L3 extraction completes.
 *
 * Background: when llm.provider="proxy", context_proxy has already reported a CreditDelta = total_tokens
 * to the same UpdateMemoryPlusUsage after the LLM response completed (see
 * context_proxy/src/credit-reporter.ts). If the kernel reported the tokens of the same call again,
 * it would cause double billing.
 *
 * Policy:
 *   - provider="openai": return as-is -- the kernel is the only credit reporter
 *   - provider="proxy": return 0 -- the proxy has already reported, so the kernel skips
 *
 * memoryDelta is unrelated to this policy: memory is a kernel-only semantic (how many memories were written),
 * the proxy knows nothing about it, and it must be reported by the kernel.
 */

export type LlmProvider = "openai" | "proxy";

export function shouldSkipCreditReport(provider: LlmProvider | undefined): boolean {
  return (provider ?? "openai") === "proxy";
}

/**
 * Compute the CreditDelta that should actually be reported.
 *
 * @param rawCreditUsed  token count accumulated in the kernel's llmRunner.accumulatedCredit
 * @param provider       llm.provider
 * @returns the CreditDelta to report (always 0 when provider=proxy)
 */
export function resolveReportedCredit(
  rawCreditUsed: number,
  provider: LlmProvider | undefined,
): number {
  return shouldSkipCreditReport(provider) ? 0 : rawCreditUsed;
}
