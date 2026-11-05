import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { Speech } from "./speech";

/**
 * The one place results are said to a screen reader: a polite live region that exists from the
 * start, so a message put into it is read even when the control that caused it has gone (a
 * removed row, a closed dialog). Each message is said once per key. What has been said is held
 * by the SpeechProvider, one per app tree (./speech).
 */
const SpeechContext = createContext<Speech | null>(null);

export function SpeechProvider({ children }: { children: ReactNode }) {
  const [speech] = useState(() => new Speech());
  return <SpeechContext.Provider value={speech}>{children}</SpeechContext.Provider>;
}

export function useSpeech(): Speech {
  const speech = useContext(SpeechContext);
  if (!speech) throw new Error("useSpeech outside a SpeechProvider");
  return speech;
}

/** Says `text` politely, once per `key`. */
export function useAnnounce(): (key: string, text: string) => void {
  const speech = useSpeech();
  return useCallback((key: string, text: string) => speech.say(key, text), [speech]);
}

export function LiveRegion() {
  const speech = useSpeech();
  const [text, setText] = useState("");
  useEffect(() => {
    let clear: ReturnType<typeof setTimeout> | undefined;
    let frame = 0;
    // Messages that arrive in the same frame (a result and an error it caused) are said
    // together, in order, rather than the last one replacing the others.
    let pending: string[] = [];
    const stop = speech.listen((t) => {
      pending.push(t);
      if (frame) return;
      // A message the same as the last one would not change the region; clear it first.
      setText("");
      frame = requestAnimationFrame(() => {
        frame = 0;
        setText(pending.join(" "));
        pending = [];
      });
      clearTimeout(clear);
      clear = setTimeout(() => setText(""), 8000);
    });
    return () => {
      stop();
      cancelAnimationFrame(frame);
      clearTimeout(clear);
    };
  }, [speech]);
  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="live-region">
      {text}
    </div>
  );
}
