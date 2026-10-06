import {
	DEFAULT_BASE,
	KNOB_COUNT,
	KNOWN_SYNTHS,
	MAX_BASE,
	MIN_BASE,
	canonical,
	clamp7,
	defaultLayout,
	initialValue,
	param,
	snap,
	synthLabel,
	synthTable,
	type Param,
	type SynthTable
} from './midi.ts';
import {
	DRUM_BANK,
	ENGINE_URL,
	bankOf,
	bankSelect,
	isSynthId,
	loadTse,
	normalizePresets,
	normalizeState,
	parseChannel,
	type TseChannel,
	type TseError,
	type TsePlayer,
	type TsePreset,
	type TseSoundfont,
	type TseState
} from './tse.ts';

const STORAGE_KEY = 'control:v2';
/** Réglages de la version à un seul synthé FM, repris une fois. */
const LEGACY_KEY = 'control:v1';
const DEFAULT_TARGET = 'fm';
const VELOCITY = 100;
/** L'API ne signale pas une iframe qui ne se charge pas : on se donne ce délai. */
const READY_TIMEOUT_MS = 10_000;
const ERROR_TTL_MS = 8_000;

export interface KnobView {
	cc: number;
	value: number;
}

/** Un synthé du rack, tel que l'iframe l'annonce. */
export interface Target {
	id: string;
	/** « GM », « FM », « SUB ». */
	label: string;
	name: string;
	/** Canal écouté. */
	channel: TseChannel;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMidi(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 127;
}

/** Entrées d'un objet enregistré dont la clé est un identifiant de synthé valable. */
function bySynth(value: unknown): [string, unknown][] {
	return isRecord(value) ? Object.entries(value).filter(([id]) => isSynthId(id)) : [];
}

/**
 * État du contrôleur (cible, octave, programmes, potentiomètres, notes tenues)
 * et pont vers le Player TabSoundEngine. Le contrôleur n'a aucun moteur audio :
 * tout le son vient de l'iframe, et le canal d'un message choisit le synthé qui le joue.
 */
export class Controller {
	/** Synthé choisi. Il peut manquer dans le moteur chargé : voir `target`. */
	wanted = $state(DEFAULT_TARGET);
	/** Note MIDI de la touche la plus grave. */
	base = $state(DEFAULT_BASE);
	/** Par synthé, les CC assignés aux potentiomètres, quand ils diffèrent de l'usine. */
	layouts = $state<Record<string, number[]>>({});
	/** Par synthé, la dernière valeur réglée pour chaque CC touché (0 à 127). */
	values = $state<Record<string, Record<number, number>>>({});
	/** Par synthé, le dernier programme choisi, 0 à 127 (valeur de l'octet MIDI). */
	programs = $state<Record<string, number>>({});
	/** Nombre d'appuis en cours par note (doigt + touche d'ordinateur peuvent se cumuler). */
	held = $state<number[]>(new Array(128).fill(0));
	/** Dernier potentiomètre manipulé, pour l'afficheur. */
	touched = $state<number | null>(null);

	link = $state<'loading' | 'ready' | 'error'>('loading');
	engine = $state<TseState | null>(null);
	/** Par synthé, les instruments de sa SoundFont ; rien tant que le moteur ne les a pas donnés. */
	presets = $state.raw<Record<string, TsePreset[]>>({});
	/** Dernière erreur signalée par le moteur. */
	error = $state<TseError | null>(null);
	restored = $state(false);

	#player: TsePlayer | null = null;
	#host: HTMLElement | null = null;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#errorTimer: ReturnType<typeof setTimeout> | undefined;
	#attempt = 0;
	/** Canaux enregistrés, rendus au moteur à la création du Player. */
	#channels: Record<string, TseChannel> = {};
	/** Notes en train de sonner → canal de leur Note On, pour les refermer sur le même canal. */
	#sounding = new Map<number, number>();
	/** CC modifiés depuis la dernière image : un seul message par contrôle et par image. */
	#queue = new Map<string, { synth: string; cc: number }>();
	#cancelFrame: (() => void) | null = null;

	get running(): boolean {
		return this.engine?.audio === 'running';
	}

	/** Le navigateur a refusé le démarrage : il faut cliquer dans l'iframe. */
	get needsGesture(): boolean {
		return !!this.engine?.needsGesture && !this.running;
	}

	get soundfont(): TseSoundfont | null {
		return this.engine?.soundfont ?? null;
	}

	// ── Cible ─────────────────────────────────────────────────────────────────

	/** Les synthés du rack, lus dans l'état de l'iframe. */
	get synths(): Target[] {
		return Object.entries(this.engine?.synths ?? {}).map(([id, synth]) => ({
			id,
			label: synthLabel(id),
			name: synth.name,
			channel: synth.channel
		}));
	}

	/** Synthés que le contrôleur sait piloter mais que ce moteur n'annonce pas. */
	get absent(): { id: string; label: string; name: string }[] {
		const synths = this.engine?.synths;
		if (!synths) return [];
		return KNOWN_SYNTHS.filter((id) => !Object.hasOwn(synths, id)).map((id) => ({
			id,
			label: synthLabel(id),
			name: synthTable(id)?.name ?? id
		}));
	}

	/** Synthé réellement joué : celui choisi, ou à défaut le premier du rack. */
	get target(): string | null {
		const synths = this.engine?.synths;
		if (!synths) return null;
		return Object.hasOwn(synths, this.wanted) ? this.wanted : (Object.keys(synths)[0] ?? null);
	}

	/** Synthé dont on montre les potentiomètres : la cible, ou le choix enregistré avant la connexion. */
	get bank(): string {
		return this.target ?? this.wanted;
	}

	get table(): SynthTable | undefined {
		return synthTable(this.bank);
	}

	/** Canal écouté par la cible. */
	get channel(): TseChannel | null {
		const target = this.target;
		return target === null ? null : (this.engine?.synths[target]?.channel ?? null);
	}

	/** Canal sur lequel le contrôleur émet : celui de sa cible. */
	get sendChannel(): number | null {
		return this.#sendChannel(this.target);
	}

	/** Autres synthés qui entendent le canal d'émission : ils jouent avec la cible. */
	get layered(): Target[] {
		const channel = this.sendChannel;
		const target = this.target;
		return this.synths.filter(
			(synth) => synth.id !== target && (synth.channel === 'omni' || synth.channel === channel)
		);
	}

	#sendChannel(synth: string | null): number | null {
		const synths = this.engine?.synths;
		const listening = synth === null ? undefined : synths?.[synth]?.channel;
		if (!synths || listening === undefined) return null;
		if (listening !== 'omni') return listening;
		// Un synthé en omni entend tout : on émet sur un canal que les autres n'écoutent pas.
		const taken = new Set(
			Object.entries(synths)
				.filter(([id]) => id !== synth)
				.map(([, other]) => other.channel)
		);
		for (let channel = 1; channel <= 16; channel++) {
			if (!taken.has(channel)) return channel;
		}
		return 1;
	}

	// ── Liaison avec le moteur ────────────────────────────────────────────────

	async attach(host: HTMLElement): Promise<void> {
		this.#host = host;
		const attempt = ++this.#attempt;
		this.link = 'loading';
		this.engine = null;
		this.presets = {};
		this.#clearError();

		clearTimeout(this.#timer);
		this.#timer = setTimeout(() => {
			if (attempt === this.#attempt && this.link !== 'ready') this.link = 'error';
		}, READY_TIMEOUT_MS);

		try {
			const TSE = await loadTse();
			if (attempt !== this.#attempt) return;

			this.#player = new TSE.Player(host, {
				channels: { ...this.#channels },
				width: '100%',
				height: '100%',
				// Démarrage piloté ici, depuis un vrai geste : une tentative lancée par un
				// message MIDI hors geste serait refusée par le navigateur.
				autostart: false,
				engineUrl: ENGINE_URL,
				title: 'TabSoundEngine, module de son',
				events: {
					onReady: (state) => {
						if (attempt !== this.#attempt) return;
						clearTimeout(this.#timer);
						this.link = 'ready';
						this.#apply(state);
					},
					onStateChange: (state) => {
						if (attempt === this.#attempt) this.#apply(state);
					},
					onPresets: (info) => {
						const list = attempt === this.#attempt ? normalizePresets(info) : null;
						if (list) this.presets = { ...this.presets, [list.synth]: list.presets };
					},
					onError: (error) => {
						if (attempt === this.#attempt) this.#fail(error);
					}
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
		this.#drop();
		if (this.#host) void this.attach(this.#host);
	}

	destroy(): void {
		this.#attempt++;
		clearTimeout(this.#timer);
		this.#clearError();
		this.#drop();
	}

	#drop(): void {
		this.#cancelFrame?.();
		this.#cancelFrame = null;
		this.#queue.clear();
		this.#sounding.clear();
		this.#player?.destroy();
		this.#player = null;
	}

	#apply(raw: unknown): void {
		const wasRunning = this.running;
		const target = this.target;
		const channel = this.sendChannel;

		this.engine = normalizeState(raw);
		for (const [id, synth] of Object.entries(this.engine.synths)) this.#channels[id] = synth.channel;

		// La cible ou son canal a changé (ici, dans l'iframe, ou parce que le synthé choisi
		// manque) : les notes tenues appartenaient à l'ancien canal.
		if (target !== null && (this.target !== target || this.sendChannel !== channel)) {
			this.releaseAll();
		}

		if (!wasRunning && this.running) {
			this.#sendSettings();
			// Les notes envoyées avant « running » sont perdues : on joue celles encore tenues.
			this.held.forEach((count, note) => {
				if (count > 0) this.#noteOn(note);
			});
		}
	}

	/**
	 * L'iframe ne renvoie pas la valeur de ses paramètres : dès que l'audio tourne, chaque
	 * synthé dont un réglage a été enregistré ou modifié reçoit toute sa table.
	 */
	#sendSettings(): void {
		const player = this.#player;
		const synths = this.engine?.synths;
		if (!player || !synths) return;

		// La cible en dernier : si deux synthés partagent un canal, ses réglages l'emportent.
		const target = this.target;
		const order = Object.keys(synths).sort((a, b) => Number(a === target) - Number(b === target));

		for (const synth of order) {
			const channel = this.#sendChannel(synth);
			if (channel === null) continue;
			const table = synthTable(synth);
			const touched = Object.entries(this.values[synth] ?? {});
			const program = this.programs[synth];

			if (touched.length > 0) {
				const ccs = new Map<number, number>();
				for (const p of table?.params ?? []) {
					if (p.alias === undefined) ccs.set(p.cc, this.#value(synth, p.cc));
				}
				for (const [cc, value] of touched) ccs.set(Number(cc), value);
				for (const [cc, value] of ccs) player.controlChange(cc, value, channel);
			}

			// Le Program Change suit la banque (CC 0), qui ne prend effet qu'avec lui.
			const bankSet = table?.program === true && touched.some(([cc]) => Number(cc) === 0);
			if (table?.program !== false && (program !== undefined || bankSet)) {
				player.programChange(program ?? 0, channel);
			}
		}
	}

	#fail(error: TseError): void {
		const message = typeof error?.message === 'string' ? error.message : String(error);
		const code = typeof error?.code === 'string' ? error.code : undefined;
		console.warn('TabSoundEngine :', message);
		clearTimeout(this.#errorTimer);
		this.error = { code, message };
		// Une différence de version ne se corrige pas toute seule : le message reste affiché.
		if (code !== 'protocol_mismatch') {
			this.#errorTimer = setTimeout(() => (this.error = null), ERROR_TTL_MS);
		}
	}

	#clearError(): void {
		clearTimeout(this.#errorTimer);
		this.error = null;
	}

	/** Demande le démarrage audio. À appeler depuis un geste utilisateur. */
	start(): void {
		if (this.link === 'ready' && !this.running) this.#player?.start();
	}

	/** Vise un autre synthé du rack. */
	setTarget(synth: string): void {
		if (synth === this.wanted || !this.engine || !Object.hasOwn(this.engine.synths, synth)) return;
		if (synth !== this.target) {
			this.releaseAll();
			this.touched = null;
		}
		this.wanted = synth;
	}

	/** Change le canal écouté par la cible ; le contrôleur émet alors sur ce canal. */
	setChannel(channel: TseChannel): void {
		const target = this.target;
		const next = channel === 'omni' ? channel : Math.min(16, Math.max(1, Math.round(channel)));
		if (target === null || next === this.channel) return;
		this.releaseAll();
		// L'état revient par onStateChange : c'est lui qui fait foi.
		this.#player?.setChannel(target, next);
	}

	// ── Notes ─────────────────────────────────────────────────────────────────

	noteOn(note: number): void {
		if (note < 0 || note > 127) return;
		this.held[note] += 1;
		if (this.held[note] === 1) this.#noteOn(note);
	}

	noteOff(note: number): void {
		if (note < 0 || note > 127 || this.held[note] <= 0) return;
		this.held[note] -= 1;
		if (this.held[note] === 0) this.#noteOff(note);
	}

	#noteOn(note: number): void {
		const channel = this.sendChannel;
		if (!this.running || channel === null) return;
		this.#player?.noteOn(note, VELOCITY, channel);
		this.#sounding.set(note, channel);
	}

	/** Chaque Note On a son Note Off sur le même canal, même si la cible a changé depuis. */
	#noteOff(note: number): void {
		const channel = this.#sounding.get(note);
		if (channel === undefined) return;
		this.#sounding.delete(note);
		this.#player?.noteOff(note, channel);
	}

	/** Relâche tout ce que le contrôleur tient (changement de cible, d'octave, perte du focus). */
	releaseAll(): void {
		for (const note of [...this.#sounding.keys()]) this.#noteOff(note);
		this.held.fill(0);
	}

	panic(): void {
		this.held.fill(0);
		this.#sounding.clear();
		this.#player?.panic();
	}

	// ── Octave et programme ───────────────────────────────────────────────────

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

	/** Programme de la cible. */
	get program(): number {
		return this.programs[this.bank] ?? 0;
	}

	/** La cible écoute son canal de batterie : elle n'y joue que des kits. */
	get onDrumChannel(): boolean {
		const drums = this.table?.drumChannel;
		return drums !== undefined && this.channel === drums;
	}

	/** Instruments proposés pour la cible, lus dans sa SoundFont ; vide si elle n'en annonce pas. */
	get instruments(): TsePreset[] {
		const list = this.presets[this.bank] ?? [];
		const kits = this.onDrumChannel ? list.filter((p) => p.bank === DRUM_BANK) : [];
		return kits.length > 0 ? kits : list;
	}

	/** Instrument que désignent la banque (CC 0) et le programme de la cible, s'il est dans la liste. */
	get preset(): TsePreset | null {
		const synth = this.bank;
		const bank = this.onDrumChannel ? DRUM_BANK : bankOf(this.values[synth]?.[0] ?? 0);
		const program = this.program;
		return (
			(this.presets[synth] ?? []).find((p) => p.bank === bank && p.program === program) ?? null
		);
	}

	/** Choisit un instrument de la liste : Bank Select puis Program Change, sur le canal de la cible. */
	selectPreset(preset: TsePreset): void {
		const synth = this.bank;
		// La banque vit avec les autres CC : le potentiomètre « Banque » et le renvoi des
		// réglages au démarrage la retrouvent là.
		if (!this.values[synth]) this.values[synth] = {};
		this.values[synth][0] = bankSelect(preset.bank);
		this.programs[synth] = clamp7(preset.program);

		const player = this.#player;
		const channel = this.sendChannel;
		if (!this.running || channel === null || !player) return;
		if (player.selectPreset) {
			player.selectPreset({ bank: preset.bank, program: preset.program }, channel);
		} else {
			player.controlChange(0, bankSelect(preset.bank), channel);
			player.programChange(preset.program, channel);
		}
	}

	/** Instrument voisin dans la liste ; sans liste, programme voisin. */
	stepProgram(direction: -1 | 1): void {
		const list = this.instruments;
		if (list.length === 0) return this.setProgram(this.program + direction);
		const current = this.preset;
		const index = current
			? list.findIndex((p) => p.bank === current.bank && p.program === current.program)
			: -1;
		const next = index < 0 ? list[0] : list[index + direction];
		if (next) this.selectPreset(next);
	}

	/** Émet un Program Change sur le canal de la cible, même si le numéro n'a pas changé. */
	setProgram(program: number): void {
		const next = clamp7(program);
		this.programs[this.bank] = next;
		const channel = this.sendChannel;
		// Avant le démarrage audio, le programme part avec les réglages : voir #sendSettings.
		if (this.running && channel !== null) this.#player?.programChange(next, channel);
	}

	// ── Potentiomètres ────────────────────────────────────────────────────────

	/** Les 8 potentiomètres de la cible. */
	get knobs(): KnobView[] {
		const synth = this.bank;
		return this.#layout(synth).map((cc) => ({ cc, value: this.#value(synth, cc) }));
	}

	/** Paramètre que ce CC règle sur la cible ; rien si elle l'ignore. */
	param(cc: number): Param | undefined {
		return param(this.bank, cc);
	}

	/** Valeur d'origine de ce CC sur la cible. */
	initial(cc: number): number {
		return initialValue(this.bank, cc);
	}

	#layout(synth: string): number[] {
		return this.layouts[synth] ?? defaultLayout(synth);
	}

	#value(synth: string, cc: number): number {
		return this.values[synth]?.[canonical(synth, cc)] ?? initialValue(synth, cc);
	}

	setKnob(index: number, value: number): void {
		const synth = this.bank;
		const cc = this.#layout(synth)[index];
		if (cc === undefined) return;
		this.touched = index;
		const next = snap(param(synth, cc), value);
		if (next === this.#value(synth, cc)) return;
		// La valeur appartient au paramètre, pas au potentiomètre : deux potentiomètres sur
		// le même paramètre (CC identiques ou alias) bougent ensemble.
		if (!this.values[synth]) this.values[synth] = {};
		this.values[synth][canonical(synth, cc)] = next;
		this.#send(synth, cc);
	}

	/** Assigne un potentiomètre à un CC. Il reprend la valeur déjà réglée pour ce paramètre. */
	assign(index: number, cc: number): void {
		const synth = this.bank;
		const layout = [...this.#layout(synth)];
		const next = clamp7(cc);
		if (index < 0 || index >= layout.length || layout[index] === next) return;
		layout[index] = next;
		this.layouts[synth] = layout;
		this.touched = index;
	}

	/** Met le CC en file : il part à la prochaine image, avec sa valeur du moment. */
	#send(synth: string, cc: number): void {
		// Avant le démarrage audio, la valeur est retenue et part avec les réglages.
		if (!this.running) return;
		this.#queue.set(`${synth}:${cc}`, { synth, cc });
		if (this.#cancelFrame) return;
		if (typeof requestAnimationFrame === 'function') {
			const id = requestAnimationFrame(this.#flush);
			this.#cancelFrame = () => cancelAnimationFrame(id);
		} else {
			const id = setTimeout(this.#flush, 16);
			this.#cancelFrame = () => clearTimeout(id);
		}
	}

	#flush = (): void => {
		this.#cancelFrame = null;
		const pending = [...this.#queue.values()];
		this.#queue.clear();
		if (!this.running) return;
		for (const { synth, cc } of pending) {
			const channel = this.#sendChannel(synth);
			if (channel === null) continue;
			this.#player?.controlChange(cc, this.#value(synth, cc), channel);
			// La banque (CC 0) ne prend effet qu'au Program Change suivant.
			if (cc === 0 && synthTable(synth)?.program) {
				this.#player?.programChange(this.programs[synth] ?? 0, channel);
			}
		}
	};

	// ── Mémoire locale ────────────────────────────────────────────────────────

	restore(): void {
		try {
			const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
			if (isRecord(saved)) {
				this.#load(saved);
			} else {
				const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) ?? 'null');
				if (isRecord(legacy)) this.#loadLegacy(legacy);
			}
		} catch {
			// Stockage indisponible (navigation privée, données bloquées) : réglages d'usine.
		}
		this.restored = true;
	}

	#load(saved: Record<string, unknown>): void {
		if (isSynthId(saved.target)) this.wanted = saved.target;
		this.#loadBase(saved.base);

		for (const [synth, value] of bySynth(saved.channels)) {
			const channel = parseChannel(value);
			if (channel !== undefined) this.#channels[synth] = channel;
		}
		for (const [synth, value] of bySynth(saved.layouts)) {
			if (Array.isArray(value) && value.length === KNOB_COUNT && value.every(isMidi)) {
				this.layouts[synth] = [...value];
			}
		}
		for (const [synth, value] of bySynth(saved.values)) {
			if (!isRecord(value)) continue;
			for (const [key, v] of Object.entries(value)) {
				if (/^\d{1,3}$/.test(key)) this.#loadValue(synth, Number(key), v);
			}
		}
		for (const [synth, value] of bySynth(saved.programs)) {
			if (isMidi(value)) this.programs[synth] = value;
		}
	}

	/** Version 1 : un seul synthé, le FM, avec 8 potentiomètres `{ cc, value }`. */
	#loadLegacy(saved: Record<string, unknown>): void {
		this.#loadBase(saved.base);
		if (isMidi(saved.program)) this.programs.fm = saved.program;

		const knobs = saved.knobs;
		if (!Array.isArray(knobs) || knobs.length !== KNOB_COUNT) return;
		if (!knobs.every((k) => isRecord(k) && isMidi(k.cc) && isMidi(k.value))) return;
		this.layouts.fm = knobs.map((k) => k.cc);
		for (const k of knobs) this.#loadValue('fm', k.cc, k.value);
	}

	#loadBase(base: unknown): void {
		if (isMidi(base) && base >= MIN_BASE && base <= MAX_BASE && base % 12 === 0) this.base = base;
	}

	#loadValue(synth: string, cc: number, value: unknown): void {
		if (!isMidi(cc) || !isMidi(value)) return;
		if (!this.values[synth]) this.values[synth] = {};
		// Pas d'arrondi à la bande ici : la banque (CC 0) peut désigner n'importe quel instrument.
		this.values[synth][canonical(synth, cc)] = value;
	}

	/** À appeler dans un $effect : lit l'état, donc se relance à chaque changement. */
	save(): void {
		const channels = { ...this.#channels };
		for (const synth of this.synths) channels[synth.id] = synth.channel;
		const snapshot = JSON.stringify({
			target: this.wanted,
			base: this.base,
			channels,
			layouts: this.layouts,
			values: this.values,
			programs: this.programs
		});
		if (!this.restored) return;
		try {
			localStorage.setItem(STORAGE_KEY, snapshot);
		} catch {
			// Voir restore().
		}
	}
}