/**
 * A typed partial double: only the listed members exist, but their names are checked against
 * `T`, so renaming a repository method breaks the tests that stub it instead of silently
 * stubbing a method nobody calls anymore.
 */
export function stub<T>(members: { [K in keyof T]?: unknown } = {}): T {
  return members as T;
}
