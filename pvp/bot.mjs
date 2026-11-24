// bot.mjs — the computer's choice of a move, from the game's own tactic tables.
//
// What is the engine's here, and what is not:
//
//   THE ENGINE'S (sf2.js, the web build):
//     * the weight of a candidate animation        class dc  @334093  `Gb` / `NZa` / `KZa`
//     * which <Animation> row of the tactic it takes class Pd @332330 `SCa`: the first row, in
//       file order, whose Name is "" or is the animation's own name or one of its Template tags
//       (`jc.cl`, @361396)
//     * the weighted pick                           class Pd  @332026  `sL`
//     * when the computer decides, what it may choose from, the <Tactics><Conditions> window and
//       the BeginnerCheat rule: `Fight.stepBot` / `botCandidates` / `botPick` in pvp/sim.mjs
//       (`zd.Bob` -> `UJa` -> `Gc.Zlb` -> `B_a` -> `MK` -> `Tlb`)
//   That chain is the decision the engine runs for a tactic of Type="Random".
//
//   OURS, stated: every tactic the bosses use is Type="Tabular" (only `Beginner` is "Random").
//   The Tabular decision (class ge, @306700) filters and times its candidates with outcome
//   tables computed per weapon pair (the 1515 `<weapon>_<weapon>` tactics assets), a memory of
//   the enemy's strikes, and the tactic's defence / dodge / block chances; it ends in the SAME
//   `Pd.sL` pick over the SAME <AnimationWeights>. Those tables are not ported, so a Tabular
//   tactic is played here through the Random decision with its own weights. A practice
//   opponent therefore chooses like the game's computer but does not read the player's attack
//   the way the game's does: it never blocks, dodges or counters on purpose.
//
// Terms of `Gb` the shipped rows never use (their attribute is in no <Animation> of
// tactic_settings.xml) are left out: CounterFactor, DamageFactor, HealthFactor,
// EnemyHealthFactor, AnimationFramesFactor, ChildFramesFactor, MagicBulletFactor,
// MissileBulletFactor, HitFactor. The 8 <AnimationFactors> children (the memory of how often a
// ranged missile hit) and the one ConditionalDesigionFactor (the tables) are not ported.

/** `dc.NZa` (FactorType "Linear", the default) and `dc.KZa` ("Exponential"). */
export function shape(row, c) {
  if (row.factorType === 'Exponential') {
    return c >= 0 ? row.limit + (row.base - row.limit) * Math.pow(2, -c)
      : row.antiLimit + (row.base - row.antiLimit) * Math.pow(2, c);
  }
  return c >= 0 ? row.base + (row.limit - row.base) * Math.min(1, c)
    : row.base + (row.antiLimit - row.base) * Math.min(1, -c);
}

/** `dc.Gb`: `qza * DistanceFactor + Shift`, shaped. `qza` is `ge.r7a` -- |x of this model's
 *  direction node - x of the enemy's|, the node being <DirectionNode Name="NPivot"/>.
 *  `AntiLimit` is read under that spelling only (`this.xV = u.H(a.attributes.get("AntiLimit"))`):
 *  the two rows the file spells `Antilimit` have none, i.e. 0 -- the builder records which. */
export function weightOf(row, ctx) {
  const c = ctx.distance * (row.distanceFactor || 0) + (row.shift || 0);
  return shape({ ...row, antiLimit: row.antiLimitRead ? row.antiLimit : 0 }, c);
}

/** `Pd.SCa`: the first row whose Name is "" or names the animation or one of its tags. */
export function rowFor(tactic, cand) {
  for (const row of tactic.weights) {
    if (row.name === '' || row.name === cand.name || cand.tags.includes(row.name)) return row;
  }
  return null;
}

/** `Pd.sL`: sum the weights; `g = rf() * sum`; walk the list subtracting each weight and
 *  return the first index that takes `g` below 0. A sum that is not positive picks nothing. */
export function pickIndex(weights, r) {
  let total = 0;
  for (const w of weights) total += w;
  if (!(total > 0)) return -1;
  let g = r * total;
  for (let i = 0; i < weights.length; i++) { g -= weights[i]; if (g < 0) return i; }
  return -1;
}

/** A computer player for one fighter: `tactics` is bosses.json `tactics`, `name` the
 *  <Warrior Tactic=…>. `beginnerCheat` is <Warrior BeginnerCheat="1">: no ATTACK-typed move while
 *  the enemy's health is at or under <Random><BeginnerCheat Treshold> (`Gc.B_a`, @350700). */
export function makeBot(tactics, name, { beginnerCheat = false, cheatThreshold = 0 } = {}) {
  const tactic = tactics[name];
  if (!tactic) throw new Error(`unknown tactic ${name}`);
  return {
    tactic, beginnerCheat: !!beginnerCheat, cheatThreshold,
    weight(cand, ctx) { const row = rowFor(tactic, cand); return row ? weightOf(row, ctx) : 0; },
  };
}
