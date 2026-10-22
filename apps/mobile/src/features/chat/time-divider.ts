/** Messenger-style separators: a timestamp between bubbles when the conversation resumes. */
const GAP_MS = 10 * 60_000;

const startOfDay = (timestamp: number) => {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

/** Show a divider for the first timestamp, a different day, or a pause of ten minutes. */
export function shouldShowTimestamp(previous: number | undefined, current: number | undefined, now = Date.now()): boolean {
  if (!current || current <= 0) return false;
  if (!previous || previous <= 0) return true;
  if (startOfDay(previous) !== startOfDay(current)) return true;
  return current - previous >= GAP_MS;
}

/** Time only for today, date plus time otherwise. Fixed to Chinese until i18n lands. */
export function formatTimestamp(timestamp: number, now = Date.now()): string {
  const date = new Date(timestamp);
  const time = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (startOfDay(now) !== startOfDay(timestamp)) {
    const day = date.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
    return `${day} ${time}`;
  }
  return time;
}
