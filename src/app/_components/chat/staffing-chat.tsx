"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { captureEvent, getDistinctId } from "@/app/_lib/analytics";
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

function parseLocationLines(value: string): string[] {
  const normalized = value.trim();
  if (normalized.length === 0) return [];

  const splitInput = () => {
    if (normalized.includes("\n") || normalized.includes(";")) {
      return normalized.split(/[\n;]+/);
    }

    const zipMatches = Array.from(normalized.matchAll(/\b\d{5}(?:-\d{4})?\b/g));
    if (zipMatches.length <= 1) {
      return [normalized];
    }

    const segmented = normalized.split(/(?<=\b\d{5}(?:-\d{4})?)\s*,\s*/);
    return segmented.length > 0 ? segmented : [normalized];
  };

  return Array.from(
    new Set(
      splitInput()
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  ).slice(0, 3);
}

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
  const [locationsInput, setLocationsInput] = useState("");
  const [selectedCard, setSelectedCard] = useState<CardType>("staffing");
  const [competitorName, setCompetitorName] = useState("");
  const [followUpInput, setFollowUpInput] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [locationLabels, setLocationLabels] = useState<string[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pendingClarification, setPendingClarification] =
    useState<PendingClarification | null>(null);

  const hasCapturedStart = useRef(false);
  const hasCapturedFirstInsight = useRef(false);
  const sessionStartedAtRef = useRef<number>(Date.now());

  const firstInsight = api.intelligence.firstInsight.useMutation();
  const refineInsight = api.intelligence.refineInsight.useMutation();
  const endSession = api.intelligence.endSession.useMutation();

  const parsedLocations = useMemo(
    () => parseLocationLines(locationsInput),
    [locationsInput],
  );

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

  const submitInsight = async (withFollowup?: string) => {
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

    if (competitorName.trim()) {
      captureEvent("competitor_check_requested", {
        competitor_query: competitorName.trim(),
        competitor_resolved: null,
        competitor_place_id: null,
      });
    }

    captureEvent("locations_parsed", {
      parse_status: parsedLocations.length > 0 ? "success" : "error",
      valid_count: parsedLocations.length,
      invalid_count: parsedLocations.length === 0 ? 1 : 0,
      nyc_validation_failed: false,
      ambiguous_count: 0,
    });

    if (withFollowup) {
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

    const payload = {
      sessionId: sessionId ?? undefined,
      distinctId,
      cardType: selectedCard,
      locations: parsedLocations,
      competitorName: competitorName.trim() || undefined,
      baselineContext,
    };

    const response = sessionId
      ? await refineInsight.mutateAsync({ ...payload, sessionId })
      : await firstInsight.mutateAsync(payload);

    setSessionId(response.sessionId);
    setLocationLabels(response.locationLabels);

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
  };

  useEffect(() => {
    return () => {
      if (!sessionId) return;
      endSession.mutate({
        sessionId,
        distinctId: getDistinctId(),
        endReason: "user_exit",
      });
    };
  }, [sessionId, endSession]);

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

            <div className="card-accent mt-8">
              <label
                className="text-charcoal text-sm font-medium"
                htmlFor="locations"
              >
                NYC locations (1-3)
              </label>
              <textarea
                id="locations"
                className="chat-input-multiline mt-2 min-h-[112px]"
                placeholder="Paste addresses, ZIPs, or neighborhoods (one per line or comma separated)"
                value={locationsInput}
                onChange={(event) => setLocationsInput(event.target.value)}
              />
              <p className="text-text-secondary mt-2 text-xs">
                Detected: {parsedLocations.length}/3 locations
              </p>

              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  className={`suggestion-chip ${selectedCard === "staffing" ? "border-forest" : ""}`}
                  onClick={() => setSelectedCard("staffing")}
                >
                  Help me plan staffing
                </button>
                <button
                  type="button"
                  className={`suggestion-chip ${selectedCard === "risk" ? "border-forest" : ""}`}
                  onClick={() => setSelectedCard("risk")}
                >
                  What should I watch out for?
                </button>
                <button
                  type="button"
                  className={`suggestion-chip ${selectedCard === "opportunity" ? "border-forest" : ""}`}
                  onClick={() => setSelectedCard("opportunity")}
                >
                  Any opportunities I’m missing?
                </button>
              </div>

              <div className="mt-4">
                <label
                  className="text-charcoal text-sm font-medium"
                  htmlFor="competitor"
                >
                  Optional: one competitor to compare
                </label>
                <input
                  id="competitor"
                  className="chat-input mt-2"
                  placeholder="Name one competitor restaurant"
                  value={competitorName}
                  onChange={(event) => setCompetitorName(event.target.value)}
                />
              </div>

              <button
                type="button"
                className="btn-primary mt-6"
                disabled={parsedLocations.length === 0 || isLoading}
                onClick={() => void submitInsight()}
              >
                {isLoading ? "Analyzing…" : "Get first insight"}
              </button>
            </div>
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

            <div className="chat-input-container">
              <form
                className="flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!followUpInput.trim()) return;
                  const value = followUpInput.trim();
                  setFollowUpInput("");
                  void submitInsight(value);
                }}
              >
                <input
                  className="chat-input"
                  placeholder="Example: We usually run 4 FOH on Tuesday nights"
                  value={followUpInput}
                  onChange={(event) => setFollowUpInput(event.target.value)}
                />
                <button
                  type="submit"
                  className="chat-send-btn"
                  disabled={isLoading || !sessionId}
                >
                  Send
                </button>
              </form>
              {!sessionId ? (
                <p className="text-text-secondary mt-2 text-xs">
                  Run first insight before follow-up refinement.
                </p>
              ) : null}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
