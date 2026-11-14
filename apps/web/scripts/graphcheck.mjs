import { chromium } from "playwright";
const b = await chromium.launch();
for (const w of [1440, 1024, 390]) {
  const ctx = await b.newContext({ viewport: { width: w, height: 900 } });
  const p = await ctx.newPage();
  await p.goto("http://localhost:3000", { waitUntil: "networkidle" });
  await p.waitForTimeout(1500);
  const report = await p.evaluate(() => {
    const out = [];
    document.querySelectorAll("svg[role='img']").forEach((svg, si) => {
      const nodes = [...svg.querySelectorAll("rect.fill-surface-2")].map((r) => ({ el: r, b: r.getBBox() }));
      const labels = [...svg.querySelectorAll("g")].filter((g) => g.querySelector("rect.fill-background")).map((g) => ({ el: g, b: g.getBBox() }));
      const inter = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
      const area = (i) => Math.max(0, Math.min(i.b.x + i.b.width, i.b2?.x + (i.b2?.width ?? 0)) );
      const hits = [];
      labels.forEach((l, li) => {
        nodes.forEach((n, ni) => { if (inter(l.b, n.b)) hits.push(`label${li}~node${ni}`); });
        labels.forEach((l2, li2) => { if (li2 > li && inter(l.b, l2.b)) hits.push(`label${li}~label${li2}`); });
      });
      const vb = svg.viewBox.baseVal;
      const outside = [...nodes.map(n=>n.b), ...labels.map(l=>l.b)].filter((bb) => bb.x < vb.x || bb.y < vb.y || bb.x + bb.width > vb.x + vb.width || bb.y + bb.height > vb.y + vb.height);
      out.push({ svg: si, labelCount: labels.length, nodeCount: nodes.length, overlaps: hits, outsideViewBox: outside.length });
    });
    return out;
  });
  console.log(`viewport ${w}:`, JSON.stringify(report));
  await ctx.close();
}
await b.close();
