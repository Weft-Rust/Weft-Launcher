// The mock's crashes: what the engine would write to the log for each failure, in the shape the
// launcher's log has (`[stderr]`, then `<time> <LEVEL> [<target>] <message>`), as in the
// fixtures of src-tauri/src/mods/diagnose.rs. The mock reads the failure out of the log with
// ./diagnose, as the backend does; diagnose.test.ts checks both.

import type { FailureKind } from "../mods/types";

const ENGINE_ABI = "f470b1cbb1f9ad91";

/** Each names a mod of the `crash` scenario's set: Cogwork, Structures and the local My Tweak. */
export const CRASH_LOGS: Record<FailureKind, string> = {
  wrongVersion:
    "[stderr] \x1b[90m    0.512\x1b[0m \x1b[1;31mERROR\x1b[0m \x1b[90m[weft]\x1b[0m " +
    `mod mytweak was built against another mod ABI (5f0569a6bea71b81, this engine has ${ENGINE_ABI}); rebuild it against the current weft_sdk`,
  loadFailed:
    "[stderr]     0.40 INFO  [modloader] unpacked mod structures\n" +
    "[stderr]     0.40 ERROR [weft] loading mod structures from /home/player/.cache/weft/mods/4242-libstructures.so: undefined symbol: weft_world_spawn_v3",
  notAMod: "[stderr]     0.40 ERROR [weft] /home/player/.local/share/weft/mods/4242-liboldtweak.so is not a Weft mod",
  wrongName: "[stderr]     0.40 ERROR [weft] mod mytweak is the crate my_tweak: name its folder or zip my_tweak",
  // My Tweak is a file from the player's computer: the launcher can't know what it needs, so
  // nothing blocked Play. Cogwork is installed but off in this scenario.
  missingDep: "[stderr]     0.40 ERROR [weft] mod mytweak requires missing mod cogwork",
  initPanicked:
    "[stderr]     0.10 INFO  [modloader] unpacked mod cogwork\n" +
    "[stderr]     0.31 ERROR [mod:cogwork] panicked at src/tubes.rs:88:14: index out of bounds\n" +
    "[stderr]     0.32 ERROR [weft] cogwork: init panicked",
};
