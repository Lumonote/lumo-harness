/** A deployment-approved native route bound to the single pricing registry.
 * billingModel is an llm_providers primary key, never supplied by a browser. */
export interface SessionModelBillingRoute { provider: string; model: string; billingModel: string }
export interface ModelRateQuote extends SessionModelBillingRoute { inputPerMtok: number; outputPerMtok: number }
export interface SessionModelBilling { quote(route: SessionModelBillingRoute): Promise<ModelRateQuote> }

export function quotedModelCost(quote: ModelRateQuote, input: number, output: number): number {
  if (![quote.inputPerMtok, quote.outputPerMtok, input, output].every(n => Number.isFinite(n) && n >= 0)) throw new Error('Invalid model rate or usage')
  const cost = (input * quote.inputPerMtok + output * quote.outputPerMtok) / 1e6
  if (!Number.isFinite(cost)) throw new Error('Model cost exceeds bounds')
  return cost
}
