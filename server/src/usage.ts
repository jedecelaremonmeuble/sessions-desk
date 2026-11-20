// Quota des comptes Claude (Get-ClaudeUsage) et conversions de dates du lanceur (ConvertTo-LaunchMs).
import type { Config } from './config.ts';
import { mtimeMs, psString, readJson, stripBom } from './util.ts';
import { readFileSync } from 'node:fs';

/**
 * ConvertTo-LaunchMs. Côté PowerShell, ConvertFrom-Json a déjà converti les chaînes ISO en DateTime ; ici elles
 * arrivent en texte : Date.parse les lit de la même façon (Z ou décalage ⇒ instant exact, sans décalage ⇒ heure
 * locale, comme un DateTime « Unspecified » passé par ToUniversalTime). Nombre ou texte illisible ⇒ 0.
 */
export function launchMs(v: unknown): number {
  if (typeof v !== 'string') return 0;
  const t = Date.parse(v.trim());
  return Number.isFinite(t) ? t : 0;
}
const msOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || psString(v) === '') return null;
  const x = launchMs(v);
  return x ? x : null;
};

/** Arrondi .NET par défaut (Math.Round, [int]/[long] d'un double) : au pair le plus proche. */
export function roundHalfEven(x: number, digits = 0): number {
  const f = 10 ** digits; const y = x * f;
  const r = Math.round(y);
  const half = Math.abs(y - Math.trunc(y)) === 0.5;
  return (half ? (r % 2 === 0 ? r : r - 1) : r) / f;
}

let cache: { stamp: number; value: unknown[] } = { stamp: -1, value: [] };

/** Get-ClaudeUsage : relevé d'un collecteur externe (module « quota »), relu seulement quand le fichier change. */
export function readClaudeUsage(cfg: Config): unknown[] {
  const f = usageFile(cfg);
  if (!f) return [];
  const stamp = mtimeMs(f);
  if (stamp === cache.stamp) return cache.value;
  let value: unknown[] = [];
  try {
    const j = JSON.parse(stripBom(readFileSync(f, 'utf8'))) as Record<string, Record<string, unknown>>;
    value = Object.entries(j).map(([uuid, a]) => {
      let limits: unknown[] = [];
      try {
        if (a.limitsJson) {
          const parsed = JSON.parse(String(a.limitsJson)) as unknown;
          limits = (Array.isArray(parsed) ? parsed : [parsed]).map((x) => {
            const l = (x ?? {}) as Record<string, unknown>;
            const scope = l.scope as { model?: { display_name?: unknown } } | undefined;
            return { kind: psString(l.kind), pct: l.percent ?? null, model: scope?.model?.display_name ?? null, resetsAt: msOrNull(l.resets_at), active: Boolean(l.is_active), severity: psString(l.severity) };
          });
        }
      } catch { limits = []; }
      return {
        uuid, alias: a.alias ?? null, plan: a.plan ?? null, status: psString(a.status),
        weeklyPct: a.weeklyPct ?? null, weeklyResetsAt: msOrNull(a.weeklyResetsAt), weeklyProjectedPct: a.weeklyProjectedPct ?? null, weeklyFullAt: msOrNull(a.weeklyFullAt),
        fiveHourPct: a.fiveHourPct ?? null, fiveHourResetsAt: msOrNull(a.fiveHourResetsAt), measuredAt: msOrNull(a.measuredAt), limits,
      };
    });
  } catch { value = []; }
  cache = { stamp, value };
  return value;
}
/** Fichier du relevé : celui du module « quota », '' s'il est éteint. */
export const usageFile = (cfg: Config): string => cfg.modules.quota?.file ?? '';
export const readUsageRaw = (cfg: Config): unknown => { const f = usageFile(cfg); return f ? readJson(f) : undefined; };
