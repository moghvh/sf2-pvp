// Shadow Fight 2 PvP — the game's own <Triggers> rule table.
//
// moves.xml ends with a `<Triggers>` section the move list never mentions: 86 rules of
// `<Events>` + `<Conditions>` + optional `<Locks>` (a perk the rule needs) + `<Actions>`.
// The three rules that fire on a plain `<Hit/>` with NO perk lock are the game's generic
// impact feedback, and they are the reason the 30-frame `hit` sheet has no consumer:
//
//   CriticalEffect  <Hit Type="Critical">                    -> <HitEffect FileName="critical"/>
//   BlockEffect     <CurrentInterval Type="Block">           -> <HitEffect FileName="block"/>
//   HitEffect       not Block, not Critical                  -> <HitEffect FileName="hit_blade"/>
//
// The engine builds each sheet from the file name itself (sf2.js class `ng`): frames are
// `<file>/<file>_<i>`, i = 1..n, played at 60 fps, with n a switch on the name —
// block 24, effect_shield_hex_hit 16, critical 29, hit_blade 29, and 0 for the two magic ones
// (effect_tornado_hit, mgc_effect_gust_up), whose frames live in a magic atlas instead.
//
//   node pvp/tools/build-triggers.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const XML = path.join(ROOT, 're-notes/web-build/moves.97f61623.xml');
const OUT = path.join(ROOT, 'pvp/data/triggers.json');

// sf2.js: switch (this.QT) { case "block": 24; case "effect_shield_hex_hit": 16;
//         case "critical": case "hit_blade": 29; default: 0 }
const HIT_FRAMES = { block: 24, effect_shield_hex_hit: 16, critical: 29, hit_blade: 29 };

const xml = fs.readFileSync(XML, 'utf8');
const section = /<Triggers>([\s\S]*?)<\/Triggers>/.exec(xml);
if (!section) throw new Error('moves.xml has no <Triggers> section');

const attr = (s, n) => (new RegExp(`${n}="([^"]*)"`).exec(s) || [])[1];
const triggers = [];
for (const t of section[1].matchAll(/<Trigger\b([^>]*)>([\s\S]*?)<\/Trigger>/g)) {
  const name = attr(t[1], 'Name');
  const body = t[2];
  const part = (tag) => (new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(body) || [])[1] || '';
  const events = [...part('Events').matchAll(/<(\w+)\b([^>]*)\/?>/g)].map((m) => ({ e: m[1], a: m[2].trim() || undefined }));
  const locks = [...part('Locks').matchAll(/<(\w+)\b([^>]*)\/?>/g)].map((m) => ({ l: m[1], name: attr(m[2], 'Name'), player: attr(m[2], 'Player') }));
  const conds = [...part('Conditions').matchAll(/<(\w+)\b([^>]*)\/?>/g)].map((m) => ({
    c: m[1], name: attr(m[2], 'Name'), type: attr(m[2], 'Type'),
    player: attr(m[2], 'Player'), not: /Not="1"/.test(m[2]) || undefined,
  }));
  const actions = [...part('Actions').matchAll(/<(\w+)\b([^>]*?)\/?>/g)].map((m) => ({ a: m[1], raw: m[2].trim() }));
  triggers.push({ name, events, locks, conds, actions });
}

// The generic impact rules: fire on <Hit/>, need no perk. Each keeps the game's own file name,
// its frame count and the scale/rotation the action states.
const hitRules = [];
for (const t of triggers) {
  if (!t.events.some((e) => e.e === 'Hit')) continue;
  if (t.locks.length) continue;
  const act = t.actions.find((a) => a.a === 'HitEffect');
  if (!act) continue;
  const file = attr(act.raw, 'FileName');
  hitRules.push({
    trigger: t.name,
    file,
    frames: HIT_FRAMES[file] ?? 0,
    rot: Number(attr(act.raw, 'StartingRotation') || 0),
    sc: Number(attr(act.raw, 'ChangeHitEffectScale') || 1),
    // the shape of the rule, kept verbatim so the client's choice can be checked against it
    critical: t.conds.some((c) => c.c === 'Hit' && c.type === 'Critical' && !c.not) || undefined,
    notCritical: t.conds.some((c) => c.c === 'Hit' && c.type === 'Critical' && c.not) || undefined,
    block: t.conds.some((c) => c.c === 'CurrentInterval' && c.type === 'Block' && !c.not) || undefined,
    notBlock: t.conds.some((c) => c.c === 'CurrentInterval' && c.type === 'Block' && c.not) || undefined,
    hitName: (t.conds.find((c) => c.c === 'Hit' && c.name && !c.not) || {}).name,
  });
}

// `<ShakeScreen …>` is the camera kick the same rules ask for; internal_settings.xml states the
// same four numbers per hit class in its own <HitEffects> table (CriticalHit / HeadHit / Shock).
const shakeActions = triggers.flatMap((t) => t.actions.filter((a) => a.a === 'ShakeScreen').map((a) => ({
  trigger: t.name,
  pause: Number(attr(a.raw, 'PauseTime') || 0),
  time: Number(attr(a.raw, 'EffectTime') || 0),
  ax: Number(attr(a.raw, 'AmplitudeX') || 0), fx: Number(attr(a.raw, 'FrequencyX') || 0),
  ay: Number(attr(a.raw, 'AmplitudeY') || 0), fy: Number(attr(a.raw, 'FrequencyY') || 0),
})));

const settings = fs.readFileSync(path.join(ROOT, 're-notes/web-build/internal_settings.xml'), 'utf8');
const hitEffectSettings = [...(/<HitEffects>([\s\S]*?)<\/HitEffects>/.exec(settings)?.[1] || '')
  .matchAll(/<HitEffect\b([^>]*)\/>/g)].map((m) => ({
  type: attr(m[1], 'Type'),
  pause: Number(attr(m[1], 'PauseTime')), time: Number(attr(m[1], 'EffectTime')),
  ax: Number(attr(m[1], 'AmplitudeX')), fx: Number(attr(m[1], 'FrequencyX')),
  ay: Number(attr(m[1], 'AmplitudeY')), fy: Number(attr(m[1], 'FrequencyY')),
}));
const camera = /<CameraSettings\b([^>]*)\/>/.exec(settings)?.[1] || '';

const data = {
  source: {
    xml: 're-notes/web-build/moves.97f61623.xml <Triggers>',
    settings: 're-notes/web-build/internal_settings.xml <HitEffects> + <Camera>',
    engine: 'sf2.js class ng (HitEffect action): frames "<file>/<file>_<i>", i=1..n, 60 fps',
  },
  counts: {
    triggers: triggers.length,
    hitEvents: triggers.filter((t) => t.events.some((e) => e.e === 'Hit')).length,
    genericHitRules: hitRules.length,
    shakeActions: shakeActions.length,
  },
  fps: 60,
  hitRules,
  shake: shakeActions,
  hitEffectSettings,
  camera: {
    node: attr(camera, 'CameraNode'), binding: attr(camera, 'BindingNode'),
    maxWidth: Number(attr(camera, 'MaxWidth')), bindingLength: Number(attr(camera, 'BindingLength')),
    maxWidthDelta: Number(attr(camera, 'MaxWidthDelta')),
  },
  triggers,
};
fs.writeFileSync(OUT, JSON.stringify(data));
console.log(`triggers: ${data.counts.triggers}   on <Hit>: ${data.counts.hitEvents}   generic (no perk lock): ${hitRules.length}`);
for (const r of hitRules) console.log(`  ${r.trigger}: ${r.file} (${r.frames} frames)${r.block ? ' [block]' : ''}${r.critical ? ' [critical]' : ''}`);
console.log(`camera: ${JSON.stringify(data.camera)}`);
console.log(`-> ${path.relative(ROOT, OUT)}`);
