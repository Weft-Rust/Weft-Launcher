import { useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";

interface ConfirmPressOptions {
  /** The second, confirming press. */
  onConfirm: () => void;
  /** The first press: the button now asks. */
  onAsk?: () => void;
  /** The question lapsed: on Escape (`said` true, the player asked for it) or when focus left. */
  onCancel?: (said: boolean) => void;
  /** The second click of a double-click: it doesn't confirm, and the player is told why. */
  onDoubleClick?: () => void;
}

/**
 * A button that does something that can't be taken back on its second press, never its first.
 *
 * - The first press asks; the question stays while the button has focus, never on a timer, so a
 *   player reading it (or a screen reader saying it) keeps it.
 * - Any later press confirms, once the question is on screen, except the second click of a mouse
 *   double-click: the system's own click count says which that is, so there is no dead time
 *   after the question appears. A dropped double-click is said, so it is never silent.
 * - A held Enter doesn't repeat into a confirmation.
 * - Escape, or focus leaving the button, takes the question back.
 */
export function useConfirmPress({ onConfirm, onAsk, onCancel, onDoubleClick }: ConfirmPressOptions) {
  const [confirming, setConfirming] = useState(false);
  const shown = useRef(false);
  useLayoutEffect(() => {
    shown.current = confirming;
  }, [confirming]);

  const cancel = (said: boolean) => {
    setConfirming(false);
    onCancel?.(said);
  };

  const onClick = (e: MouseEvent<HTMLButtonElement>) => {
    if (!confirming) {
      setConfirming(true);
      onAsk?.();
      return;
    }
    if (!shown.current) return;
    // `detail` counts the clicks of one double-click; a keyboard press has 0.
    if (e.detail > 1) {
      onDoubleClick?.();
      return;
    }
    setConfirming(false);
    onConfirm();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "Escape" && confirming) {
      e.stopPropagation();
      cancel(true);
    } else if (e.repeat && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
    }
  };

  const onBlur = () => {
    if (confirming) cancel(false);
  };

  return { confirming, reset: () => setConfirming(false), handlers: { onClick, onKeyDown, onBlur } };
}
