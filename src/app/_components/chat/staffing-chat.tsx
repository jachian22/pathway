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

type ChatMessage = {
  id: string;
  role: "assistant" | "user";
  text: string;
  recommendations?: FirstInsightOutput["recommendations"];
  snapshots?: FirstInsightOutput["snapshots"];
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
    const competitorNameForRequest = withFollowup
      ? activeCompetitorName
      : (params?.competitorNameInput?.trim() ?? "");
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
      const baselineParsed = parseBaselineMessage(withFollowup, locationLabels);
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
