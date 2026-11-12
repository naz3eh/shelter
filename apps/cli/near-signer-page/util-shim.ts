// Browser stand-in for Node's `util`, which generate-function (pulled in by
// @near-js/accounts through is-my-json-valid) requires for `util.format`
// only. Supports %s %d %i %j and %%, like Node's.
export function format(fmt: unknown, ...args: unknown[]): string {
  if (typeof fmt !== "string") return [fmt, ...args].map(String).join(" ");
  let i = 0;
  const out = fmt.replace(/%[sdij%]/g, (m) => {
    if (m === "%%") return "%";
    if (i >= args.length) return m;
    const a = args[i++];
    if (m === "%j") return JSON.stringify(a);
    if (m === "%d" || m === "%i") return String(m === "%i" ? Math.trunc(Number(a)) : Number(a));
    return String(a);
  });
  return [out, ...args.slice(i).map(String)].join(" ");
}
export default { format };
