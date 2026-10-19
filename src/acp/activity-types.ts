/** Read-only, bounded display metadata. Never expose child sessions or transcripts here. */
export interface AgentActivity {
 id: string;
 agent: string;
 title: string;
 label?: string;
 workflowId?: string;
 phaseId?: string;
 harness: string;
 state: string;
 startedAt: number;
 updatedAt: number;
 runningAt?: number;
 finishedAt?: number;
 reportedTokens?: number;
 contextTokens?: number;
 model?: string;
}
export interface AgentActivitySource {
 snapshot(): readonly AgentActivity[];
 subscribe(listener: () => void): () => void;
}
