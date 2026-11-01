import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";

const DISCORD_URL = "https://discord.gg/aWECX7EPmV";

const DiscordIcon = () => (
  <svg width="16" height="16" viewBox="0 0 8 8" fill="currentColor">
    <path d="M1 0h6v1h1v4h-1v1h-3v1h-1v1h-1v-2h-1v-1h-1v-4h1z" />
  </svg>
);

export function SidebarFooter() {
  const [version, setVersion] = useState("");

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => setVersion(""));
  }, []);

  return (
    <div className="sf">
      <button className="sf-link" onClick={() => openUrl(DISCORD_URL)}>
        <DiscordIcon />
        <span>Discord</span>
      </button>
      {version && <div className="sf-version">Launcher {version}</div>}
    </div>
  );
}