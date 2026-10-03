/** Constantes MIDI et table des paramètres du synthé FM de TabSoundEngine. */

export const KEY_COUNT = 25;
/** Do 3 : le clavier couvre Do 3 – Do 5 par défaut, do central (60) au milieu. */
export const DEFAULT_BASE = 48;
export const MIN_BASE = 0;
/** Do 7 : la touche la plus haute vaut alors 120. */
export const MAX_BASE = 96;

const NOTE_NAMES = ['Do', 'Do♯', 'Ré', 'Ré♯', 'Mi', 'Fa', 'Fa♯', 'Sol', 'Sol♯', 'La', 'La♯', 'Si'];

/** Nom français d'une note, avec la convention do 4 = 60. */
export function noteName(note: number): string {
	return `${NOTE_NAMES[note % 12]} ${Math.floor(note / 12) - 1}`;
}

export function clamp7(value: number): number {
	return Math.min(127, Math.max(0, Math.round(value)));
}

type Unit = 'db' | 'time' | 'percent' | 'number';

export interface FmParam {
	cc: number;
	name: string;
	min: number;
	max: number;
	curve: 'lin' | 'exp';
	unit: Unit;
	digits: number;
	/** Valeur réelle du synthé au chargement. */
	initial: number;
}

/** Les CC compris par le synthé FM (plages et courbes de la documentation). */
export const FM_PARAMS: FmParam[] = [
	{ cc: 7, name: 'Volume', min: -40, max: 0, curve: 'lin', unit: 'db', digits: 1, initial: -8 },
	{ cc: 74, name: 'Harmonicity', min: 0.25, max: 8, curve: 'lin', unit: 'number', digits: 2, initial: 3 },
	{ cc: 71, name: 'FM index', min: 0, max: 25, curve: 'lin', unit: 'number', digits: 1, initial: 10 },
	{ cc: 73, name: 'Attack', min: 0.001, max: 2, curve: 'exp', unit: 'time', digits: 2, initial: 0.01 },
	{ cc: 75, name: 'Decay', min: 0.01, max: 2, curve: 'exp', unit: 'time', digits: 2, initial: 0.2 },
	{ cc: 72, name: 'Release', min: 0.01, max: 4, curve: 'exp', unit: 'time', digits: 2, initial: 0.8 },
	{ cc: 91, name: 'Reverb', min: 0, max: 1, curve: 'lin', unit: 'percent', digits: 0, initial: 0.15 },
	// La molette de modulation pilote le même paramètre que le CC 71.
	{ cc: 1, name: 'Modulation', min: 0, max: 25, curve: 'lin', unit: 'number', digits: 1, initial: 10 }
];

export function fmParam(cc: number): FmParam | undefined {
	return FM_PARAMS.find((p) => p.cc === cc);
}

export function ccToReal(p: FmParam, value: number): number {
	const t = value / 127;
	return p.curve === 'exp' ? p.min * Math.pow(p.max / p.min, t) : p.min + (p.max - p.min) * t;
}

export function realToCc(p: FmParam, real: number): number {
	const t =
		p.curve === 'exp'
			? Math.log(real / p.min) / Math.log(p.max / p.min)
			: (real - p.min) / (p.max - p.min);
	return clamp7(127 * t);
}

function fr(value: number, digits: number): string {
	return value
		.toLocaleString('fr-FR', { minimumFractionDigits: digits, maximumFractionDigits: digits })
		.replace('-', '−');
}

/** Valeur réelle du paramètre, lisible : « −8,0 dB », « 200 ms », « 15 % ». */
export function formatReal(p: FmParam, value: number): string {
	const real = ccToReal(p, value);
	switch (p.unit) {
		case 'db':
			return value === 0 ? 'muet' : `${fr(real, p.digits)} dB`;
		case 'time':
			return real < 1 ? `${fr(real * 1000, 0)} ms` : `${fr(real, p.digits)} s`;
		case 'percent':
			return `${fr(real * 100, 0)} %`;
		default:
			return fr(real, p.digits);
	}
}

/** Nom affiché pour un numéro de CC quelconque. */
export function ccName(cc: number): string {
	return fmParam(cc)?.name ?? `CC ${cc}`;
}

/** Valeur de départ d'un potentiomètre qu'on assigne à ce CC. */
export function defaultValue(cc: number): number | undefined {
	const p = fmParam(cc);
	return p ? realToCc(p, p.initial) : undefined;
}

export interface KnobSetting {
	cc: number;
	value: number;
}

/** Les 8 potentiomètres d'usine : un par paramètre FM, calés sur les valeurs initiales du synthé. */
export function defaultKnobs(): KnobSetting[] {
	return FM_PARAMS.map((p) => ({ cc: p.cc, value: realToCc(p, p.initial) }));
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
