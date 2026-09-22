// Keep ownership of every in-flight operation even when a sibling fails.
export async function settleAll(operations) {
  const results = await Promise.allSettled(operations);
  const failure = results.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
  return results.map((result) => result.value);
}
