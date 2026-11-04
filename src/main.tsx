import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { GameStateProvider } from "./hooks/useGameState";
import { InstallProvider } from "./hooks/useInstall";
import { ModsProvider } from "./hooks/useMods";
import { getLocale, initI18n } from "./i18n";
import "./style.css";

initI18n();
document.documentElement.lang = getLocale();

document.addEventListener("contextmenu", (e) => e.preventDefault());

document.addEventListener("keydown", (e) => {
  const key = e.key.toLowerCase();
  const blocked =
    e.key === "F12" ||
    (e.ctrlKey && e.shiftKey && ["i", "j", "c"].includes(key)) ||
    (e.ctrlKey && ["u", "p", "f", "g"].includes(key)) ||
    (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) ||
    // A reload forgets the progress of a running install. Handy while developing, though.
    (import.meta.env.PROD && (e.key === "F5" || (e.ctrlKey && key === "r")));
  if (blocked) e.preventDefault();
});

import { I18nProvider } from "./i18n/I18nProvider";

// `npm run dev:mock` runs the UI in a browser against src/dev/mockBackend.ts. The check is on a
// build-time constant, so a real build leaves the mock out entirely.
async function start() {
  if (import.meta.env.MODE === "mock") {
    const { installMockBackend } = await import("./dev/mockBackend");
    installMockBackend();
  }
  render();
}

const render = () => ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <I18nProvider>
      <GameStateProvider>
        <InstallProvider>
          <ModsProvider>
            <App />
          </ModsProvider>
        </InstallProvider>
      </GameStateProvider>
    </I18nProvider>
  </React.StrictMode>,
);

start();
