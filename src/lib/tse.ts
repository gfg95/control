/**
 * Chargement et typage de l'API IFrame de TabSoundEngine (iframe_api.js), protocole 2.
 * Référence : « Spécification : contrôleur MIDI pour TabSoundEngine en iframe ».
 * Le protocole 2 ajoute la liste des instruments du GM (onPresets, getPresets, selectPreset).
 */

/** Origine du moteur. Surchargée par VITE_TSE_ENGINE_URL (moteur local, préproduction). */
export const ENGINE_URL = (
	(import.meta.env.VITE_TSE_ENGINE_URL as string | undefined) || 'https://engine.tabmidi.app'
).replace(/\/+$/, '');

export type TseChannel = 'omni' | number;

export interface TseSynth {
	name: string;
	/** Canal écouté. */
	channel: TseChannel;
}

export interface TseSoundfont {
	state: 'idle' | 'loading' | 'ready' | 'error';
	/** 0 à 1. */
	progress: number;
	name: string | null;
	error: string | null;
}

export interface TseState {
	audio: 'suspended' | 'running';
	/** true : l'utilisateur doit cliquer sur « Démarrer l'audio » dans l'iframe. */
	needsGesture: boolean;
	/** Synthés présents dans le rack, par identifiant (`gm`, `fm`, `sub`…). */
	synths: Record<string, TseSynth>;
	/** SoundFont du GM ; null tant que l'iframe n'a rien annoncé. */
	soundfont: TseSoundfont | null;
}

/** Un instrument de la SoundFont du GM. */
export interface TsePreset {
	name: string;
	/** 0 pour le jeu General MIDI, 128 pour les kits de batterie. */
	bank: number;
	/** 0 à 127. */
	program: number;
}

/** Banque des kits de batterie dans la liste, et le Bank Select (CC 0) qui la choisit. */
export const DRUM_BANK = 128;
export const DRUM_BANK_MSB = 127;

export interface TsePresets {
	/** Synthé auquel la liste appartient : `gm`. */
	synth: string;
	soundfont: string | null;
	presets: TsePreset[];
}

export interface TseError {
	/** `protocol_mismatch` : le script et l'iframe ne sont pas de la même version. */
	code?: string;
	message: string;
}

export interface TsePlayerOptions {
	/** Canal écouté par synthé ; un synthé absent garde son canal par défaut. */
	channels?: Record<string, TseChannel>;
	width?: number | string;
	height?: number | string;
	autostart?: boolean;
	engineUrl?: string;
	title?: string;
	events?: {
		onReady?: (state: unknown) => void;
		onStateChange?: (state: unknown) => void;
		/** Instruments du GM, dès que la SoundFont est chargée. Jamais avant onReady. */
		onPresets?: (info: unknown) => void;
		onMidi?: (bytes: number[]) => void;
		onError?: (error: TseError) => void;
	};
}

/**
 * Toutes les méthodes MIDI acceptent un dernier argument `time` : un temps absolu en
 * millisecondes sur l'horloge de `TSE.now()`. Sans lui, le message est joué dès réception,
 * ce qui convient au jeu en direct.
 */
export interface TsePlayer {
	noteOn(note: number, velocity?: number, channel?: number, time?: number): TsePlayer;
	noteOff(note: number, channel?: number, time?: number): TsePlayer;
	playNote(
		note: number,
		options?: { velocity?: number; channel?: number; time?: number; duration?: number }
	): TsePlayer;
	controlChange(controller: number, value: number, channel?: number, time?: number): TsePlayer;
	programChange(program: number, channel?: number, time?: number): TsePlayer;
	pitchBend(value14: number, channel?: number, time?: number): TsePlayer;
	sendMidi(bytes: number[] | Uint8Array, time?: number): TsePlayer;
	/** Bank Select (CC 0) puis Program Change. Absent d'un script antérieur au protocole 2. */
	selectPreset?(preset: { bank: number; program: number }, channel?: number, time?: number): TsePlayer;
	/** Résolue quand la SoundFont est chargée ; rejetée (`soundfont_error`) si elle échoue. */
	getPresets?(): Promise<TsePreset[]>;
	start(): TsePlayer;
	/** Annule les messages horodatés en attente, puis coupe toutes les notes. */
	panic(): TsePlayer;
	/** Change le canal écouté par un synthé ; coupe ses notes en cours. */
	setChannel(synth: string, channel: TseChannel): TsePlayer;
	getState(): unknown;
	destroy(): void;
}

export interface TseApi {
	Player: new (target: Element | string, options?: TsePlayerOptions) => TsePlayer;
	/** Horloge commune à la page hôte et à l'iframe, en millisecondes. */
	now(): number;
}

declare global {
	interface Window {
		TSE?: TseApi;
	}
}

const SYNTH_ID = /^[a-z][a-z0-9_-]{0,31}$/i;

/** Identifiant de synthé utilisable comme clé d'objet. */
export function isSynthId(id: unknown): id is string {
	return typeof id === 'string' && SYNTH_ID.test(id) && !(id in Object.prototype);
}

/** `'omni'` ou un canal de 1 à 16 ; rien pour toute autre valeur. */
export function parseChannel(value: unknown): TseChannel | undefined {
	if (value === 'omni') return 'omni';
	return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 16
		? value
		: undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Met l'état reçu de l'iframe dans une forme sûre : le contrôleur construit sa liste de
 * cibles à partir de `synths`, sans supposer quels synthés le moteur chargé connaît.
 */
export function normalizeState(raw: unknown): TseState {
	const state = isRecord(raw) ? raw : {};

	const synths: Record<string, TseSynth> = {};
	if (isRecord(state.synths)) {
		for (const [id, value] of Object.entries(state.synths)) {
			if (!isSynthId(id) || !isRecord(value)) continue;
			synths[id] = {
				name: typeof value.name === 'string' && value.name ? value.name : id,
				channel: parseChannel(value.channel) ?? 'omni'
			};
		}
	}

	let soundfont: TseSoundfont | null = null;
	if (isRecord(state.soundfont)) {
		const sf = state.soundfont;
		const progress = typeof sf.progress === 'number' && Number.isFinite(sf.progress) ? sf.progress : 0;
		soundfont = {
			state:
				sf.state === 'loading' || sf.state === 'ready' || sf.state === 'error' ? sf.state : 'idle',
			progress: Math.min(1, Math.max(0, progress)),
			name: typeof sf.name === 'string' ? sf.name : null,
			error: typeof sf.error === 'string' && sf.error ? sf.error : null
		};
	}

	return {
		audio: state.audio === 'running' ? 'running' : 'suspended',
		needsGesture: state.needsGesture === true,
		synths,
		soundfont
	};
}

/** Bank Select à envoyer pour la banque d'un instrument de la liste. */
export function bankSelect(bank: number): number {
	return bank >= DRUM_BANK ? DRUM_BANK_MSB : Math.max(0, Math.round(bank));
}

/** Banque de la liste que choisit un Bank Select. */
export function bankOf(msb: number): number {
	return msb === DRUM_BANK_MSB ? DRUM_BANK : msb;
}

function isInt(value: unknown, min: number, max: number): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/** Met la liste reçue par onPresets dans une forme sûre, triée par banque puis par programme. */
export function normalizePresets(raw: unknown): TsePresets | null {
	if (!isRecord(raw) || !isSynthId(raw.synth) || !Array.isArray(raw.presets)) return null;

	const presets: TsePreset[] = [];
	const seen = new Set<number>();
	for (const value of raw.presets.slice(0, 4096)) {
		if (!isRecord(value) || !isInt(value.bank, 0, DRUM_BANK) || !isInt(value.program, 0, 127)) continue;
		// Bank Select + Program Change ne désignent qu'un instrument : le premier de la liste.
		const key = value.bank * 128 + value.program;
		if (seen.has(key)) continue;
		seen.add(key);
		const name = typeof value.name === 'string' ? value.name.trim() : '';
		presets.push({ name: name || `Programme ${value.program}`, bank: value.bank, program: value.program });
	}
	presets.sort((a, b) => a.bank - b.bank || a.program - b.program);

	return {
		synth: raw.synth,
		soundfont: typeof raw.soundfont === 'string' ? raw.soundfont : null,
		presets
	};
}

let pending: Promise<TseApi> | null = null;

/**
 * Charge iframe_api.js une seule fois, à la demande, toujours depuis le moteur :
 * le script et la page /embed doivent être de la même version.
 */
export function loadTse(): Promise<TseApi> {
	if (window.TSE?.Player) return Promise.resolve(window.TSE);

	pending ??= new Promise<TseApi>((resolve, reject) => {
		const script = document.createElement('script');
		script.src = `${ENGINE_URL}/iframe_api.js`;
		script.onload = () => {
			if (window.TSE?.Player) resolve(window.TSE);
			else fail(new Error('iframe_api.js chargé, mais TSE.Player est absent'));
		};
		script.onerror = () => fail(new Error('iframe_api.js introuvable'));

		// Un échec ne doit pas empêcher un nouvel essai.
		function fail(error: Error) {
			pending = null;
			script.remove();
			reject(error);
		}

		document.head.appendChild(script);
	});

	return pending;
}