// The upstream Halloween window is Oct 30 through Nov 2 in Europe/Madrid.
// A room gets one server-selected value so every participant starts the same mode.
const calendar = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', month: '2-digit', day: '2-digit' });
export function halloweenAt(now) {
  const parts = Object.fromEntries(calendar.formatToParts(new Date(now)).map(p => [p.type, p.value]));
  return (+parts.month === 10 && +parts.day >= 30) || (+parts.month === 11 && +parts.day <= 2);
}
