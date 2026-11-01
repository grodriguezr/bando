export function useStateLike<T>(initial: T) {
  let value = initial;
  const set = (next: T) => {
    value = next;
  };
  return [value, set] as const;
}

export function useCallback<T extends (...args: never[]) => unknown>(fn: T, _deps: unknown[]): T {
  return fn;
}
