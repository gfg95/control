/**
 * Chargement et typage de l'API IFrame de TabSoundEngine (iframe_api.js).
 * Référence : « TabSoundEngine — Mode d'emploi de l'API IFrame ».
 */

/** Origine du moteur. Surchargée par VITE_TSE_ENGINE_URL (moteur local, préproduction). */
export const ENGINE_URL = (
	(import.meta.env.VITE_TSE_ENGINE_URL as string | undefined) || 'https://engine.tabmidi.app'
).replace(/\/+$/, '');

export type TseChannel = 'omni' | number;

export interface TseState {
	audio: 'suspended' | 'running';
	/** true : l'utilisateur doit cliquer sur « Démarrer l'audio » dans l'iframe. */
	needsGesture: boolean;
	synth: string | null;
	channel: TseChannel | null;
	synths: string[];
}

export interface TsePlayerOptions {
	synth?: string;
	channel?: TseChannel;
	width?: number | string;
	height?: number | string;
	autostart?: boolean;
	engineUrl?: string;
	title?: string;
	events?: {
		onReady?: (state: TseState) => void;
		onStateChange?: (state: TseState) => void;
		onMidi?: (bytes: number[]) => void;
		onError?: (error: { message: string }) => void;
	};
}

export interface TsePlayer {
	noteOn(note: number, velocity?: number, channel?: number): TsePlayer;
	noteOff(note: number, channel?: number): TsePlayer;
	controlChange(controller: number, value: number, channel?: number): TsePlayer;
	programChange(program: number, channel?: number): TsePlayer;
	pitchBend(value14: number, channel?: number): TsePlayer;
	sendMidi(bytes: number[] | Uint8Array): TsePlayer;
	start(): TsePlayer;
	panic(): TsePlayer;
	setChannel(channel: TseChannel): TsePlayer;
	setSynth(id: string): TsePlayer;
	getState(): TseState;
	getIframe(): HTMLIFrameElement;
	destroy(): void;
}

export interface TseApi {
	Player: new (target: Element | string, options?: TsePlayerOptions) => TsePlayer;
}

declare global {
	interface Window {
		TSE?: TseApi;
	}
}

let pending: Promise<TseApi> | null = null;

/** Charge iframe_api.js une seule fois, à la demande. */
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
