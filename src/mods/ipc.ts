// Command and event names, generated from the backend. Used by src/mods/api.ts, the hooks and the
// mock backend, so a renamed command fails to compile instead of failing at runtime.
export { COMMANDS, EVENTS } from "./bindings/commands";
export type { CommandName as Command, EventName } from "./bindings/commands";
