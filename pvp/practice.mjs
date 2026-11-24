// practice.mjs — a fight against one of the game's own opponents, played by the computer.
//
// The opponents are stages.xml's <Warriors><Template>s, as pvp/tools/build-bosses.mjs lists
// them (pvp/data/bosses.json): the kit is the template's own items plus what its <Warrior>
// appearance adds, the perks are that appearance's, the tactic is its `Tactic`, the name is the
// APK's own localization of its `FirstName`.
//
// OURS, stated (the game has no "practice" screen):
//   * which appearance of a fighter is the one fought -- the builder's `def`: a fight that names
//     the template before one drawn from a <WarriorGroup>, then the most perks, then the
//     highest WarriorPower;
//   * the strength: `WarriorPower` (how the game scales an opponent to its chapter) is not
//     ported. The opponent's battle attributes are built like any player's -- `Ac.Pm` over the
//     items it carries, at level 1 -- so with the PvP <AttributesAlign> the two sides hit each
//     other equally. What the <Warrior> tag itself sets is kept, because `Pm` (sf2.js @418935)
//     lets the tag's own attributes REPLACE the computed ones (`if (this.pM.get(h, e)) { set;
//     continue }`): MagicInitialCharge, MagicPainRecharge, MagicDamageRecharge, CriticalChance …
//   * of the fight's <Rules>, <RechargeMagicEachRound/> and the perks it gives the opponent
//     (`<Perk Name ApplyTo="Bot|All"/>`: the Titan's PERK_TITAN) are kept; the rest is not applied
//     (damage factors, hot ground, win conditions and what a rule does to the PLAYER belong to
//     the story fight, not to a practice round);
//   * `SkeletonHeavy` (the Butcher, the bodyguards that carry it) and the Titan's size are not
//     modelled: every opponent stands on the normal skeleton.
import fs from 'node:fs';
import path from 'node:path';
import { makeBot } from './bot.mjs';

/** the <Warrior> attributes `Pm` takes from the tag as they are (a battle attribute each) */
const TAG_ATTRS = ['WeaponDamage', 'UnarmedDamage', 'RangedDamage', 'MagicDamage', 'BodyDefense', 'HeadDefense', 'CriticalChance',
  'MagicInitialCharge', 'MagicPainRecharge', 'MagicDamageRecharge', 'EnchantmentResistance'];

export function loadPractice(game) {
  const file = path.join(game.DATA_DIR, 'bosses.json');
  let data = null;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    console.warn(`bosses.json unavailable (${e.message}) — run: node pvp/tools/build-bosses.mjs`);
    return { fighters: [], tactics: {}, seat: () => null, bot: () => null };
  }
  const cards = new Map([...game.FAMILIES, ...game.ORPHAN_FAMILIES].map((f) => [f.id, f]));
  const byId = new Map(data.fighters.map((f) => [f.id, f]));
  /** the seat a practice opponent takes: what `startMatch` reads from a client, and the rest */
  const seat = (id) => {
    const f = byId.get(id);
    if (!f || !f.playable) return null;
    const card = cards.get(f.family);
    if (!card || card.playable === false) return null;
    const d = f.fights[f.def];
    // its own <Perks>, and the perks its fight's <Rules> give the opponent (`rulePerks`)
    const perks = [...new Set([...d.perks, ...(d.rulePerks || [])])].filter((p) => !/ITEM_SPECIAL/.test(p));
    return {
      boss: f.id, kind: f.kind, name: (f.name || f.id).slice(0, 16), weapon: f.family,
      weaponItem: f.weapon || null,       // its own weapon item (what it is drawn holding)
      ranged: f.ranged, magic: f.magic, helm: f.helm, armor: f.armor,
      perks, tactic: d.tactic || 'Standard',
      tagAttrs: Object.fromEntries(TAG_ATTRS.filter((k) => d.attrs[k] != null).map((k) => [k, d.attrs[k]])),
      rechargeMagic: d.rechargeMagic === 'Bot' || d.rechargeMagic === 'All',
      beginnerCheat: !!d.beginnerCheat,
      stage: f.stage, zone: d.zone, battle: d.battle,
    };
  };
  const bot = (s) => makeBot(data.tactics, data.tactics[s.tactic] ? s.tactic : 'Standard',
    { beginnerCheat: s.beginnerCheat, cheatThreshold: (data.random && data.random.beginnerCheatThreshold) ?? 0 });
  return { data, fighters: data.fighters, tactics: data.tactics, seat, bot };
}
