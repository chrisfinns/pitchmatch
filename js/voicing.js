// EarMaster 7 piano voicing: the tone filter, level and volume envelope that
// EarMaster's FluidSynth applies on top of its piano recordings
// ("FluidR3 GM EarMaster.sf2", bank 0 program 0, velocity layer 71-80).
// Values from earmaster-piano-voicing.json; see PITCHMATCH_PIANO_VOICING.md.
// Pure: no DOM, no audio.

export const VELOCITY = 80; // inside the 71-80 layer the recordings were rendered with
export const ATTACK = 0.001; // s, linear
export const DECAY_DB_PER_S = 0.9449; // after the hold
export const SUSTAIN_DB = -38.4;
export const RELEASE_DB_PER_S = 53.32; // 96 dB in 1.8 s
export const FLOOR_DB = -96;
export const FILTER_Q_DB = -3.01; // Web Audio lowpass Q is in dB; -3.01 = flat, no resonance
const OPEN_CENTS = 13500; // FluidSynth treats a cutoff at or above this as "no filter"

/** Per key, C2-C6. lowpass: Hz, or null for no tone filter. level: dB. hold: s. */
export const KEYS = [
  {"midi":36,"file":"036_C2.wav","lowpass":770.1,"level":-7.2,"hold":9.747},
  {"midi":37,"file":"037_Cs2.wav","lowpass":770.1,"level":-7.2,"hold":9.747},
  {"midi":38,"file":"038_D2.wav","lowpass":680.2,"level":-7.2,"hold":9.747},
  {"midi":39,"file":"039_Ds2.wav","lowpass":680.2,"level":-7.2,"hold":9.747},
  {"midi":40,"file":"040_E2.wav","lowpass":680.2,"level":-7.2,"hold":9.747},
  {"midi":41,"file":"041_F2.wav","lowpass":680.2,"level":-7.2,"hold":9.747},
  {"midi":42,"file":"042_Fs2.wav","lowpass":1200.1,"level":-7.6,"hold":9.652},
  {"midi":43,"file":"043_G2.wav","lowpass":1200.1,"level":-7.6,"hold":9.652},
  {"midi":44,"file":"044_Gs2.wav","lowpass":1200.1,"level":-7.6,"hold":9.652},
  {"midi":45,"file":"045_A2.wav","lowpass":1200.1,"level":-7.6,"hold":9.652},
  {"midi":46,"file":"046_As2.wav","lowpass":1299.6,"level":-7.6,"hold":5.321},
  {"midi":47,"file":"047_B2.wav","lowpass":1299.6,"level":-7.6,"hold":5.321},
  {"midi":48,"file":"048_C3.wav","lowpass":1299.6,"level":-7.6,"hold":5.321},
  {"midi":49,"file":"049_Cs3.wav","lowpass":1299.6,"level":-7.6,"hold":5.321},
  {"midi":50,"file":"050_D3.wav","lowpass":1299.6,"level":-7.6,"hold":5.321},
  {"midi":51,"file":"051_Ds3.wav","lowpass":1800.1,"level":-7.6,"hold":7.84},
  {"midi":52,"file":"052_E3.wav","lowpass":1800.1,"level":-7.6,"hold":7.84},
  {"midi":53,"file":"053_F3.wav","lowpass":1800.1,"level":-7.6,"hold":7.84},
  {"midi":54,"file":"054_Fs3.wav","lowpass":1999.7,"level":-7.2,"hold":9.27},
  {"midi":55,"file":"055_G3.wav","lowpass":1999.7,"level":-7.2,"hold":9.27},
  {"midi":56,"file":"056_Gs3.wav","lowpass":1999.7,"level":-7.2,"hold":9.27},
  {"midi":57,"file":"057_A3.wav","lowpass":1999.7,"level":-7.2,"hold":9.27},
  {"midi":58,"file":"058_As3.wav","lowpass":2999.6,"level":-6.8,"hold":5.589},
  {"midi":59,"file":"059_B3.wav","lowpass":2999.6,"level":-6.8,"hold":5.589},
  {"midi":60,"file":"060_C4.wav","lowpass":2999.6,"level":-6.8,"hold":5.589},
  {"midi":61,"file":"061_Cs4.wav","lowpass":2999.6,"level":-6.8,"hold":5.589},
  {"midi":62,"file":"062_D4.wav","lowpass":2999.6,"level":-6.8,"hold":5.589},
  {"midi":63,"file":"063_Ds4.wav","lowpass":3600.3,"level":-7.2,"hold":5.269},
  {"midi":64,"file":"064_E4.wav","lowpass":3600.3,"level":-7.2,"hold":5.269},
  {"midi":65,"file":"065_F4.wav","lowpass":4200.6,"level":-7.6,"hold":5.051},
  {"midi":66,"file":"066_Fs4.wav","lowpass":4200.6,"level":-7.6,"hold":5.051},
  {"midi":67,"file":"067_G4.wav","lowpass":4200.6,"level":-7.6,"hold":5.051},
  {"midi":68,"file":"068_Gs4.wav","lowpass":4200.6,"level":-7.6,"hold":5.051},
  {"midi":69,"file":"069_A4.wav","lowpass":4200.6,"level":-7.6,"hold":5.051},
  {"midi":70,"file":"070_As4.wav","lowpass":null,"level":-6.4,"hold":3.251},
  {"midi":71,"file":"071_B4.wav","lowpass":null,"level":-6.4,"hold":3.251},
  {"midi":72,"file":"072_C5.wav","lowpass":null,"level":-6.4,"hold":3.251},
  {"midi":73,"file":"073_Cs5.wav","lowpass":null,"level":-6.4,"hold":3.251},
  {"midi":74,"file":"074_D5.wav","lowpass":null,"level":-6.4,"hold":3.251},
  {"midi":75,"file":"075_Ds5.wav","lowpass":null,"level":-6.0,"hold":4.579},
  {"midi":76,"file":"076_E5.wav","lowpass":null,"level":-6.0,"hold":4.579},
  {"midi":77,"file":"077_F5.wav","lowpass":null,"level":-6.0,"hold":4.579},
  {"midi":78,"file":"078_Fs5.wav","lowpass":null,"level":-6.0,"hold":3.819},
  {"midi":79,"file":"079_G5.wav","lowpass":null,"level":-6.0,"hold":3.819},
  {"midi":80,"file":"080_Gs5.wav","lowpass":null,"level":-6.0,"hold":3.819},
  {"midi":81,"file":"081_A5.wav","lowpass":null,"level":-6.0,"hold":3.819},
  {"midi":82,"file":"082_As5.wav","lowpass":null,"level":-6.0,"hold":3.819},
  {"midi":83,"file":"083_B5.wav","lowpass":2400.1,"level":-6.0,"hold":3.51},
  {"midi":84,"file":"084_C6.wav","lowpass":2400.1,"level":-6.0,"hold":3.51},
];
const BY_MIDI = new Map(KEYS.map((k) => [k.midi, k]));
export const voicingFor = (midi) => BY_MIDI.get(midi) || null;

export const dbToGain = (db) => Math.pow(10, db / 20);
const hzToCents = (hz) => 1200 * Math.log2(hz / 8.176);
const centsToHz = (c) => 8.176 * Math.pow(2, c / 1200);

/** Level gain for a key: its own trim times FluidSynth's (velocity/127)^2 curve. */
export const levelGain = (k, velocity = VELOCITY) => dbToGain(k.level) * (velocity / 127) ** 2;

/**
 * Low-pass cutoff in Hz, or null for none. toneFilter off = brightest tone.
 * velToFilter: FluidSynth's default velocity-to-cutoff modulator (velocity 80
 * lowers every cutoff by 888 cents, about 3/4 of an octave, and puts a mild
 * ~12 kHz roll-off on the unfiltered keys).
 */
export function cutoffHz(k, { toneFilter = true, velToFilter = true, velocity = VELOCITY } = {}) {
  if (!toneFilter) return null;
  let cents = k.lowpass == null ? OPEN_CENTS : hzToCents(k.lowpass);
  if (velToFilter && velocity >= 64) cents += (-2400 * (127 - velocity)) / 127;
  return cents >= OPEN_CENTS ? null : centsToHz(cents);
}

/** Envelope level in dB (<= 0) at t seconds after note-on, before release. */
export function envDbAt(t, hold) {
  const decayStart = ATTACK + hold;
  if (t <= decayStart) return 0;
  return Math.max(SUSTAIN_DB, -(t - decayStart) * DECAY_DB_PER_S);
}

/** Seconds the release takes to fall from `fromDb` to the floor (1.8 s from full level). */
export const releaseTime = (fromDb = 0) => (fromDb - FLOOR_DB) / RELEASE_DB_PER_S;
