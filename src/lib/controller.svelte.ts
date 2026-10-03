import {
	DEFAULT_BASE,
	MAX_BASE,
	MIN_BASE,
	clamp7,
	defaultKnobs,
	defaultValue,
	type KnobSetting
} from './midi.ts';
import { ENGINE_URL, loadTse, type TsePlayer, type TseState } from './tse.ts';

const STORAGE_KEY = 'control:v1';
const VELOCITY = 100;
/** L'API ne signale pas une iframe qui ne se charge pas : on se donne ce délai. */
const READY_TIMEOUT_MS = 10_000;

/**
 * État du contrôleur (canal, octave, programme, potentiomètres, notes tenues)
 * et pont vers le Player TabSoundEngine.
 */
export class Controller {
	/** Canal d'émission, 1 à 16. */
	channel = $state(1);
	/** Note MIDI de la touche la plus grave. */
	base = $state(DEFAULT_BASE);
	/** Dernier programme émis, 0 à 127 (valeur de l'octet MIDI). */
	program = $state(0);
	knobs = $state<KnobSetting[]>(defaultKnobs());
	/** Nombre d'appuis en cours par note (doigt + touche d'ordinateur peuvent se cumuler). */
	held = $state<number[]>(new Array(128).fill(0));
	/** Dernier potentiomètre manipulé, pour l'afficheur. */
	touched = $state<number | null>(null);

	link = $state<'loading' | 'ready' | 'error'>('loading');
	engine = $state<TseState | null>(null);
	restored = $state(false);

	#player: TsePlayer | null = null;
	#host: HTMLElement | null = null;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#attempt = 0;

	get running(): boolean {
		return this.engine?.audio === 'running';
	}

	/** Le navigateur a refusé le démarrage : il faut cliquer dans l'iframe. */
	get needsGesture(): boolean {
		return !!this.engine?.needsGesture && !this.running;
	}

	// ── Liaison avec le synthé ────────────────────────────────────────────────

	async attach(host: HTMLElement): Promise<void> {
		this.#host = host;
		const attempt = ++this.#attempt;
		this.link = 'loading';
		this.engine = null;

		clearTimeout(this.#timer);
		this.#timer = setTimeout(() => {
			if (attempt === this.#attempt && this.link !== 'ready') this.link = 'error';
		}, READY_TIMEOUT_MS);

		try {
			const TSE = await loadTse();
			if (attempt !== this.#attempt) return;

			this.#player = new TSE.Player(host, {
				synth: 'fm',
				// Le synthé écoute tout : le canal se choisit côté contrôleur.
				channel: 'omni',
				width: '100%',
				height: '100%',
				// Démarrage piloté ici, depuis un vrai geste : sans cela, l'envoi des CC
				// au chargement provoquerait une tentative vouée à l'échec.
				autostart: false,
				engineUrl: ENGINE_URL,
				title: 'TabSoundEngine, synthé FM',
				events: {
					onReady: (state) => {
						if (attempt !== this.#attempt) return;
						clearTimeout(this.#timer);
						this.link = 'ready';
						this.#apply(state);
						// Le programme d'abord : un changement de programme peut réinitialiser le timbre.
						// Les CC sont mémorisés par le moteur et appliqués au démarrage audio.
						this.#player?.programChange(this.program, this.channel);
						this.#sendKnobs();
					},
					onStateChange: (state) => {
						if (attempt === this.#attempt) this.#apply(state);
					},
					onError: (error) => console.warn('TabSoundEngine :', error.message)
				}
			});
		} catch (error) {
			console.warn('TabSoundEngine :', error);
			if (attempt === this.#attempt) {
				clearTimeout(this.#timer);
				this.link = 'error';
			}
		}
	}

	retry(): void {
		this.#player?.destroy();
		this.#player = null;
		if (this.#host) void this.attach(this.#host);
	}

	destroy(): void {
		this.#attempt++;
		clearTimeout(this.#timer);
		this.#player?.destroy();
		this.#player = null;
	}

	#apply(state: TseState): void {
		const wasRunning = this.running;
		this.engine = { ...state };
		// Les notes envoyées avant « running » sont perdues : on rejoue celles encore tenues.
		if (!wasRunning && this.running) {
			this.held.forEach((count, note) => {
				if (count > 0) this.#player?.noteOn(note, VELOCITY, this.channel);
			});
		}
	}

	#sendKnobs(): void {
		for (const knob of this.knobs) {
			this.#player?.controlChange(knob.cc, knob.value, this.channel);
		}
	}

	/** Demande le démarrage audio. À appeler depuis un geste utilisateur. */
	start(): void {
		if (this.link === 'ready' && !this.running) this.#player?.start();
	}

	// ── Notes ─────────────────────────────────────────────────────────────────

	noteOn(note: number): void {
		if (note < 0 || note > 127) return;
		this.held[note] += 1;
		if (this.held[note] === 1 && this.running) {
			this.#player?.noteOn(note, VELOCITY, this.channel);
		}
	}

	noteOff(note: number): void {
		if (note < 0 || note > 127 || this.held[note] <= 0) return;
		this.held[note] -= 1;
		if (this.held[note] === 0 && this.running) {
			this.#player?.noteOff(note, this.channel);
		}
	}

	/** Relâche tout ce que le contrôleur tient (changement de canal, d'octave, perte du focus). */
	releaseAll(): void {
		this.held.forEach((count, note) => {
			if (count > 0) {
				this.held[note] = 0;
				if (this.running) this.#player?.noteOff(note, this.channel);
			}
		});
	}

	panic(): void {
		this.held.fill(0);
		this.#player?.panic();
	}

	// ── Réglages ──────────────────────────────────────────────────────────────

	setChannel(channel: number): void {
		const next = Math.min(16, Math.max(1, Math.round(channel)));
		if (next === this.channel) return;
		this.releaseAll();
		this.channel = next;
	}

	get canShiftDown(): boolean {
		return this.base - 12 >= MIN_BASE;
	}

	get canShiftUp(): boolean {
		return this.base + 12 <= MAX_BASE;
	}

	shiftOctave(direction: -1 | 1): void {
		const next = this.base + 12 * direction;
		if (next < MIN_BASE || next > MAX_BASE) return;
		this.releaseAll();
		this.base = next;
	}

	/** Émet un Program Change sur le canal courant, même si le numéro n'a pas changé. */
	setProgram(program: number): void {
		this.program = clamp7(program);
		this.#player?.programChange(this.program, this.channel);
	}

	setKnob(index: number, value: number): void {
		const knob = this.knobs[index];
		const next = clamp7(value);
		this.touched = index;
		if (!knob || next === knob.value) return;
		knob.value = next;
		this.#player?.controlChange(knob.cc, next, this.channel);
	}

	/** Assigne un potentiomètre à un CC et envoie sa valeur, pour que l'écran et le son concordent. */
	assign(index: number, cc: number): void {
		const knob = this.knobs[index];
		const next = clamp7(cc);
		if (!knob || next === knob.cc) return;
		knob.cc = next;
		knob.value = defaultValue(next) ?? knob.value;
		this.touched = index;
		this.#player?.controlChange(knob.cc, knob.value, this.channel);
	}

	// ── Mémoire locale ────────────────────────────────────────────────────────

	restore(): void {
		try {
			const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
			if (saved && typeof saved === 'object') {
				if (Number.isInteger(saved.channel) && saved.channel >= 1 && saved.channel <= 16) {
					this.channel = saved.channel;
				}
				if (
					Number.isInteger(saved.base) &&
					saved.base >= MIN_BASE &&
					saved.base <= MAX_BASE &&
					saved.base % 12 === 0
				) {
					this.base = saved.base;
				}
				if (Number.isInteger(saved.program) && saved.program >= 0 && saved.program <= 127) {
					this.program = saved.program;
				}
				if (Array.isArray(saved.knobs) && saved.knobs.length === this.knobs.length) {
					const valid = saved.knobs.every(
						(k: unknown) =>
							typeof k === 'object' &&
							k !== null &&
							Number.isInteger((k as KnobSetting).cc) &&
							Number.isInteger((k as KnobSetting).value)
					);
					if (valid) {
						this.knobs = saved.knobs.map((k: KnobSetting) => ({
							cc: clamp7(k.cc),
							value: clamp7(k.value)
						}));
					}
				}
			}
		} catch {
			// Stockage indisponible (navigation privée, données bloquées) : réglages d'usine.
		}
		this.restored = true;
	}

	/** À appeler dans un $effect : lit l'état, donc se relance à chaque changement. */
	save(): void {
		const snapshot = JSON.stringify({
			channel: this.channel,
			base: this.base,
			program: this.program,
			knobs: this.knobs
		});
		if (!this.restored) return;
		try {
			localStorage.setItem(STORAGE_KEY, snapshot);
		} catch {
			// Voir restore().
		}
	}
}
