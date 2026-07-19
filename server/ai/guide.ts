import fs from 'node:fs';
import path from 'node:path';

// ============================================================================
// Recherche dans le guide d'utilisation (public/guide.html → dist/guide.html en
// production). Permet à Lexa de répondre aux questions « comment faire dans
// Nova » en s'appuyant sur le TEXTE RÉEL du guide, jamais sur une improvisation.
//
// Choix assumés : découpage par fiche + score lexical déterministe (pas
// d'embeddings, donc aucun appel API ni coût supplémentaire), et surtout PAS de
// guide dans le prompt système (≈15 000 tokens qui seraient payés à chaque
// question, y compris celles qui n'ont rien à voir).
// ============================================================================

export interface GuideSection { id: string; titre: string; texte: string }

let CACHE: GuideSection[] | null = null;

function guidePath(): string | null {
  for (const p of [path.resolve('public/guide.html'), path.resolve('dist/guide.html'),
    path.resolve(process.cwd(), 'public/guide.html'), path.resolve(process.cwd(), 'dist/guide.html')]) {
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return null;
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ', '&eacute;': 'é', '&egrave;': 'è' };
const unescape = (s: string) => s.replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? ' ');
const stripTags = (s: string) => unescape(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// Normalisation pour la comparaison : minuscules, sans accents.
const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const STOP = new Set(['le', 'la', 'les', 'un', 'une', 'des', 'de', 'du', 'et', 'ou', 'a', 'au', 'aux', 'en', 'dans', 'pour', 'par', 'sur', 'avec', 'je', 'tu', 'il', 'on', 'nous', 'vous', 'mon', 'ma', 'mes', 'ce', 'cet', 'cette', 'que', 'qui', 'quoi', 'comment', 'ou', 'est', 'sont', 'ai', 'as', 'faire', 'fais', 'peut', 'puis', 'dois', 'doit', 'nova', 'lexa', 'svp']);

export function loadGuide(force = false): GuideSection[] {
  if (CACHE && !force) return CACHE;
  const p = guidePath();
  if (!p) { CACHE = []; return CACHE; }
  let html = '';
  try { html = fs.readFileSync(p, 'utf8'); } catch { CACHE = []; return CACHE; }

  const out: GuideSection[] = [];
  // Chaque fiche : <section class="fiche" id="..."> … </section>
  const re = /<section class="fiche" id="([^"]+)">([\s\S]*?)<\/section>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const id = m[1];
    const body = m[2];
    const h2 = /<h2[^>]*>([\s\S]*?)<\/h2>/.exec(body);
    const titre = h2 ? stripTags(h2[1]) : id;
    const texte = stripTags(body);
    if (texte) out.push({ id, titre, texte });
  }
  CACHE = out;
  return out;
}

// Score lexical. On matche en DÉBUT DE MOT (et non en sous-chaîne) : sinon
// « net » remonterait « internet », « facture » ne couvrirait pas « factures ».
// Le préfixe couvre naturellement les pluriels et accords du français.
const rx = (term: string) => new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g');

function score(section: GuideSection, terms: string[]): number {
  const t = norm(section.titre);
  const b = norm(section.texte);
  let s = 0;
  for (const term of terms) {
    if (!term) continue;
    if (rx(term).test(t)) s += 12;
    const occurrences = (b.match(rx(term)) ?? []).length;
    if (occurrences > 0) s += Math.min(occurrences, 5) * 2;
  }
  return s;
}

export interface GuideHit { fiche: string; titre: string; extrait: string; }

export function searchGuide(query: string, limit = 2): GuideHit[] {
  const sections = loadGuide();
  if (!sections.length) return [];
  const terms = [...new Set(norm(String(query ?? ''))
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w)))];
  if (!terms.length) return [];

  return sections
    .map((sec) => ({ sec, sc: score(sec, terms) }))
    // Seuil calé pour exiger, en pratique, une correspondance de TITRE (12) ou
    // une forte densité dans le corps : une question de données (« mon résultat
    // net ») ne doit pas remonter de fiche au hasard.
    .filter((x) => x.sc >= 12)
    .sort((a, b) => b.sc - a.sc)
    .slice(0, Math.max(1, Math.min(limit, 3)))
    .map(({ sec }) => ({
      fiche: sec.id,
      titre: sec.titre,
      // On borne l'extrait : une fiche complète suffit largement, sans gonfler
      // le contexte (le guide entier ferait ~15 000 tokens).
      extrait: sec.texte.length > 2600 ? `${sec.texte.slice(0, 2600)}…` : sec.texte,
    }));
}
