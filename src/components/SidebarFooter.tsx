import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { PixelIcon } from "./PixelIcon";

const DISCORD_URL = "https://discord.gg/aWECX7EPmV";

// Discord's mascot on the font's pixel grid.
const DISCORD_ICON = [
  "..##....##..",
  ".##########.",
  ".##########.",
  "############",
  "###..##..###",
  "###..##..###",
  "############",
  "############",
  ".###....###.",
  "..#......#..",
];

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
        <PixelIcon rows={DISCORD_ICON} />
        <span>Discord</span>
      </button>
      {version && <div className="sf-version">Launcher {version}</div>}
    </div>
  );
}