"use client";

import { useEffect, useRef, useState } from "react";

import { captureEvent, getDistinctId } from "@/app/_lib/analytics";
import { FollowUpComposer } from "@/app/_components/chat/follow-up-composer";
import {
  InsightSetupPanel,
  type InsightSetupSubmitPayload,
} from "@/app/_components/chat/insight-setup-panel";
import { RecommendationBlock } from "@/app/_components/chat/recommendation-block";
import { api, type RouterOutputs } from "@/trpc/react";

type CardType = "staffing" | "risk" | "opportunity";
type FirstInsightOutput = RouterOutputs["intelligence"]["firstInsight"];
type BaselineScope = "none" | "all" | "single" | "ambiguous";
type FollowUpIntent =
  | "decline_adjustment"
  | "evidence_question"
  | "baseline_update"
  | "new_insight_request";

type ChatMessage = {
  id: string;
  role: "assistant" | "user";
  text: string;
  recommendations?: FirstInsightOutput["recommendations"];
  snapshots?: FirstInsightOutput["snapshots"];
  competitorSnapshot?: FirstInsightOutput["competitorSnapshot"];
};

type PendingClarification = {
  baselineFoh: number;
  askedForFirstLabel: string;
};

type ErrorBannerState = {
  message: string;
  retryPayload: {
    withFollowup?: string;
    parsedLocationsInput?: string[];
    competitorNameInput?: string;
    suppressUserEcho?: boolean;
  };
};

function parseBaselineMessage(
  message: string,
  locationLabels: string[],
): { baselineFoh?: number; scope: BaselineScope; locationLabel?: string } {
  const regex = /(\d+)\s*foh/i;
  const match = regex.exec(message);
  if (!match) return { scope: "none" };

  const baselineFoh = Number(match[1]);
  if (Number.isNaN(baselineFoh)) return { scope: "none" };

  const normalized = message.toLowerCase();
  if (normalized.includes("all")) {
    return {
      baselineFoh,
      scope: "all",
    };
  }

  const explicitLocation = locationLabels.find((label) =>
    normalized.includes(label.toLowerCase()),
  );
  if (explicitLocation) {
    return {
      baselineFoh,
      locationLabel: explicitLocation,
      scope: "single",
    };
  }

  return {
    baselineFoh,
    scope: locationLabels.length > 1 ? "ambiguous" : "single",
    locationLabel: locationLabels[0],
  };
}

function resolveBaselineClarification(
  message: string,
  locationLabels: string[],
): { scope: "all" | "single" | "assumed_single"; locationLabel?: string } {
  const normalized = message.toLowerCase();
  if (normalized.includes("all")) {
    return { scope: "all" };
  }

  const explicitLocation = locationLabels.find((label) =>
    normalized.includes(label.toLowerCase()),
  );
  if (explicitLocation) {
    return { scope: "single", locationLabel: explicitLocation };
  }

  return { scope: "assumed_single", locationLabel: locationLabels[0] };
}

function parseCompetitorInput(rawValue: string): {
  selected: string;
  candidateCount: number;
  selectedIndex: number;
} {
  const candidates = rawValue
    .split(/\s*(?:,|\/|&|\band\b)\s*/i)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  return {
    selected: candidates[0] ?? "",
    candidateCount: candidates.length,
    selectedIndex: candidates.length > 0 ? 0 : -1,
  };
}

function looksLikeDecline(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return /^(no|nope|nah|all set|looks good|looks great|we['’]?re good|that works|no thanks|not now)[.!?]*$/.test(
    normalized,
  );
}

function looksLikeEvidenceQuestion(message: string): boolean {
  const normalized = message.toLowerCase();
  const asksForEvidence =
    /\b(where|which|show|source|evidence|mention|mentioned|reviews?|quote|quoted)\b/.test(
      normalized,
    ) || normalized.includes("where did you see");
  const mentionsSignal =
    /\b(wait|line|queue|host|service|slow|kitchen|delay|review|reviews)\b/.test(
      normalized,
    );
  return asksForEvidence && mentionsSignal;
}

function looksLikeNewInsightRequest(message: string): boolean {
  const normalized = message.toLowerCase();
  return /\b(rerun|re-run|recheck|refresh|run again|check again|update)\b/.test(
    normalized,
  );
}

function routeFollowUpIntent(
  message: string,
  baselineParsed: { baselineFoh?: number },
): FollowUpIntent {
  if (baselineParsed.baselineFoh !== undefined) {
    return "baseline_update";
  }
  if (looksLikeDecline(message)) {
    return "decline_adjustment";
  }
  if (looksLikeEvidenceQuestion(message)) {
    return "evidence_question";
  }
  if (looksLikeNewInsightRequest(message)) {
    return "new_insight_request";
  }
  return "new_insight_request";
}

function extractThemeFromQuestion(
  message: string,
): "wait_time" | "service_speed" | "host_queue" | "kitchen_delay" | null {
  const normalized = message.toLowerCase();
  if (/(wait|line|queued|queue|seated)/.test(normalized)) return "wait_time";
  if (/(slow service|service slow|took forever|server)/.test(normalized))
    return "service_speed";
  if (/(host|front desk|check in|reservation)/.test(normalized))
    return "host_queue";
  if (/(kitchen|food took|cold food|hot food)/.test(normalized))
    return "kitchen_delay";
  return null;
}

function humanizeTheme(theme: string): string {
  return theme.replaceAll("_", " ");
}

function buildEvidenceAnswer(
  question: string,
  messages: ChatMessage[],
): {
  text: string;
  refCount: number;
  hadSufficientEvidence: boolean;
  theme: string;
} {
  const theme = extractThemeFromQuestion(question);
  const latestAssistantWithEvidence = [...messages]
    .reverse()
    .find(
      (message) =>
        message.role === "assistant" &&
        message.recommendations?.some(
          (item) => (item.evidence?.topRefs.length ?? 0) > 0,
        ),
    );

  if (!latestAssistantWithEvidence?.recommendations) {
    return {
      text: "I do not have recent review citations in this session yet. Ask me to rerun insights or expand “Show evidence” on an action card.",
      refCount: 0,
      hadSufficientEvidence: false,
      theme: theme ?? "none",
    };
  }

  const refs = latestAssistantWithEvidence.recommendations.flatMap((item) =>
    (item.evidence?.topRefs ?? []).map((ref) => ({
      locationLabel: item.locationLabel,
      recencyWindowDays: item.evidence?.recencyWindowDays ?? 90,
      ref,
    })),
  );

  if (refs.length === 0) {
    return {
      text: "I do not have recent review citations in this session yet. Ask me to rerun insights or expand “Show evidence” on an action card.",
      refCount: 0,
      hadSufficientEvidence: false,
      theme: theme ?? "none",
    };
  }

  const themeRefs = theme
    ? refs.filter((entry) => entry.ref.theme === theme)
    : refs;
  const sorted = [...themeRefs].sort(
    (a, b) =>
      new Date(b.ref.publishTime).getTime() -
      new Date(a.ref.publishTime).getTime(),
  );
  const top = sorted.slice(0, 3);
  const recencyWindowDays = refs[0]?.recencyWindowDays ?? 90;

  if (top.length === 0 && theme) {
    const availableThemes = Array.from(
      new Set(
        refs
          .map((entry) => entry.ref.theme)
          .filter((value) => value !== "other")
          .map((value) => humanizeTheme(value)),
      ),
    ).slice(0, 2);

    const availableThemeLine =
      availableThemes.length > 0
        ? `I do see clearer mentions around ${availableThemes.join(" and ")}.`
        : "Recent review evidence is mixed without one dominant operational theme.";

    return {
      text: `I do not see strong recent mentions specifically about ${humanizeTheme(theme)}. ${availableThemeLine} Want me to adjust staffing from events and weather anyway?`,
      refCount: 0,
      hadSufficientEvidence: false,
      theme,
    };
  }

  const lines = [
    theme
      ? `Here are recent review mentions tied to ${humanizeTheme(theme)}:`
      : "Here are the recent review mentions I used:",
  ];

  top.forEach((entry, index) => {
    const published = new Date(entry.ref.publishTime);
    const dateLabel = Number.isNaN(published.getTime())
      ? "unknown date"
      : published.toLocaleDateString();
    lines.push(
      `${index + 1}. ${entry.locationLabel} · ${dateLabel} · rating ${entry.ref.rating ?? "n/a"}: "${entry.ref.excerpt ?? "No excerpt available."}"`,
    );
  });

  lines.push(
    `These citations are from the last ${recencyWindowDays} days of Google reviews.`,
    "Want me to convert this into a staffing adjustment for one location?",
  );

  return {
    text: lines.join("\n"),
    refCount: top.length,
    hadSufficientEvidence: true,
    theme: theme ?? "none",
  };
}

export function StaffingChat() {
  const [selectedCard, setSelectedCard] = useState<CardType>("staffing");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [locationLabels, setLocationLabels] = useState<string[]>([]);
  const [activeLocations, setActiveLocations] = useState<string[]>([]);
  const [activeCompetitorName, setActiveCompetitorName] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [errorBanner, setErrorBanner] = useState<ErrorBannerState | null>(null);
  const [pendingClarification, setPendingClarification] =
    useState<PendingClarification | null>(null);

  const hasCapturedStart = useRef(false);
  const hasCapturedFirstInsight = useRef(false);
  const sessionStartedAtRef = useRef<number>(Date.now());
  const sessionIdRef = useRef<string | null>(null);

  const firstInsight = api.intelligence.firstInsight.useMutation();
  const refineInsight = api.intelligence.refineInsight.useMutation();
  const endSession = api.intelligence.endSession.useMutation();
  const endSessionMutateRef = useRef(endSession.mutate);

  const isLoading = firstInsight.isPending || refineInsight.isPending;

  useEffect(() => {
    const url = new URL(window.location.href);
    captureEvent("landing_page_viewed", {
      landing_page_variant: "v1.1",
      referrer_domain: document.referrer
        ? new URL(document.referrer).hostname
        : undefined,
      utm_source: url.searchParams.get("utm_source") ?? undefined,
      utm_medium: url.searchParams.get("utm_medium") ?? undefined,
      utm_campaign: url.searchParams.get("utm_campaign") ?? undefined,
    });
  }, []);

  const submitInsight = async (params?: {
    withFollowup?: string;
    parsedLocationsInput?: string[];
    competitorNameInput?: string;
    suppressUserEcho?: boolean;
  }) => {
    const withFollowup = params?.withFollowup;
    setErrorBanner(null);
    const locationsForRequest = withFollowup
      ? activeLocations.length > 0
        ? activeLocations
        : (params?.parsedLocationsInput ?? [])
      : (params?.parsedLocationsInput ?? []);
    const competitorParse = withFollowup
      ? {
          selected: activeCompetitorName,
          candidateCount: activeCompetitorName ? 1 : 0,
          selectedIndex: activeCompetitorName ? 0 : -1,
        }
      : parseCompetitorInput(params?.competitorNameInput ?? "");
    const competitorNameForRequest = withFollowup
      ? activeCompetitorName
      : competitorParse.selected;
    const locationsChanged =
      !withFollowup &&
      sessionId !== null &&
      JSON.stringify(locationsForRequest) !== JSON.stringify(activeLocations);

    if (locationsForRequest.length === 0) {
      setMessages((prev) => [
        ...prev,
        {
          id: `assistant-location-required-${Date.now()}`,
          role: "assistant",
          text: "Please add at least one NYC location before I run this.",
        },
      ]);
      return;
    }

    const distinctId = getDistinctId();

    if (!hasCapturedStart.current) {
      hasCapturedStart.current = true;
      captureEvent("chat_session_started", {
        entry_type: withFollowup ? "free_text" : "card",
        time_to_start_ms: Date.now() - sessionStartedAtRef.current,
      });
    }

    if (!withFollowup) {
      captureEvent("starter_card_clicked", {
        card_label:
          selectedCard === "staffing"
            ? "Help me plan staffing"
            : selectedCard === "risk"
              ? "What should I watch out for?"
              : "Any opportunities I'm missing?",
        card_type: selectedCard,
      });

      if (competitorParse.candidateCount > 0) {
        captureEvent("competitor_parse_applied", {
          candidate_count: competitorParse.candidateCount,
          selected_index: competitorParse.selectedIndex,
        });
      }
    }

    if (competitorNameForRequest) {
      captureEvent("competitor_check_requested", {
        competitor_query: competitorNameForRequest,
        competitor_resolved: null,
        competitor_place_id: null,
      });
    }

    captureEvent("locations_parsed", {
      parse_status: locationsForRequest.length > 0 ? "success" : "error",
      valid_count: locationsForRequest.length,
      invalid_count: locationsForRequest.length === 0 ? 1 : 0,
      nyc_validation_failed: false,
      ambiguous_count: 0,
    });

    if (withFollowup && !params?.suppressUserEcho) {
      setMessages((prev) => [
        ...prev,
        {
          id: `user-${Date.now()}`,
          role: "user",
          text: withFollowup,
        },
      ]);
    }

    const baselineParsedForIntent =
      withFollowup && !pendingClarification
        ? parseBaselineMessage(withFollowup, locationLabels)
        : undefined;

    if (
      withFollowup &&
      !pendingClarification &&
      baselineParsedForIntent !== undefined
    ) {
      const followupIntent = routeFollowUpIntent(
        withFollowup,
        baselineParsedForIntent,
      );
      captureEvent("followup_intent_routed", {
        intent: followupIntent,
        used_full_summary:
          followupIntent === "new_insight_request" ||
          followupIntent === "baseline_update",
      });

      if (followupIntent === "decline_adjustment") {
        setMessages((prev) => [
          ...prev,
          {
            id: `assistant-decline-${Date.now()}`,
            role: "assistant",
            text: "Understood. I will keep the current staffing plan as-is. Want me to re-check conditions later today before dinner prep?",
          },
        ]);
        return;
      }

      if (followupIntent === "evidence_question") {
        const evidenceAnswer = buildEvidenceAnswer(withFollowup, messages);
        captureEvent("evidence_answered", {
          theme: evidenceAnswer.theme,
          ref_count: evidenceAnswer.refCount,
          had_sufficient_evidence: evidenceAnswer.hadSufficientEvidence,
        });
        setMessages((prev) => [
          ...prev,
          {
            id: `assistant-evidence-${Date.now()}`,
            role: "assistant",
            text: evidenceAnswer.text,
          },
        ]);
        return;
      }
    }

    let baselineContext:
      | { locationLabel: string; baselineFoh: number }[]
      | undefined;

    if (withFollowup && pendingClarification) {
      const resolution = resolveBaselineClarification(
        withFollowup,
        locationLabels,
      );
      if (resolution.scope === "all") {
        baselineContext = locationLabels.map((label) => ({
          locationLabel: label,
          baselineFoh: pendingClarification.baselineFoh,
        }));
      } else {
        baselineContext = [
          {
            locationLabel:
              resolution.locationLabel ??
              pendingClarification.askedForFirstLabel,
            baselineFoh: pendingClarification.baselineFoh,
          },
        ];
      }

      captureEvent("baseline_provided", {
        scope: resolution.scope,
        location_label: baselineContext[0]?.locationLabel,
        baseline_foh: pendingClarification.baselineFoh,
        daypart: "dinner",
      });
      setPendingClarification(null);
    } else if (withFollowup) {
      const baselineParsed =
        baselineParsedForIntent ??
        parseBaselineMessage(withFollowup, locationLabels);
      if (
        baselineParsed.scope === "ambiguous" &&
        baselineParsed.baselineFoh !== undefined &&
        locationLabels.length > 1
      ) {
        const firstLocation = locationLabels[0] ?? "your first location";
        setPendingClarification({
          baselineFoh: baselineParsed.baselineFoh,
          askedForFirstLabel: firstLocation,
        });
        setMessages((prev) => [
          ...prev,
          {
            id: `assistant-clarify-${Date.now()}`,
            role: "assistant",
            text: `Should I apply that ${baselineParsed.baselineFoh} FOH baseline to all locations or just ${firstLocation}? If you do not specify, I will apply it to ${firstLocation}.`,
          },
        ]);
        return;
      }

      if (baselineParsed.baselineFoh !== undefined) {
        if (baselineParsed.scope === "all") {
          baselineContext = locationLabels.map((label) => ({
            locationLabel: label,
            baselineFoh: baselineParsed.baselineFoh!,
          }));
        } else if (baselineParsed.locationLabel) {
          baselineContext = [
            {
              locationLabel: baselineParsed.locationLabel,
              baselineFoh: baselineParsed.baselineFoh,
            },
          ];
        }

        if (baselineContext && baselineContext.length > 0) {
          captureEvent("baseline_provided", {
            scope: baselineParsed.scope,
            location_label: baselineContext[0]?.locationLabel,
            baseline_foh: baselineParsed.baselineFoh,
            daypart: "dinner",
          });
        }
      }
    }

    const nextSessionId = locationsChanged ? null : sessionId;
    const payload = {
      sessionId: nextSessionId ?? undefined,
      distinctId,
      cardType: selectedCard,
      locations: locationsForRequest,
      competitorName: competitorNameForRequest || undefined,
      baselineContext,
    };

    if (locationsChanged) {
      setMessages([]);
      setSessionId(null);
      setLocationLabels([]);
      setPendingClarification(null);
      setActiveLocations([]);
      setActiveCompetitorName("");
    }

    try {
      const response = nextSessionId
        ? await refineInsight.mutateAsync({
            ...payload,
            sessionId: nextSessionId,
          })
        : await firstInsight.mutateAsync(payload);

      setSessionId(response.sessionId);
      setLocationLabels(response.locationLabels);
      setActiveLocations(locationsForRequest);
      setActiveCompetitorName(competitorNameForRequest);
      setErrorBanner(null);

      setMessages((prev) => [
        ...prev,
        {
          id: `assistant-${response.turnIndex}-${Date.now()}`,
          role: "assistant",
          text: response.message,
          recommendations: response.recommendations,
          snapshots: response.snapshots,
          competitorSnapshot: response.competitorSnapshot,
        },
      ]);

      if (!hasCapturedFirstInsight.current) {
        hasCapturedFirstInsight.current = true;
        captureEvent("first_insight_rendered", {
          first_insight_latency_ms: response.firstInsightLatencyMs,
          used_fallback: response.usedFallback,
          sources_available: Object.entries(response.sources)
            .filter(([, status]) => status.status === "ok")
            .map(([source]) => source),
          recommendation_count: response.recommendations.length,
        });
      }

      if (response.usedFallback) {
        const sourcesDown = Object.entries(response.sources)
          .filter(([, status]) => status.status !== "ok")
          .map(([source]) => source);
        captureEvent("fallback_used", {
          fallback_type: "partial_data",
          sources_down: sourcesDown,
          reason: "one_or_more_sources_unavailable",
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown_error";
      captureEvent("chat_error_client", {
        stage: "submit_insight",
        error_message: message,
        retryable: true,
      });
      setErrorBanner({
        message:
          "I hit a temporary error while generating your insight. Please retry.",
        retryPayload: {
          withFollowup,
          parsedLocationsInput: locationsForRequest,
          competitorNameInput: competitorNameForRequest,
          suppressUserEcho: true,
        },
      });
      return;
    }
  };

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    endSessionMutateRef.current = endSession.mutate;
  }, [endSession.mutate]);

  useEffect(() => {
    return () => {
      const latestSessionId = sessionIdRef.current;
      if (!latestSessionId) return;
      endSessionMutateRef.current({
        sessionId: latestSessionId,
        distinctId: getDistinctId(),
        endReason: "user_exit",
      });
    };
  }, []);

  return (
    <div className="container-brand py-10 sm:py-16">
      <div className="mx-auto max-w-6xl">
        <div className="grid gap-8 lg:grid-cols-[1.1fr_1fr] lg:gap-10">
          <section>
            <p className="text-forest text-sm font-semibold tracking-[0.2em] uppercase">
              PATHWAY
            </p>
            <h1 className="hero-headline text-charcoal mt-3">
              What’s affecting your restaurants in the next 3 days?
            </h1>
            <p className="text-text-secondary mt-4 max-w-xl text-base">
              Staffing and prep recommendations for your NYC locations in about
              60 seconds.
            </p>

            <InsightSetupPanel
              isLoading={isLoading}
              selectedCard={selectedCard}
              onSelectCard={setSelectedCard}
              onSubmit={(payload: InsightSetupSubmitPayload) =>
                void submitInsight({
                  parsedLocationsInput: payload.parsedLocations,
                  competitorNameInput: payload.competitorName,
                })
              }
            />
          </section>

          <section className="chat-container flex min-h-[620px] flex-col overflow-hidden">
            <div className="chat-header">
              <div className="ai-avatar">P</div>
              <div>
                <p className="text-charcoal font-semibold">Pathway Assistant</p>
                <p className="text-text-secondary text-xs">
                  Staffing and prep intelligence
                </p>
              </div>
            </div>
            {errorBanner ? (
              <div className="border-warning bg-warning/5 mx-4 mt-3 rounded-md border px-3 py-2">
                <p className="text-warning text-sm">{errorBanner.message}</p>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    className="suggestion-chip"
                    onClick={() => {
                      captureEvent("chat_retry_clicked", {
                        source: "error_banner",
                        has_followup: Boolean(
                          errorBanner.retryPayload.withFollowup,
                        ),
                      });
                      void submitInsight(errorBanner.retryPayload);
                    }}
                  >
                    Retry
                  </button>
                  <button
                    type="button"
                    className="suggestion-chip"
                    onClick={() => setErrorBanner(null)}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            ) : null}

            <div className="flex-1 overflow-y-auto p-4">
              {messages.length === 0 ? (
                <div className="chat-empty">
                  <div className="ai-avatar mb-4">P</div>
                  <h2 className="chat-empty-title">
                    Plan staffing with confidence.
                  </h2>
                  <p className="chat-empty-subtitle">
                    Start by adding your NYC locations and selecting a starter
                    card.
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  {messages.map((message) => (
                    <div key={message.id}>
                      <div
                        className={
                          message.role === "user" ? "msg-user" : "msg-ai"
                        }
                      >
                        {message.text}
                      </div>
                      {message.role === "assistant" &&
                      message.recommendations ? (
                        <RecommendationBlock
                          recommendations={message.recommendations}
                          snapshots={message.snapshots ?? []}
                          competitorSnapshot={message.competitorSnapshot}
                        />
                      ) : null}
                    </div>
                  ))}
                  {isLoading ? (
                    <div className="msg-ai">
                      <div className="typing-indicator">
                        <div className="typing-dot" />
                        <div className="typing-dot" />
                        <div className="typing-dot" />
                      </div>
                    </div>
                  ) : null}
                </div>
              )}
            </div>

            <FollowUpComposer
              isLoading={isLoading}
              hasSession={Boolean(sessionId)}
              onSend={(value) => void submitInsight({ withFollowup: value })}
            />
          </section>
        </div>
      </div>
    </div>
  );
}
