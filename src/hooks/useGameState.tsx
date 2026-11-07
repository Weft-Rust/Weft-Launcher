import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from "react";
import { launcherApi, listenTo } from "../mods/api";
import { EVENTS } from "../mods/ipc";
import type { ModFailure } from "../mods/types";
import { failed, type ActionResult } from "./result";

export interface GameCrash {
  tag: string;
  exitCode: number | null;
  /** The mod the log blames, when the game stopped while loading mods. */
  modFailure: ModFailure | null;
}

interface GameStateContextValue {
  runningTags: Set<string>;
  anyRunning: boolean;
  isRunning: (tag: string) => boolean;
  launch: (tag: string) => Promise<ActionResult>;
  /** The last crash, until its problem is fixed, the player dismisses it or the game starts again. */
  lastCrash: GameCrash | null;
  clearCrash: () => void;
}

const GameStateContext = createContext<GameStateContextValue | null>(null);

export function GameStateProvider({ children }: { children: ReactNode }) {
  const [runningTags, setRunningTags] = useState<Set<string>>(new Set());
  const [lastCrash, setLastCrash] = useState<GameCrash | null>(null);

  const anyRunning = runningTags.size > 0;

  const isRunning = useCallback((tag: string) => runningTags.has(tag), [runningTags]);
  const clearCrash = useCallback(() => setLastCrash(null), []);

  // Fetch initially running versions on mount
  useEffect(() => {
    let mounted = true;
    launcherApi.runningVersions()
      .then((tags) => {
        if (mounted) setRunningTags(new Set(tags));
      })
      .catch((err) => console.error("Failed to get running versions:", err));
    return () => {
      mounted = false;
    };
  }, []);

  // Listen for game-state events. Here and not on a page, so a crash seen on another tab still
  // waits on Home.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    listenTo(EVENTS.gameState, (event) => {
      const { tag, state, exitCode, crashed, modFailure } = event.payload;
      setRunningTags((prev) => {
        const next = new Set(prev);
        if (state === "running") {
          next.add(tag);
        } else {
          next.delete(tag);
        }
        return next;
      });
      if (state === "stopped" && crashed) {
        setLastCrash({ tag, exitCode, modFailure: modFailure ?? null });
      }
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const launch = useCallback(async (tag: string): Promise<ActionResult> => {
    try {
      await launcherApi.launch(tag);
      // Only now: a launch the mods refused leaves the last crash's advice in place.
      setLastCrash(null);
      try {
        localStorage.setItem("lastPlayed", tag);
      } catch {
        // ignore localStorage errors
      }
      return { status: "done", result: undefined };
    } catch (err) {
      return failed(err);
    }
  }, []);

  const value: GameStateContextValue = {
    runningTags,
    anyRunning,
    isRunning,
    launch,
    lastCrash,
    clearCrash,
  };

  return <GameStateContext.Provider value={value}>{children}</GameStateContext.Provider>;
}

export function useGameState(): GameStateContextValue {
  const context = useContext(GameStateContext);
  if (!context) {
    throw new Error("useGameState must be used within a GameStateProvider");
  }
  return context;
}
