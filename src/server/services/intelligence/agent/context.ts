import { env } from "@/env";
import {
  AGENT_POLICY_VERSION,
  AGENT_PROMPT_VERSION,
  AGENT_TOOL_CONTRACT_VERSION,
} from "@/server/services/intelligence/agent/versions";
import {
  type CardType,
  type ResolvedLocation,
} from "@/server/services/intelligence/types";

interface AgentMemoryInput {
  sessionId: string;
  turnIndex: number;
  cardType: CardType;
  locations: ResolvedLocation[];
  baselineByLocation: Map<string, number>;
  competitorName?: string;
  baselineAssumedForFirstLocation: boolean;
}

export interface CompiledAgentContext {
  identityContext: string;
  toolContractContext: string;
  sessionMemoryContext: string;
  promptVersion: string;
  toolContractVersion: string;
  policyVersion: string;
}

export function buildSessionMemoryContext(input: AgentMemoryInput): string {
  const baselines = input.locations.map((location, index) => ({
    locationLabel: location.label,
    baselineFoh: input.baselineByLocation.get(location.label) ?? null,
    assumed:
      index === 0 &&
      input.baselineAssumedForFirstLocation &&
      !input.baselineByLocation.has(location.label),
  }));

  return JSON.stringify({
    sessionId: input.sessionId,
    turnIndex: input.turnIndex,
    cardType: input.cardType,
    locations: input.locations.map((location) => ({
      label: location.label,
      placeId: location.placeId,
    })),
    baselines,
    competitorName: input.competitorName ?? null,
  });
}

export function buildCompiledAgentContext(
  input: AgentMemoryInput,
): CompiledAgentContext {
  return {
    identityContext:
      "Mission: provide concrete staffing/prep recommendations for NYC restaurants over next 3 days.",
    toolContractContext: `Hard limits: max 8 tool calls, max 2 rounds, max ${env.INTELLIGENCE_TURN_BUDGET_MS}ms turn budget, no fabricated claims.`,
    sessionMemoryContext: buildSessionMemoryContext(input),
    promptVersion: AGENT_PROMPT_VERSION,
    toolContractVersion: AGENT_TOOL_CONTRACT_VERSION,
    policyVersion: AGENT_POLICY_VERSION,
  };
}
