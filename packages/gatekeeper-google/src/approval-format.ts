/** Bound an approval title to one display-safe line. */
export function sanitizeApprovalTitle(value: string): string {
  return value.replace(/[\r\n]+/g, " ").slice(0, 200);
}

/** Fence an untrusted value so it cannot forge surrounding approval Markdown. */
export function formatApprovalField(label: string, value: string): string {
  let longestRun = 2;
  let currentRun = 0;
  for (let index = 0; index < value.length; index++) {
    if (value[index] === "`") {
      currentRun++;
      if (currentRun > longestRun) longestRun = currentRun;
    } else {
      currentRun = 0;
    }
  }
  let fence = "`".repeat(longestRun + 1);
  return `**${label}:**\n\n${fence}\n${value}\n${fence}`;
}
