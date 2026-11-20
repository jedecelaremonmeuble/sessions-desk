// Provenance des messages de la « conversation complète » : le serveur la lit dans le transcript (transcriptLine), la
// page en tire un libellé et une couleur (convOrigin, fonction PURE d'app.js extraite du fichier servi).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { transcriptLine, type Item } from '../src/transcript.ts';

const js = readFileSync(fileURLToPath(new URL('../../page/app.js', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
const part = (re: RegExp): string => { const m = js.match(re); if (!m) throw new Error(re + ' introuvable dans la page'); return m[0]; };
type Origin = { cls: string; who: string; text?: string; err?: boolean };
const convOrigin = new Function(part(/\nconst AGENT_FR = \{[\s\S]*?\};\n/) + part(/\nconst AGENT_KIND = \{.*\};\n/)
  + part(/\nfunction convOrigin\([^)]*\) \{[\s\S]*?\n\}\n/) + '\nreturn convOrigin;')() as (m: Partial<Item>, phase: string | null) => Origin;

const line = (o: Record<string, unknown>): Item[] => { const out: Item[] = []; transcriptLine(JSON.stringify(o), out); return out; };
const NOTIF = '<task-notification>\n<task-id>abc</task-id>\n<status>completed</status>\n<summary>Background command "a &amp;&amp; b" completed (exit code 0)</summary>\n</task-notification>';

describe('serveur : provenance d’une ligne « user »', () => {
  test('tapé ou collé par la personne : pas de marque', () => {
    expect(line({ type: 'user', origin: { kind: 'human' }, promptSource: 'typed', message: { content: 'bonjour' } })).toEqual([{ at: '', r: 'user', t: 'bonjour' }]);
    expect(line({ type: 'user', message: { content: 'ancien transcript' } })).toEqual([{ at: '', r: 'user', t: 'ancien transcript' }]);
  });
  test('fin de tâche de fond et consigne d’un lancement sans terminal', () => {
    expect(line({ type: 'user', origin: { kind: 'task-notification', producer: 'session-task' }, promptSource: 'system', message: { content: NOTIF } })).toEqual([{ at: '', r: 'user', t: NOTIF, o: 'task' }]);
    expect(line({ type: 'user', promptSource: 'sdk', message: { content: [{ type: 'text', text: 'Session automatique' }] } })).toEqual([{ at: '', r: 'user', t: 'Session automatique', o: 'sdk' }]);
  });
  test('jamais sur un résultat d’outil ni sur une réponse', () => {
    expect(line({ type: 'user', promptSource: 'sdk', message: { content: [{ type: 'tool_result', content: 'ok' }] } })).toEqual([{ at: '', r: 'result', t: 'ok' }]);
    expect(line({ type: 'assistant', promptSource: 'sdk', message: { content: [{ type: 'text', text: 'fait' }] } })).toEqual([{ at: '', r: 'assistant', t: 'fait' }]);
  });
});

describe('page : libellé et couleur selon la provenance', () => {
  test('session ordinaire : Toi / Claude, comme avant', () => {
    expect(convOrigin({ r: 'user', t: 'bonjour' }, null)).toEqual({ cls: '', who: 'Toi' });
    expect(convOrigin({ r: 'assistant', t: 'salut' }, null)).toEqual({ cls: '', who: 'Claude' });
  });
  test('conversation d’un run : la consigne vient du lanceur, la réponse de l’agent de l’étape', () => {
    expect(convOrigin({ r: 'user', t: 'Session de relecture…', o: 'sdk' }, 'relecture')).toEqual({ cls: 'auto', who: '🤖 Lanceur · consigne du run' });
    expect(convOrigin({ r: 'assistant', t: 'verdict' }, 'relecture')).toEqual({ cls: 'agent ag-review', who: '🤖 Agent de relecture' });
    expect(convOrigin({ r: 'assistant', t: 'x' }, 'dev').cls).toBe('agent ag-dev');
    expect(convOrigin({ r: 'assistant', t: 'x' }, 'suite')).toEqual({ cls: 'agent ag-diag', who: '🤖 Agent de diagnostic · suite' });
    expect(convOrigin({ r: 'assistant', t: 'x' }, 'inconnue')).toEqual({ cls: 'agent ag-other', who: '🤖 Agent du lanceur · inconnue' });
    // Run rouvert dans un onglet : ce que la personne y tape ensuite reste « Toi ».
    expect(convOrigin({ r: 'user', t: 'et ce cas ?' }, 'relecture')).toEqual({ cls: '', who: 'Toi' });
    // Même consigne lue hors d'un run (session rouverte) : un automate, pas la personne.
    expect(convOrigin({ r: 'user', t: 'Session…', o: 'sdk' }, null).who).toBe('🤖 Automate · consigne de lancement');
  });
  test('fin de tâche de fond : le résumé seul, échec signalé — reconnue aussi sans marque du serveur', () => {
    expect(convOrigin({ r: 'user', t: NOTIF, o: 'task' }, null)).toEqual({ cls: 'task', who: '⚙ Tâche de fond', text: 'Background command "a && b" completed (exit code 0)', err: false });
    expect(convOrigin({ r: 'user', t: NOTIF.replace('completed</status>', 'failed</status>') }, null).err).toBe(true);
  });
  test('collage seul : libellé à part, balises retirées ; un collage au milieu d’un message reste « Toi »', () => {
    expect(convOrigin({ r: 'user', t: '<pasted_content id="a1">\nréponse reçue\nsuite\n</pasted_content>' }, null)).toEqual({ cls: 'paste', who: '📋 Collé dans la session', text: 'réponse reçue\nsuite' });
    expect(convOrigin({ r: 'user', t: 'regarde :\n<pasted_content id="a1">x</pasted_content>' }, null)).toEqual({ cls: '', who: 'Toi' });
    expect(convOrigin({ r: 'user', t: '<pasted_content id="a">x</pasted_content> et <pasted_content id="b">y</pasted_content>' }, null)).toEqual({ cls: '', who: 'Toi' });
  });
});
