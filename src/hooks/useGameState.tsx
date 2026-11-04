import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { translateError } from "../i18n/errors";
import type { ModFailure } from "../mods/types";

interface GameStateEvent {
  tag: string;
  state: "running" | "stopped";
  exitCode: number | null;
  crashed: boolean;
  modFailure: ModFailure | null;
}

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
  launch: (tag: string) => Promise<string | null>;
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
    invoke<string[]>("get_running_versions")
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

    listen<GameStateEvent>("game-state", (event) => {
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

  const launch = useCallback(async (tag: string): Promise<string | null> => {
    setLastCrash(null);
    try {
      await invoke("launch_version", { tag });
      try {
        localStorage.setItem("lastPlayed", tag);
      } catch {
        // ignore localStorage errors
      }
      return null; // success
    } catch (err) {
      return translateError(err);
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
