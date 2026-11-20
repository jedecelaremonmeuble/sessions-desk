// Santé du relais d'accès distant : lecture de Tailscale et verdict affiché dans l'en-tête de la page.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { parseIdentity, parseServePort, relayHealth, type RelayFacts } from '../src/relay.ts';
import { PAGE_DIR } from './helpers.ts';

const ORIGIN = 'https://poste.example.ts.net';
const serve = (proxy: string, host = 'poste.example.ts.net:443') => JSON.stringify({ TCP: { 443: { HTTPS: true } }, Web: { [host]: { Handlers: { '/': { Proxy: proxy } } } } });
const facts = (over: Partial<RelayFacts> = {}): RelayFacts => ({
  port: 8766, listening: true, listenError: null, identity: { owner: 'moi@example.com', origin: ORIGIN }, identityError: null,
  servePort: 8766, serveError: null, ...over,
});

test('identité : propriétaire et nom du poste tirés de tailscale status', () => {
  const out = JSON.stringify({ Self: { UserID: 42, DNSName: 'poste.example.ts.net.' }, User: { 42: { LoginName: 'moi@example.com' } } });
  expect(parseIdentity(out)).toEqual({ owner: 'moi@example.com', origin: ORIGIN });
});

test('identité : poste déconnecté du tailnet (ni utilisateur ni nom) ⇒ aucune', () => {
  expect(parseIdentity(JSON.stringify({ BackendState: 'NeedsLogin', Self: { UserID: 0, DNSName: '' } }))).toBeNull();
  expect(parseIdentity('pas du json')).toBeNull();
});

test('tailscale serve : port local servi pour le nom du poste, quelle que soit la casse', () => {
  expect(parseServePort(serve('http://localhost:8766'), ORIGIN)).toBe(8766);
  expect(parseServePort(serve('http://127.0.0.1:8766/', 'POSTE.example.ts.net:443'), ORIGIN)).toBe(8766);
});

test('tailscale serve : autre nom, rien de servi ou cible distante ⇒ aucun port', () => {
  expect(parseServePort(serve('http://localhost:8766', 'autre.example.ts.net:443'), ORIGIN)).toBeNull();
  expect(parseServePort('{}', ORIGIN)).toBeNull();
  expect(parseServePort(serve('https://example.com'), ORIGIN)).toBeNull();
});

test('verdict : tout en place ⇒ prêt, avec l’adresse à ouvrir', () => {
  expect(relayHealth(facts())).toEqual({ ok: true, port: 8766, url: ORIGIN, problems: [], fix: null });
});

test('verdict : identité inconnue (serveur lancé avant Tailscale) ⇒ coupé, réparable par le bouton', () => {
  const h = relayHealth(facts({ identity: null, identityError: 'poste déconnecté', servePort: undefined }));
  expect(h.ok).toBe(false);
  expect(h.problems.join()).toMatch(/identité Tailscale inconnue/);
  expect(h.fix).toBeNull();
});

test('verdict : relais arrêté ⇒ coupé, avec la cause', () => {
  const h = relayHealth(facts({ listening: false, listenError: 'EADDRINUSE' }));
  expect(h.ok).toBe(false);
  expect(h.problems.join()).toMatch(/relais arrêté \(port 8766\).*EADDRINUSE/);
});

test('verdict : tailscale serve vers un autre port ou absent ⇒ la commande à lancer', () => {
  expect(relayHealth(facts({ servePort: 8768 }))).toMatchObject({ ok: false, fix: 'tailscale serve --bg 8766' });
  expect(relayHealth(facts({ servePort: null }))).toMatchObject({ ok: false, fix: 'tailscale serve --bg 8766' });
});

test('verdict : tailscale serve pas encore lu ⇒ pas d’alerte', () => {
  expect(relayHealth(facts({ servePort: undefined })).ok).toBe(true);
});

test('page : l’indicateur est rendu à chaque passe et son clic relance le relais', () => {
  const js = readFileSync(join(PAGE_DIR, 'app.js'), 'utf8');
  expect(readFileSync(join(PAGE_DIR, 'index.html'), 'utf8')).toMatch(/id="relaybtn"/);
  expect(js).toMatch(/renderRelay\(data\.server && data\.server\.relay\)/);
  expect(js).toMatch(/post\('\/api\/relay\/restart'\)/);
});
