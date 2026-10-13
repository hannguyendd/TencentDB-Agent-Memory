import type { MetaCallContext } from '../types.js';
import type { MetaEnvelope } from '../envelope.js';

/** Call surface of Core /v3/task-source/* (thin forwarding on the Panel side). */
export interface TaskSourceKernelPort {
  invoke(action: string, body: Record<string, unknown>, ctx: MetaCallContext): Promise<MetaEnvelope>;
}
