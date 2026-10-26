/** Attempt every cleanup even if an earlier resource fails to close. */
export async function closeDemoResources(closers) {
  const errors = [];
  for (const close of closers) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new globalThis.AggregateError(errors, 'Could not close all local demo resources');
}
