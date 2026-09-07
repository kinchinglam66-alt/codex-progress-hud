import type { EtaEstimate, TaskSnapshot, TaskStatus } from '../core/types.js';
import type { PassiveGoalView } from './passive-goals.js';
import type {ObserverDiagnostics} from '../core/observer-diagnostics.js';

export interface ConversationName {
  value: string | null;
  freshness: 'fresh' | 'stale' | 'unavailable';
}

export interface ConversationRow {
  conversationKey: string;
  task: TaskSnapshot;
  eta: EtaEstimate | null;
  name: ConversationName;
  goal?: PassiveGoalView & {sampledAtMs: number};
  observer?:ObserverDiagnostics;
}

export function isVisibleStatus(status: TaskStatus): boolean {
  return status !== 'idle' && status !== 'quiescent' && status !== 'stopped' &&
    status !== 'succeeded_verified';
}
