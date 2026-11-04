/**
 * Turns a @shelter/core ScanReport into a private NEAR AI explanation.
 *
 * Privacy contract: the report is redacted before anything leaves the device.
 * Every 0x address becomes a stable alias (scanned wallets -> "Wallet N",
 * anything else -> "Counterparty N"), every tx hash is dropped, and only the
 * check letter, kind, points, label names, ENS/.near names and the aliased
 * detail text are kept. The alias map stays on the client.
 */

import type { ScanReport } from "@shelter/core";

export interface RedactedFinding {
  check: string;
  kind: string;
  points: number;
  /** e.g. "Wallet 1" (a scanned wallet) — never the raw address. */
  wallet: string;
  /** Human-readable detail with every address replaced by its alias. */
  detail: string;
  /** Exchange/OFAC label names are kept: they identify a service, not you. */
  label?: string;
  /** ENS / .near names are kept per the redaction spec. */
  name?: string;
  linkedWallets?: string[];
}

export interface RedactedWarning {
  kind: string;
  wallet: string;
  detail: string;
}

export interface RedactedScanReport {
  score: number;
  band: string;
  linkedAddressCount: number;
  findings: RedactedFinding[];
  warnings: RedactedWarning[];
}

export interface RedactionResult {
  redacted: RedactedScanReport;
  /** alias -> original address; never leaves the client. */
  aliases: Record<string, string>;
}

const EVM_ADDRESS = /\b0x[0-9a-fA-F]{40}\b/g;

export function redactScanReport(report: ScanReport): RedactionResult {
  const aliases = new Map<string, string>(); // lowercase address -> alias
  const isScannedWallet = new Set(
    report.wallets.map((w) => w.wallet.address.toLowerCase()),
  );

  const aliasFor = (address: string): string => {
    const key = address.toLowerCase();
    const existing = aliases.get(key);
    if (existing) return existing;
    const walletCount = [...aliases.values()].filter((a) =>
      a.startsWith("Wallet "),
    ).length;
    const counterpartyCount = aliases.size - walletCount;
    const alias = isScannedWallet.has(key)
      ? `Wallet ${walletCount + 1}`
      : `Counterparty ${counterpartyCount + 1}`;
    aliases.set(key, alias);
    return alias;
  };

  const aliasText = (text: string): string =>
    text.replace(EVM_ADDRESS, (match) => aliasFor(match));

  const redactedFindings: RedactedFinding[] = report.findings.map((f) => ({
    check: f.check,
    kind: f.kind,
    points: f.points,
    wallet: aliasFor(f.wallet),
    detail: aliasText(f.detail),
    ...(f.evidence.label ? { label: f.evidence.label } : {}),
    ...(f.evidence.name ? { name: f.evidence.name } : {}),
    // evidence.txHashes and evidence.addresses are dropped entirely.
    ...(f.linkedWallets?.length
      ? { linkedWallets: f.linkedWallets.map(aliasFor) }
      : {}),
  }));

  const redactedWarnings: RedactedWarning[] = report.warnings.map((w) => ({
    kind: w.kind,
    wallet: aliasFor(w.wallet),
    detail: aliasText(w.detail),
  }));

  const aliasesObj: Record<string, string> = {};
  for (const [address, alias] of aliases) aliasesObj[alias] = address;

  return {
    redacted: {
      score: report.score,
      band: report.band,
      linkedAddressCount: report.linkedAddressCount,
      findings: redactedFindings,
      warnings: redactedWarnings,
    },
    aliases: aliasesObj,
  };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** The subset of an OpenAI-compatible completion the explainer needs. */
export interface CompletionResult {
  /** Completion id (chatcmpl-...) used by /v1/signature/{id}. */
  id: string;
  /** Assistant message text. */
  content: string;
}

/** Injected transport: the web route uses the openai package, the CLI fetch. */
export type CompletionCaller = (args: {
  model: string;
  messages: ChatMessage[];
}) => Promise<CompletionResult>;

export interface ExplanationJson {
  summary?: string;
  findings?: { check?: string; wallet?: string; explanation?: string }[];
}

export interface Explanation {
  /** Raw model text (JSON-encoded per the prompt). */
  text: string;
  /** Best-effort parse of the JSON the model was asked for. */
  parsed?: ExplanationJson;
  completionId: string;
  model: string;
  /** alias -> original address for client-side re-mapping. */
  aliases: Record<string, string>;
}

export function buildExplainMessages(
  redacted: RedactedScanReport,
): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "You are the privacy explainer inside Shelter, a wallet-privacy tool. " +
        "You receive an already-redacted on-chain exposure scan: addresses are " +
        "aliases like \"Wallet 1\" or \"Counterparty 2\" and there are no " +
        "transaction hashes. Explain what each finding means for the user's " +
        "privacy in one or two plain sentences each — what an observer could " +
        "learn and why it matters (targeting, phishing, linkage). Then a " +
        "short overall summary. Rules: never ask for or invent addresses, " +
        "keys, transaction hashes or amounts; never decide what the user " +
        "should move or when; keep the alias names exactly as given. Reply " +
        'only with JSON of the form {"summary": string, "findings": ' +
        '[{"check": string, "wallet": string, "explanation": string}]}.',
    },
    {
      role: "user",
      content: JSON.stringify(redacted),
    },
  ];
}

/**
 * Redact the report, ask the model for explanations, return the answer with
 * its completion id (which the caller uses to fetch the response signature).
 */
export async function explainScanReport(
  report: ScanReport,
  options: { model: string; createCompletion: CompletionCaller },
): Promise<Explanation> {
  const { redacted, aliases } = redactScanReport(report);
  const messages = buildExplainMessages(redacted);
  const completion = await options.createCompletion({
    model: options.model,
    messages,
  });
  return {
    text: completion.content,
    parsed: tryParseExplanation(completion.content),
    completionId: completion.id,
    model: options.model,
    aliases,
  };
}

function tryParseExplanation(text: string): ExplanationJson | undefined {
  try {
    const trimmed = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
    return JSON.parse(trimmed) as ExplanationJson;
  } catch {
    return undefined;
  }
}

/** Re-insert real addresses into the model's explanation, on the client. */
export function unredactText(
  text: string,
  aliases: Record<string, string>,
): string {
  return text.replace(
    /\b(Wallet|Counterparty) \d+\b/g,
    (alias) => aliases[alias] ?? alias,
  );
}
