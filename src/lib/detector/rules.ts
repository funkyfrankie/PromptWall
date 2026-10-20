// Layer 1: fast, deterministic heuristic scanner. Pure functions — no I/O.

export type Category =
  | "instruction_override"
  | "jailbreak_roleplay"
  | "prompt_exfiltration"
  | "data_exfiltration"
  | "delimiter_injection"
  | "obfuscation"
  | "multi_turn_escalation";

export interface RuleHit {
  id: string;
  category: Category;
  weight: number;
  match: string;
}

export interface RuleResult {
  score: number; // 0..1
  hits: RuleHit[];
  normalized: string;
  mitigated: boolean;
}

const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", $: "s" };

/** Normalize text to defeat trivial obfuscation (zero-width chars, leetspeak, spacing tricks). */
export function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF\u2060]/g, "")
    .toLowerCase()
    .replace(/[013457@$]/g, (c) => LEET[c] ?? c)
    .replace(/\b(\w)(?:[\s.\-_*]\1?)?(?=\w\b)/g, "$1") // light de-spacing
    .replace(/\s+/g, " ")
    .trim();
}

interface Rule {
  id: string;
  category: Category;
  weight: number;
  re: RegExp;
}

const RULES: Rule[] = [
  { id: "ignore-previous", category: "instruction_override", weight: 0.85, re: /\b(ignore|disregard|forget|override|bypass)\b.{0,40}\b(previous|prior|above|earlier|all|your|system)\b.{0,30}\b(instructions?|rules?|prompts?|directives?|guidelines?)/ },
  { id: "new-instructions", category: "instruction_override", weight: 0.6, re: /\b(new|updated|real|actual) (instructions?|rules?|task)\b.{0,15}(:|are|is)/ },
  { id: "you-are-now", category: "jailbreak_roleplay", weight: 0.55, re: /\byou are (now|no longer)\b/ },
  { id: "dan-mode", category: "jailbreak_roleplay", weight: 0.9, re: /\b(dan|do anything now|developer mode|jailbr[eo]ak(en)?|god mode|unfiltered mode)\b/ },
  { id: "no-restrictions", category: "jailbreak_roleplay", weight: 0.6, re: /\b(no|without|free from) (restrictions?|filters?|limitations?|guidelines?|rules|censorship|ethics)\b/ },
  { id: "pretend", category: "jailbreak_roleplay", weight: 0.35, re: /\b(pretend|act as if|roleplay as|imagine you are)\b/ },
  { id: "reveal-prompt", category: "prompt_exfiltration", weight: 0.8, re: /\b(reveal|show|print|repeat|output|tell me|what is|what are)\b.{0,30}\b(system prompt|initial (prompt|instructions)|hidden (prompt|instructions)|your instructions|text above)/ },
  { id: "confidential-config", category: "prompt_exfiltration", weight: 0.65, re: /\b(reveal|show|paste|print|share|dump|leak|output|explain)\b.{0,40}\b(confidential|hidden|secret|internal|private)\b.{0,15}\b(instructions?|notes?|setup|config(uration)?|prompt|rules)/ },
  { id: "authority-claim", category: "prompt_exfiltration", weight: 0.45, re: /\bi('?m| am) (the|your|a) (developer|admin(istrator)?|creator|engineer|owner|openai|anthropic)\b|\b(for|in) (debug(ging)?|maintenance|testing) (mode|purposes)?\b.{0,40}\b(paste|reveal|show|print)/ },
  { id: "staff-secret-request", category: "prompt_exfiltration", weight: 0.95, re: /^(?=.{0,400}\b(staff|staff[ -]team|employee|internal team)\b)(?=.{0,400}\b(secrets?|passwords?|credentials?|api[ _-]?keys?|(?:internal|private|confidential|secret|staff)\b.{0,35}\b(?:codes?|tokens?|notes?)|discount override code|(?:the|that) code)\b)(?=.{0,400}\b(give|show|tell|share|reveal|paste|print|send|what (?:is|are)|what['’]s)\b).{1,400}/ },
  { id: "repeat-verbatim", category: "prompt_exfiltration", weight: 0.6, re: /\b(repeat|print)\b.{0,30}\b(verbatim|word for word|everything above)/ },
  { id: "md-image-exfil", category: "data_exfiltration", weight: 0.75, re: /!\[[^\]]*\]\(https?:\/\/[^)]*(\{|%7b|\?.*=)/ },
  { id: "send-to-url", category: "data_exfiltration", weight: 0.6, re: /\b(send|post|forward|upload|leak)\b.{0,40}\b(to|at)\b.{0,10}(https?:\/\/|webhook|email)/ },
  { id: "secrets", category: "data_exfiltration", weight: 0.5, re: /\b(api[ _-]?keys?|passwords?|credentials|secrets?|tokens?)\b.{0,20}\b(list|give|show|dump|reveal)|\b(list|give|show|dump|reveal)\b.{0,20}\b(api[ _-]?keys?|passwords?|credentials|secrets?)/ },
  { id: "fake-system-tag", category: "delimiter_injection", weight: 0.7, re: /(<\/?(system|im_start|im_end|sys)>|\[\/?inst\]|###\s*(system|instruction)|<\|.*?\|>)/ },
  { id: "end-of-prompt", category: "delimiter_injection", weight: 0.55, re: /\b(end of (system )?prompt|begin(ning)? of (new )?(prompt|instructions))\b/ },
  { id: "decode-and-run", category: "obfuscation", weight: 0.55, re: /\b(decode|base64|rot13|reverse)\b.{0,40}\b(follow|execute|run|obey|do what)/ },
];

const BASE64_BLOB = /[A-Za-z0-9+/]{40,}={0,2}/;

// Cues that the user is discussing attacks rather than performing one.
const MITIGATORS = /\b(what is|explain|how (do|does|can) (i|we|you) (detect|prevent|defend)|example of|research|paper|for my (class|thesis)|is this (a|an) (prompt injection|attack))\b/;

export function scanText(text: string): RuleResult {
  const normalized = normalize(text);
  const hits: RuleHit[] = [];
  for (const r of RULES) {
    const m = normalized.match(r.re) ?? text.toLowerCase().match(r.re);
    if (m) hits.push({ id: r.id, category: r.category, weight: r.weight, match: m[0].slice(0, 80) });
  }
  const b64 = text.match(BASE64_BLOB);
  if (b64) hits.push({ id: "base64-blob", category: "obfuscation", weight: 0.35, match: b64[0].slice(0, 40) + "…" });

  // Noisy-OR combination: several weak signals add up, but never exceed 1.
  let score = 1 - hits.reduce((p, h) => p * (1 - h.weight), 1);
  // A direct staff-secret request is not made safe by adding “what is” or “for my thesis”.
  const mitigated = hits.length > 0 && !hits.some((h) => h.id === "staff-secret-request") && MITIGATORS.test(normalized);
  if (mitigated) score *= 0.5;
  return { score: round(score), hits, normalized, mitigated };
}

/** Multi-turn: scan the recent user turns together to catch attacks split across messages. */
export function scanConversation(userTurns: string[]): RuleResult {
  const last = scanText(userTurns[userTurns.length - 1] ?? "");
  if (userTurns.length < 2) return last;
  const recent = userTurns.slice(-4);
  const combined = scanText(recent.join(" \n "));
  const perTurn = recent.map((t) => scanText(t));
  const seen = new Set(perTurn.flatMap((r) => r.hits.map((h) => h.id)));
  // A genuine split payload: a pattern that only appears when turns are joined.
  const emergent = combined.hits.filter((h) => !seen.has(h.id));
  const priorSuspicious = perTurn.slice(0, -1).filter((r) => r.score > 0.2).length;
  const escalation = priorSuspicious >= 2 && last.score > 0;
  if (emergent.length > 0 || escalation) {
    const hits = [...last.hits, ...emergent];
    hits.push({ id: "split-payload", category: "multi_turn_escalation", weight: 0.4, match: "signals spread across recent turns" });
    const score = round(Math.max(last.score, emergent.length ? combined.score * 0.9 : 0, escalation ? 0.5 : 0));
    return { ...last, hits, score };
  }
  return last;
}

export type Verdict = "allow" | "flag" | "block";

export const THRESHOLDS = { flag: 0.4, block: 0.7, independentBlock: 0.9 } as const;

export function verdictFor(score: number): Verdict {
  if (score >= THRESHOLDS.block) return "block";
  if (score >= THRESHOLDS.flag) return "flag";
  return "allow";
}

/** Either high-confidence detector can independently block; otherwise use weighted scores. */
export function combineScores(rule: number, judge: number | null): number {
  if (judge === null) return rule;
  if (rule >= THRESHOLDS.independentBlock || judge >= THRESHOLDS.independentBlock) return round(Math.max(rule, judge));
  return round(0.35 * rule + 0.65 * judge);
}

function round(n: number) {
  return Math.round(n * 100) / 100;
}
