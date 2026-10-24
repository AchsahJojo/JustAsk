/** The line shown when a task is finished. She did every step herself. */
export function doneLine(clicks: number): string {
  return `You made ${clicks} ${clicks === 1 ? "click" : "clicks"} yourself.`;
}
