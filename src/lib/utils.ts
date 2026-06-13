/** Compile-time exhaustiveness guard for discriminated union switches. */
export function assertNever(x: never): never {
  throw new Error(`Unhandled variant: ${JSON.stringify(x)}`);
}

