import { open as openFileDialog } from "@tauri-apps/plugin-dialog";

/** Asks the player for one mod zip. The path, or null when they closed the picker. */
export async function pickModFile(filterName: string): Promise<string | null> {
  const path = await openFileDialog({ multiple: false, directory: false, filters: [{ name: filterName, extensions: ["zip"] }] });
  return typeof path === "string" ? path : null;
}
