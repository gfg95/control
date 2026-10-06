/** Constantes MIDI et tables de CC des synthés du rack TabSoundEngine (GM, FM, SUB). */

export const KEY_COUNT = 25;
/** Do 3 : le clavier couvre Do 3 – Do 5 par défaut, do central (60) au milieu. */
export const DEFAULT_BASE = 48;
export const MIN_BASE = 0;
/** Do 7 : la touche la plus haute vaut alors 120. */
export const MAX_BASE = 96;
export const KNOB_COUNT = 8;

const NOTE_NAMES = ['Do', 'Do♯', 'Ré', 'Ré♯', 'Mi', 'Fa', 'Fa♯', 'Sol', 'Sol♯', 'La', 'La♯', 'Si'];

/** Nom français d'une note, avec la convention do 4 = 60. */
export function noteName(note: number): string {
	return `${NOTE_NAMES[note % 12]} ${Math.floor(note / 12) - 1}`;
}

export function clamp7(value: number): number {
	return Math.min(127, Math.max(0, Math.round(value)));
}

// ── Tables de CC ────────────────────────────────────────────────────────────

type Unit = 'db' | 'time' | 'percent' | 'number' | 'hz' | 'octaves';

/** Plage réelle balayée par le CC, de 0 à 127. */
export interface Scale {
	min: number;
	max: number;
	curve: 'lin' | 'exp';
	unit: Unit;
	digits: number;
}

/** Une position d'un CC découpé en bandes : toute valeur de la bande la choisit. */
export interface Choice {
	label: string;
	from: number;
	to: number;
	/** Valeur à envoyer : le milieu de la bande. */
	send: number;
}

export interface Param {
	cc: number;
	name: string;
	/** Colonne « Défaut (MIDI) » : valeur du potentiomètre au départ. */
	initial: number;
	scale?: Scale;
	choices?: Choice[];
	/** Ce CC règle le même paramètre que cet autre CC (molette de modulation). */
	alias?: number;
	/** Panoramique : 64 au centre. */
	pan?: true;
	/** Précision affichée quand on assigne ce CC. */
	note?: string;
}

export interface SynthTable {
	name: string;
	params: Param[];
	/** CC des 8 potentiomètres d'usine. */
	knobs: number[];
	/** Le synthé répond aux Program Change. */
	program: boolean;
	/** Le synthé attend la SoundFont pour jouer. */
	soundfont?: true;
	/** Canal sur lequel le synthé joue la batterie. */
	drumChannel?: number;
}

const VOLUME: Scale = { min: -40, max: 0, curve: 'lin', unit: 'db', digits: 1 };
const ATTACK: Scale = { min: 0.001, max: 2, curve: 'exp', unit: 'time', digits: 2 };
const DECAY: Scale = { min: 0.01, max: 2, curve: 'exp', unit: 'time', digits: 2 };
const RELEASE: Scale = { min: 0.01, max: 4, curve: 'exp', unit: 'time', digits: 2 };
const UNIT: Scale = { min: 0, max: 1, curve: 'lin', unit: 'percent', digits: 0 };
const FM_INDEX: Scale = { min: 0, max: 25, curve: 'lin', unit: 'number', digits: 1 };
const CUTOFF: Scale = { min: 40, max: 12_000, curve: 'exp', unit: 'hz', digits: 0 };

/** CC 70 du SUB : cinq bandes, on envoie la valeur du milieu. */
const WAVEFORMS: Choice[] = [
	{ label: 'Saw', from: 0, to: 25, send: 13 },
	{ label: 'Square', from: 26, to: 51, send: 38 },
	{ label: 'Triangle', from: 52, to: 76, send: 64 },
	{ label: 'Supersaw', from: 77, to: 102, send: 90 },
	{ label: 'PWM', from: 103, to: 127, send: 115 }
];

function toggle(off: string, on: string): Choice[] {
	return [
		{ label: off, from: 0, to: 63, send: 0 },
		{ label: on, from: 64, to: 127, send: 127 }
	];
}

/** Potentiomètre laissé libre : aucun synthé du rack ne lit ces numéros. */
const FREE_CC = [12, 13];

const TABLES = new Map<string, SynthTable>([
	[
		'gm',
		{
			name: 'General MIDI',
			program: true,
			soundfont: true,
			drumChannel: 10,
			params: [
				{ cc: 7, name: 'Volume', initial: 100 },
				{ cc: 11, name: 'Expression', initial: 127 },
				{ cc: 10, name: 'Pan', initial: 64, pan: true },
				{ cc: 91, name: 'Reverb', initial: 40 },
				{ cc: 1, name: 'Modulation', initial: 0 },
				{ cc: 64, name: 'Sustain', initial: 0, choices: toggle('relâchée', 'enfoncée') },
				{
					cc: 0,
					name: 'Banque',
					initial: 0,
					choices: toggle('mélodique', 'batterie'),
					note: 'La banque prend effet au Program Change suivant : le contrôleur le renvoie aussitôt.'
				}
			],
			knobs: [7, 11, 10, 91, 1, 64, 0, FREE_CC[0]]
		}
	],
	[
		'fm',
		{
			name: 'FM',
			program: false,
			params: [
				{ cc: 7, name: 'Volume', initial: 102, scale: VOLUME },
				{
					cc: 74,
					name: 'Harmonicity',
					initial: 45,
					scale: { min: 0.25, max: 8, curve: 'lin', unit: 'number', digits: 2 }
				},
				{ cc: 71, name: 'FM index', initial: 51, scale: FM_INDEX },
				{ cc: 73, name: 'Attack', initial: 38, scale: ATTACK },
				{ cc: 75, name: 'Decay', initial: 72, scale: DECAY },
				{ cc: 72, name: 'Release', initial: 93, scale: RELEASE },
				{ cc: 91, name: 'Reverb', initial: 19, scale: UNIT },
				// La molette de modulation règle le même paramètre que le CC 71.
				{ cc: 1, name: 'Modulation', initial: 51, scale: FM_INDEX, alias: 71 }
			],
			knobs: [7, 74, 71, 73, 75, 72, 91, 1]
		}
	],
	[
		'sub',
		{
			name: 'Soustractif',
			program: false,
			params: [
				{ cc: 70, name: 'Onde', initial: 13, choices: WAVEFORMS },
				{ cc: 74, name: 'Coupure', initial: 67, scale: CUTOFF },
				{
					cc: 71,
					name: 'Résonance',
					initial: 21,
					scale: { min: 0, max: 12, curve: 'lin', unit: 'number', digits: 1 }
				},
				{
					cc: 76,
					name: 'Env. filtre',
					initial: 64,
					scale: { min: 0, max: 6, curve: 'lin', unit: 'octaves', digits: 1 }
				},
				{ cc: 73, name: 'Attack', initial: 38, scale: ATTACK },
				{ cc: 75, name: 'Decay', initial: 82, scale: DECAY },
				{ cc: 79, name: 'Sustain', initial: 64, scale: UNIT },
				{ cc: 72, name: 'Release', initial: 78, scale: RELEASE },
				{ cc: 7, name: 'Volume', initial: 102, scale: VOLUME },
				{ cc: 91, name: 'Reverb', initial: 15, scale: UNIT },
				// La molette de modulation règle le même paramètre que le CC 74.
				{ cc: 1, name: 'Modulation', initial: 67, scale: CUTOFF, alias: 74 }
			],
			knobs: [70, 74, 71, 76, 73, 75, 79, 72]
		}
	]
]);

/** Synthés dont le contrôleur connaît la table, qu'ils soient présents ou non dans le moteur. */
export const KNOWN_SYNTHS: readonly string[] = [...TABLES.keys()];

export function synthTable(synth: string): SynthTable | undefined {
	return TABLES.get(synth);
}

/** Étiquette courte d'un synthé, tirée de son identifiant : « GM », « FM », « SUB ». */
export function synthLabel(synth: string): string {
	return synth.toUpperCase();
}

/** Paramètre réglé par ce CC sur ce synthé ; rien si le synthé ignore le CC. */
export function param(synth: string, cc: number): Param | undefined {
	return TABLES.get(synth)?.params.find((p) => p.cc === cc);
}

/** CC de référence du paramètre : deux CC alias l'un de l'autre partagent la même valeur. */
export function canonical(synth: string, cc: number): number {
	return param(synth, cc)?.alias ?? cc;
}

/** Valeur de départ d'un potentiomètre assigné à ce CC. */
export function initialValue(synth: string, cc: number): number {
	return param(synth, cc)?.initial ?? 0;
}

/** Nom affiché pour un numéro de CC quelconque. */
export function ccName(synth: string, cc: number): string {
	return param(synth, cc)?.name ?? `CC ${cc}`;
}

/** Les 8 CC d'usine d'un synthé ; pour un synthé sans table, les contrôleurs MIDI courants. */
export function defaultLayout(synth: string): number[] {
	return [...(TABLES.get(synth)?.knobs ?? [7, 10, 11, 91, 1, 64, ...FREE_CC])];
}

// ── Valeurs ─────────────────────────────────────────────────────────────────

/** Position choisie par cette valeur dans un CC découpé en bandes. */
export function choiceIndex(choices: Choice[], value: number): number {
	const index = choices.findIndex((c) => value >= c.from && value <= c.to);
	return index < 0 ? 0 : index;
}

/** Valeur réellement envoyée : pour un CC à bandes, le milieu de la bande visée. */
export function snap(p: Param | undefined, value: number): number {
	const v = clamp7(value);
	return p?.choices ? p.choices[choiceIndex(p.choices, v)].send : v;
}

export function ccToReal(scale: Scale, value: number): number {
	const t = value / 127;
	return scale.curve === 'exp'
		? scale.min * Math.pow(scale.max / scale.min, t)
		: scale.min + (scale.max - scale.min) * t;
}

export function realToCc(scale: Scale, real: number): number {
	const t =
		scale.curve === 'exp'
			? Math.log(real / scale.min) / Math.log(scale.max / scale.min)
			: (real - scale.min) / (scale.max - scale.min);
	return clamp7(127 * t);
}

function fr(value: number, digits: number): string {
	return value
		.toLocaleString('fr-FR', { minimumFractionDigits: digits, maximumFractionDigits: digits })
		.replace('-', '−');
}

/**
 * Valeur lisible du paramètre : « −8,0 dB », « 200 ms », « 1,2 kHz », « Supersaw ».
 * Chaîne vide quand la table ne donne que la valeur MIDI.
 */
export function formatValue(p: Param, value: number): string {
	if (p.choices) return p.choices[choiceIndex(p.choices, value)].label;
	if (p.pan) return value === 64 ? 'centre' : value < 64 ? `G ${64 - value}` : `D ${value - 64}`;
	if (!p.scale) return '';

	const real = ccToReal(p.scale, value);
	const { unit, digits } = p.scale;
	switch (unit) {
		case 'db':
			return value === 0 ? 'muet' : `${fr(real, digits)} dB`;
		case 'time':
			return real < 1 ? `${fr(real * 1000, 0)} ms` : `${fr(real, digits)} s`;
		case 'percent':
			return `${fr(real * 100, 0)} %`;
		case 'hz':
			return real < 1000 ? `${fr(real, 0)} Hz` : `${fr(real / 1000, 1)} kHz`;
		case 'octaves':
			return `${fr(real, digits)} oct.`;
		default:
			return fr(real, digits);
	}
}

/**
 * Touches du clavier d'ordinateur, par position physique (event.code),
 * donc identiques en AZERTY et en QWERTY. Rangée du bas : première octave ;
 * rangée du haut : seconde octave jusqu'au do final.
 */
export const COMPUTER_KEYS: Record<string, number> = {
	KeyZ: 0,
	KeyS: 1,
	KeyX: 2,
	KeyD: 3,
	KeyC: 4,
	KeyV: 5,
	KeyG: 6,
	KeyB: 7,
	KeyH: 8,
	KeyN: 9,
	KeyJ: 10,
	KeyM: 11,
	KeyQ: 12,
	Digit2: 13,
	KeyW: 14,
	Digit3: 15,
	KeyE: 16,
	KeyR: 17,
	Digit5: 18,
	KeyT: 19,
	Digit6: 20,
	KeyY: 21,
	Digit7: 22,
	KeyU: 23,
	KeyI: 24
};