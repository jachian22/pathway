"use client";

import { memo, useMemo, useState } from "react";

export type StarterCardType = "staffing" | "risk" | "opportunity";

export interface InsightSetupSubmitPayload {
  parsedLocations: string[];
  competitorName: string;
}

interface InsightSetupPanelProps {
  isLoading: boolean;
  selectedCard: StarterCardType;
  onSelectCard: (card: StarterCardType) => void;
  onSubmit: (payload: InsightSetupSubmitPayload) => void;
}

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

function InsightSetupPanelBase(props: InsightSetupPanelProps) {
  const [locationsDraft, setLocationsDraft] = useState("");
  const [competitorDraft, setCompetitorDraft] = useState("");

  const parsedLocations = useMemo(
    () => parseLocationLines(locationsDraft),
    [locationsDraft],
  );

  return (
    <div className="card-accent mt-8">
      <label className="text-charcoal text-sm font-medium" htmlFor="locations">
        NYC locations (1-3)
      </label>
      <textarea
        id="locations"
        name="locations"
        className="chat-input-multiline mt-2 min-h-[112px]"
        placeholder="Paste addresses, ZIPs, or neighborhoods (one per line or comma separated)"
        value={locationsDraft}
        onChange={(event) => setLocationsDraft(event.target.value)}
      />
      <p className="text-text-secondary mt-2 text-xs">
        Detected: {parsedLocations.length}/3 locations
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          className={`suggestion-chip ${props.selectedCard === "staffing" ? "border-forest" : ""}`}
          onClick={() => props.onSelectCard("staffing")}
        >
          Help me plan staffing
        </button>
        <button
          type="button"
          className={`suggestion-chip ${props.selectedCard === "risk" ? "border-forest" : ""}`}
          onClick={() => props.onSelectCard("risk")}
        >
          What should I watch out for?
        </button>
        <button
          type="button"
          className={`suggestion-chip ${props.selectedCard === "opportunity" ? "border-forest" : ""}`}
          onClick={() => props.onSelectCard("opportunity")}
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
          name="competitor"
          className="chat-input mt-2"
          placeholder="Name one competitor restaurant"
          value={competitorDraft}
          onChange={(event) => setCompetitorDraft(event.target.value)}
        />
      </div>

      <button
        type="button"
        className="btn-primary mt-6"
        disabled={parsedLocations.length === 0 || props.isLoading}
        onClick={() =>
          props.onSubmit({
            parsedLocations,
            competitorName: competitorDraft.trim(),
          })
        }
      >
        {props.isLoading ? "Analyzing…" : "Get first insight"}
      </button>
    </div>
  );
}

export const InsightSetupPanel = memo(InsightSetupPanelBase);
InsightSetupPanel.displayName = "InsightSetupPanel";
