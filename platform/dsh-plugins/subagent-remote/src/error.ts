import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Platform transport failures retain Scheduler and host wire codes.
 * Upstream SubagentError is reserved for its closed service error vocabulary;
 * remote infrastructure codes still belong to the common HarnessError family.
 */
export class RemoteSubagentError extends HarnessError {
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'RemoteSubagentError'
  }
}
