/**
 * The default of a switch that handles every case of a union: `tsc` fails here when the union
 * grows a case the switch doesn't handle.
 */
export function unreachable(x: never): never {
  throw new Error(`unhandled: ${JSON.stringify(x)}`);
}
