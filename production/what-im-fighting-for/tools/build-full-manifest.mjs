import { writeFileSync } from 'node:fs';

const cast = [
  {
    id: 'joseph_intact',
    name: 'Joseph (J0–J1 Intact)',
    type: 'imported_character',
    source: '../music-video/source/assets/Roman Joseph Start.glb',
    rigMode: 'saved-rig',
    rigPackage: '../music-video/source/assets/Roman Joseph Start.fsrig',
    height: 1.8,
    defaultPose: 'standing-alert',
  },
  {
    id: 'joseph_amputated',
    name: 'Joseph (J2/J4 Amputated)',
    type: 'imported_character',
    source: '../music-video/source/assets/Roman Joseph Amputated.glb',
    rigMode: 'saved-rig',
    rigPackage: '../music-video/source/assets/Roman Joseph Amputated.fsrig',
    height: 1.8,
    defaultPose: 'standing-alert',
  },
  {
    id: 'joseph_prosthetic',
    name: 'Joseph (J3 Prosthetic Fighter)',
    type: 'imported_character',
    source: '../music-video/source/assets/Roman Joseph Final.glb',
    rigMode: 'saved-rig',
    rigPackage: '../music-video/source/assets/Roman Joseph Final.fsrig',
    height: 1.8,
    defaultPose: 'sword-ready',
  },
];

const props = [
  { id: 'shield', name: 'Shield', primitive: 'shield', color: '#64748b', dimensions: [0.7, 1.0, 0.12] },
  { id: 'sword', name: 'Short Sword / Wrist Prosthetic', primitive: 'sword', color: '#cbd5e1', dimensions: [0.12, 0.9, 0.08] },
  { id: 'spider', name: 'Original Spider (composition proxy)', primitive: 'custom_simple', color: '#4ade80', dimensions: [0.55, 0.35, 0.7] },
  { id: 'hand_monster', name: 'Hand Monster (composition proxy)', primitive: 'custom_simple', color: '#a78bfa', dimensions: [1.1, 0.7, 1.0] },
  { id: 'abandoned_hand', name: 'Abandoned Right Hand (H0)', primitive: 'box', color: '#d6b8a0', dimensions: [0.25, 0.12, 0.35] },
  { id: 'abandoned_eye', name: 'Abandoned Right Eye (H0)', primitive: 'sphere', color: '#86efac', dimensions: [0.15, 0.15, 0.15] },
  { id: 'crossbar', name: 'Door Crossbar', primitive: 'cylinder', color: '#5b4636', dimensions: [0.2, 1.6, 0.2] },
  { id: 'door_panel', name: 'Armory Door Panel', primitive: 'box', color: '#6b5344', dimensions: [2.0, 2.4, 0.2] },
];

function josephFor(n) {
  if (n <= 4) return 'joseph_intact';
  if (n <= 16) return 'joseph_amputated';
  if (n <= 27) return 'joseph_prosthetic';
  return 'joseph_amputated';
}

function locFor(n) {
  if (n >= 10 && n <= 13) return 'corridor';
  if (n >= 15) return 'armory';
  return 'ruins';
}

const shotMeta = {
  1: { name: 'Spider ECU establishing', intent: 'still', cam: 'establishing', subjects: ['spider'], pose: null, notes: ['PROXY spider', 'No Joseph'] },
  2: { name: 'Venom spit on raised right hand', intent: 'still', cam: 'medium', subjects: ['joseph', 'spider', 'shield'], pose: 'standing-defensive', notes: ['J0 intact'] },
  3: { name: 'Infected right side / draw sword', intent: 'still', cam: 'profile', subjects: ['joseph', 'sword'], pose: 'reaching', notes: ['J0 infected'] },
  4: { name: 'First sacrifice silhouette', intent: 'still', cam: 'medium', subjects: ['joseph', 'sword'], pose: 'sword-ready', notes: ['J1 non-graphic'] },
  5: { name: 'Aftermath J2 and H0 parts', intent: 'still', cam: 'full', subjects: ['joseph', 'abandoned_hand', 'abandoned_eye'], pose: 'walking', notes: ['J2 begins', 'H0 parts'] },
  6: { name: 'False peace rest', intent: 'still', cam: 'medium', subjects: ['joseph', 'shield'], pose: 'seated', notes: ['J2 rest'] },
  7: { name: 'H0 parts join', intent: 'still', cam: 'low_angle', subjects: ['abandoned_hand', 'abandoned_eye', 'joseph'], pose: 'standing-neutral', notes: ['H0 joining'] },
  8: { name: 'H1 newborn hand creature', intent: 'still', cam: 'high_angle', subjects: ['hand_monster'], pose: null, notes: ['PROXY hand_monster H1'] },
  9: { name: 'H1 grows to H2 chase form', intent: 'still', cam: 'wide', subjects: ['hand_monster'], pose: null, notes: ['PROXY H2'] },
  10: { name: 'Monster POV stalk', intent: 'motion-optional', cam: 'low_angle', subjects: ['joseph', 'shield'], pose: 'walking', angle: 'rear', notes: ['J2 POV stalk'] },
  11: { name: 'Joseph senses threat', intent: 'still', cam: 'medium', subjects: ['joseph', 'shield'], pose: 'standing-alert', notes: ['J2'] },
  12: { name: 'H2 pounce / shield block', intent: 'still', cam: 'two_shot', subjects: ['joseph', 'hand_monster', 'shield'], pose: 'shield-ready', notes: ['J2 block'] },
  13: { name: 'Sprint chase toward armory', intent: 'motion-required', cam: 'wide', subjects: ['joseph', 'hand_monster', 'shield'], pose: 'running', notes: ['J2 chase'], motion: true },
  14: { name: 'Eyepatch face / armory light', intent: 'still', cam: 'close_up', subjects: ['joseph'], pose: 'standing-alert', notes: ['J2 face'] },
  15: { name: 'Bar the armory door', intent: 'still', cam: 'medium', subjects: ['joseph', 'crossbar', 'shield', 'door_panel'], pose: 'reaching', notes: ['J2 door lock'] },
  16: { name: 'Stump to weapon rack decision', intent: 'still', cam: 'medium', subjects: ['joseph', 'door_panel'], pose: 'injured', notes: ['J2 decision'] },
  17: { name: 'Attach right wrist sword', intent: 'still', cam: 'full', subjects: ['joseph', 'sword'], pose: 'holding-object', notes: ['J2→J3 prosthetic'] },
  18: { name: 'J3 battle-ready stance', intent: 'still', cam: 'wide', subjects: ['joseph', 'sword', 'shield'], pose: 'sword-ready', notes: ['J3 definitive'] },
  19: { name: 'Door under siege', intent: 'still', cam: 'full', subjects: ['door_panel', 'crossbar'], pose: null, notes: ['Door insert'] },
  20: { name: 'Joseph braces for breach', intent: 'still', cam: 'full', subjects: ['joseph', 'sword', 'shield'], pose: 'shield-ready', notes: ['J3 ready'] },
  21: { name: 'H3 finger breach', intent: 'still', cam: 'medium', subjects: ['hand_monster', 'door_panel'], pose: null, notes: ['PROXY H3 breach'] },
  22: { name: 'Breach and first exchange', intent: 'unsupported-performance', cam: 'wide', subjects: ['joseph', 'hand_monster', 'sword', 'shield'], pose: 'sword-ready', notes: ['J3 combat'], motion: true },
  23: { name: 'Predictive combat two-shot', intent: 'unsupported-performance', cam: 'wide', subjects: ['joseph', 'hand_monster', 'sword', 'shield'], pose: 'sword-ready', notes: ['J3 combat'], motion: true },
  24: { name: 'Mirrored stances realization', intent: 'still', cam: 'full', subjects: ['joseph', 'hand_monster', 'sword', 'shield'], pose: 'standing-defensive', notes: ['J3 mirrored'] },
  25: { name: 'Left arm pinned', intent: 'unsupported-performance', cam: 'medium_close_up', subjects: ['joseph', 'hand_monster', 'sword', 'shield'], pose: 'injured', notes: ['J3 pin'] },
  26: { name: 'Infection pulse at right stump', intent: 'still', cam: 'medium', subjects: ['joseph', 'sword'], pose: 'holding-object', notes: ['J3 infection'] },
  27: { name: 'Discard shield and detach sword', intent: 'unsupported-performance', cam: 'full', subjects: ['joseph', 'hand_monster', 'sword', 'shield'], pose: 'reaching', notes: ['J3 discard order'] },
  28: { name: 'Final non-graphic sacrifice', intent: 'unsupported-performance', cam: 'full', subjects: ['joseph', 'hand_monster', 'sword'], pose: 'sword-ready', notes: ['J3→J4 flash'] },
  29: { name: 'Monster dies mid-leap', intent: 'motion-required', cam: 'wide', subjects: ['joseph', 'hand_monster'], pose: 'injured', notes: ['J4 H4 die'], motion: true },
  30: { name: 'H4 corpse pins Joseph', intent: 'still', cam: 'full', subjects: ['joseph', 'hand_monster'], pose: 'injured', notes: ['J4 pin'] },
  31: { name: 'Survivor relief close-up', intent: 'still', cam: 'close_up', subjects: ['joseph'], pose: 'injured', notes: ['J4 survivor'] },
};

function expandSubjects(list, jId) {
  return list.map((s) => (s === 'joseph' ? jId : s));
}

function blockingFor(n, jId, subjects) {
  const loc = locFor(n);
  const meta = shotMeta[n];
  const blocks = [];
  if (subjects.includes(jId)) {
    let placement = { type: 'location_slot', slot: 'center' };
    let face;
    if (loc === 'armory' && n >= 15 && n !== 17) face = 'main_door';
    if (n === 17) placement = { type: 'relative', anchor: 'weapon_rack', relation: 'near' };
    if (n === 15 || n === 16) placement = { type: 'relative', anchor: 'main_door', relation: 'just_inside' };
    if (n === 6) placement = { type: 'location_slot', slot: 'left' };
    if (n === 25) placement = { type: 'relative', anchor: 'back_wall', relation: 'near' };
    blocks.push({
      subject: jId,
      placement,
      ...(face ? { face } : {}),
      ...(meta.pose ? { pose: meta.pose } : {}),
    });
  }
  if (subjects.includes('hand_monster')) {
    let placement = { type: 'location_slot', slot: 'center' };
    if (subjects.includes(jId)) {
      if ([12, 22, 28, 30].includes(n)) placement = { type: 'relative', anchor: jId, relation: 'in_front_of' };
      else if (n === 13) placement = { type: 'relative', anchor: jId, relation: 'behind' };
      else if ([23, 24, 27].includes(n)) placement = { type: 'relative', anchor: jId, relation: 'across_from' };
      else if ([25, 29].includes(n)) placement = { type: 'relative', anchor: jId, relation: 'near' };
      else if (n === 21) placement = { type: 'relative', anchor: 'main_door', relation: 'just_inside' };
    } else if (n === 8 || n === 9) {
      placement = { type: 'relative', anchor: 'platform', relation: 'near' };
    }
    blocks.push({ subject: 'hand_monster', placement });
  }
  if (subjects.includes('spider')) {
    blocks.push({
      subject: 'spider',
      placement: subjects.includes(jId)
        ? { type: 'relative', anchor: jId, relation: 'in_front_of' }
        : { type: 'location_slot', slot: 'center' },
    });
  }
  if (subjects.includes('shield')) {
    blocks.push({
      subject: 'shield',
      placement: subjects.includes(jId)
        ? { type: 'relative', anchor: jId, relation: n === 27 ? 'far_from' : 'left_of' }
        : { type: 'location_slot', slot: 'left' },
    });
  }
  if (subjects.includes('sword')) {
    blocks.push({
      subject: 'sword',
      placement: {
        type: 'relative',
        anchor: jId,
        relation: n >= 27 || n === 3 || n === 4 ? 'left_of' : 'right_of',
      },
    });
  }
  if (subjects.includes('abandoned_hand')) {
    blocks.push({
      subject: 'abandoned_hand',
      placement: subjects.includes(jId)
        ? { type: 'relative', anchor: jId, relation: 'behind' }
        : { type: 'location_slot', slot: 'foreground' },
    });
  }
  if (subjects.includes('abandoned_eye')) {
    blocks.push({
      subject: 'abandoned_eye',
      placement: { type: 'relative', anchor: 'abandoned_hand', relation: 'near' },
    });
  }
  if (subjects.includes('door_panel')) {
    blocks.push({ subject: 'door_panel', placement: { type: 'relative', anchor: 'main_door', relation: 'near' } });
  }
  if (subjects.includes('crossbar')) {
    blocks.push({
      subject: 'crossbar',
      placement: subjects.includes('door_panel')
        ? { type: 'relative', anchor: 'door_panel', relation: 'beside' }
        : { type: 'relative', anchor: 'main_door', relation: 'near' },
    });
  }
  return blocks;
}

const shots = [];
for (let n = 1; n <= 31; n += 1) {
  const meta = shotMeta[n];
  const jId = josephFor(n);
  const subjects = expandSubjects(meta.subjects, jId);
  let camSubjects = subjects.filter((s) => s.startsWith('joseph'));
  if (meta.cam === 'two_shot') camSubjects = [jId, 'hand_monster'];
  if (camSubjects.length === 0) camSubjects = subjects.slice(0, 1);

  const shot = {
    id: `shot_${String(n).padStart(2, '0')}`,
    shotNumber: String(n).padStart(2, '0'),
    name: meta.name,
    description: `${meta.name}. Continuity: ${meta.notes.join('; ')}. Intent: ${meta.intent}.`,
    locationId: locFor(n),
    subjects,
    blocking: blockingFor(n, jId, subjects),
    camera: {
      template: meta.cam,
      subjects: camSubjects,
      angle: meta.angle || (meta.cam === 'profile' ? 'profile' : 'three_quarter'),
      lensClass: meta.cam === 'wide' || meta.cam === 'establishing' || meta.cam === 'full' ? 'wide' : 'normal',
    },
    requirements: {
      ...(subjects.some((s) => s.startsWith('joseph')) ? { visibleSubjects: [jId] } : {}),
      notes: [
        `INTENT ${meta.intent}`,
        ...meta.notes,
        subjects.includes('hand_monster') || subjects.includes('spider')
          ? 'Creature uses sized proxy for composition; real GLB refined after base pass without project reset.'
          : undefined,
        meta.intent === 'unsupported-performance'
          ? 'Coarse timing/blocking guidance only — not final performance animation.'
          : undefined,
      ].filter(Boolean),
    },
  };

  if (meta.motion) {
    const dur = n === 13 ? 3 : 2.5;
    shot.motion = {
      durationSeconds: dur,
      renderControlVideo: true,
      keyframes: [
        {
          timeSeconds: 0,
          staging: subjects
            .filter((s) => s.startsWith('joseph') || s === 'hand_monster')
            .map((s) => ({
              subject: s,
              ...(s.startsWith('joseph') && meta.pose ? { posePreset: meta.pose } : {}),
              visible: true,
            })),
        },
        {
          timeSeconds: dur,
          staging: subjects
            .filter((s) => s.startsWith('joseph') || s === 'hand_monster')
            .map((s) => ({
              subject: s,
              ...(s.startsWith('joseph') ? { posePreset: meta.pose || 'standing-alert' } : {}),
              visible: true,
            })),
        },
      ],
    };
  }

  shots.push(shot);
}

const manifest = {
  version: 1,
  project: {
    name: "What I'm Fighting For",
    description:
      'Full music-video graybox previs with imported Joseph saved-rig cast (intact/amputated/prosthetic), spider and hand-monster composition proxies, motion-control on chase/combat beats. Exact shot numbers 01–31.',
    aspectRatio: '16:9',
    frameRate: 24,
  },
  locations: [
    { id: 'ruins', name: 'Roman Ruins', template: 'ruins', description: 'Shots 01–09, 14' },
    { id: 'corridor', name: 'Roman Ruins Corridor', template: 'corridor', description: 'Shots 10–13 chase' },
    { id: 'armory', name: 'Armory', template: 'armory', description: 'Shots 15–31' },
  ],
  cast,
  props,
  shots,
};

writeFileSync('artifacts/full/full.manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
console.log('wrote artifacts/full/full.manifest.json shots=', shots.length);
