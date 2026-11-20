// INVITE OCCUPÉE — ce qui est resté dans l'invite d'une session, lu sur son écran.
// L'invite de Claude Code est le dernier cadre « ─── / ❯ … / ─── » de l'écran. Un texte qui y reste (brouillon tapé
// dans le terminal, message tapé mais jamais parti, menu « / » ouvert) fait refuser tout envoi suivant : la page doit
// pouvoir le montrer et proposer de l'envoyer ou de le vider, au lieu d'un refus sans issue.
const SEP = /^[─━═]{8,}$/;

/** null : aucune invite à l'écran (dialogue plein écran, écran illisible) · '' : invite vide, ou qui n'affiche que la
 *  proposition de prompt · sinon le texte resté dans l'invite, une ligne d'écran par ligne. */
export function promptDraft(screen: string | null, suggestion: string | null): string | null {
  if (typeof screen !== 'string' || !screen) return null;
  const L = screen.split('\n').map((s) => s.replace(/\u00a0/g, ' ').trimEnd());
  const seps: number[] = [];
  for (let i = 0; i < L.length; i++) if (SEP.test(L[i]!.trim())) seps.push(i);
  for (let k = seps.length - 1; k > 0; k--) {
    const a = seps[k - 1]!, b = seps[k]!;
    if (b - a < 2 || !L[a + 1]!.startsWith('❯')) continue;
    if (suggestion) return '';
    const body = L.slice(a + 1, b).map((s, i) => (i === 0 ? s.slice(1) : s).replace(/^ {1,2}/, ''));
    while (body.length && !body.at(-1)!.trim()) body.pop();
    return body.join('\n');
  }
  return null;
}

/** Le texte de l'invite commence-t-il par ce qu'on vient de taper ? (comparaison sans espaces : l'invite replie les
 *  longues lignes, parfois au milieu d'une adresse) */
export function draftHolds(draft: string | null, line: string): boolean {
  const d = (draft ?? '').replace(/\s+/g, ''), l = line.replace(/\s+/g, '');
  return d.length > 0 && l.length > 0 && d.startsWith(l.slice(0, 40));
}
