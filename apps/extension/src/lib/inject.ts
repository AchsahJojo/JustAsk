/** The top frame already answered a ping, so JustAsk is running there and does not need another inject. */
export function shouldInjectContentScript(topFrameAlive: boolean): boolean {
  return !topFrameAlive;
}
