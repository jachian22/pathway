"use client";

import { memo, useState } from "react";

interface FollowUpComposerProps {
  isLoading: boolean;
  hasSession: boolean;
  onSend: (value: string) => void;
}

function FollowUpComposerBase(props: FollowUpComposerProps) {
  const [draft, setDraft] = useState("");

  return (
    <div className="chat-input-container">
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!draft.trim()) return;
          const value = draft.trim();
          setDraft("");
          props.onSend(value);
        }}
      >
        <input
          id="chat-follow-up"
          name="follow_up_message"
          className="chat-input"
          placeholder="Example: We usually run 4 FOH on Tuesday nights"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button
          type="submit"
          className="chat-send-btn"
          disabled={props.isLoading || !props.hasSession}
        >
          Send
        </button>
      </form>
      {!props.hasSession ? (
        <p className="text-text-secondary mt-2 text-xs">
          Run first insight before follow-up refinement.
        </p>
      ) : null}
    </div>
  );
}

export const FollowUpComposer = memo(FollowUpComposerBase);
FollowUpComposer.displayName = "FollowUpComposer";
