<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { Controller } from '#lib/controller.svelte.ts';
	import Keyboard from '#lib/Keyboard.svelte';
	import Knob from '#lib/Knob.svelte';
	import Sheet from '#lib/Sheet.svelte';
	import { COMPUTER_KEYS, KEY_COUNT, ccName, formatValue, noteName, synthLabel } from '#lib/midi.ts';
	import { DRUM_BANK, type TseChannel, type TsePreset } from '#lib/tse.ts';

	// Mêmes requêtes que dans le CSS ci-dessous.
	const COMPACT_QUERY =
		'(orientation: landscape) and (max-height: 520px), (orientation: portrait) and (max-width: 520px)';
	const ROTATED_QUERY = '(orientation: portrait) and (max-width: 520px)';

	type Tab = 'controls' | 'synth';
	type SheetState =
		| { kind: 'target' }
		| { kind: 'program' }
		| { kind: 'assign'; index: number }
		| null;

	const ctl = new Controller();

	let host: HTMLDivElement;
	let tab = $state<Tab>('controls');
	let sheet = $state<SheetState>(null);
	let compact = $state(false);
	let rotated = $state(false);
	let canFullscreen = $state(false);
	let fullscreen = $state(false);

	onMount(() => {
		ctl.restore();
		void ctl.attach(host);

		const compactMedia = window.matchMedia(COMPACT_QUERY);
		const rotatedMedia = window.matchMedia(ROTATED_QUERY);
		const sync = () => {
			compact = compactMedia.matches;
			rotated = rotatedMedia.matches;
		};
		sync();
		compactMedia.addEventListener('change', sync);
		rotatedMedia.addEventListener('change', sync);

		canFullscreen = !!document.fullscreenEnabled;
		const onFullscreen = () => (fullscreen = !!document.fullscreenElement);
		document.addEventListener('fullscreenchange', onFullscreen);

		return () => {
			compactMedia.removeEventListener('change', sync);
			rotatedMedia.removeEventListener('change', sync);
			document.removeEventListener('fullscreenchange', onFullscreen);
			ctl.destroy();
		};
	});

	$effect(() => ctl.save());

	// Sur mobile, le synthé est derrière un onglet : on l'amène devant quand il réclame
	// un clic (audio bloqué) ou qu'il ne répond pas, puis on revient aux contrôles.
	let broughtForward = false;
	$effect(() => {
		if (ctl.needsGesture || ctl.link === 'error') {
			if (untrack(() => tab) !== 'synth') {
				tab = 'synth';
				broughtForward = true;
			}
		} else if (ctl.running && broughtForward) {
			broughtForward = false;
			tab = 'controls';
		}
	});

	/** La cible, telle que l'iframe l'annonce. */
	const current = $derived(ctl.synths.find((synth) => synth.id === ctl.target) ?? null);
	const label = $derived(synthLabel(ctl.bank));
	const font = $derived(ctl.soundfont);
	const fontPercent = $derived(Math.round((font?.progress ?? 0) * 100));
	// Le moteur n'annonce pas chaque pour-cent : sans progression connue, pas de chiffre.
	const fontLabel = $derived(fontPercent > 0 ? `SoundFont ${fontPercent} %` : 'SoundFont…');

	function channelName(channel: TseChannel): string {
		return channel === 'omni' ? 'omni' : String(channel);
	}

	const audio = $derived.by(() => {
		if (ctl.link === 'loading') return { label: 'Connexion…', lamp: 'off', idle: true };
		if (ctl.link === 'error') return { label: 'Réessayer', lamp: 'wait', idle: false };
		if (ctl.running) {
			// Une cible à SoundFont reste muette tant que celle-ci n'est pas chargée.
			if (ctl.table?.soundfont && font?.state === 'loading') {
				return { label: fontLabel, lamp: 'wait', idle: true };
			}
			if (ctl.table?.soundfont && font?.state === 'error') {
				return { label: 'SoundFont en échec', lamp: 'wait', idle: true };
			}
			return { label: 'Son actif', lamp: 'on', idle: true };
		}
		if (ctl.needsGesture) return { label: 'Son bloqué', lamp: 'wait', idle: false };
		return { label: 'Activer le son', lamp: 'off', idle: false };
	});

	function audioAction() {
		if (ctl.link === 'error') return ctl.retry();
		if (ctl.needsGesture) tab = 'synth';
		ctl.start();
	}

	const display = $derived.by(() => {
		if (ctl.touched === null) return null;
		const knob = ctl.knobs[ctl.touched];
		if (!knob) return null;
		const param = ctl.param(knob.cc);
		return {
			name: ccName(ctl.bank, knob.cc),
			value: (param && formatValue(param, knob.value)) || String(knob.value)
		};
	});

	/** Erreur signalée par le moteur, en clair. */
	const trouble = $derived.by(() => {
		if (!ctl.error) return null;
		return ctl.error.code === 'protocol_mismatch'
			? 'Le script et le synthé ne sont pas de la même version : rechargez la page.'
			: ctl.error.message;
	});

	// ── Instruments de la cible (feuille Programme) ───────────────────────────
	let query = $state('');

	/** Minuscules sans accents, pour chercher « piano » comme « Piano ». */
	function fold(text: string): string {
		return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
	}

	function bankTitle(bank: number): string {
		if (bank === 0) return 'Instruments';
		return bank === DRUM_BANK ? 'Batteries' : `Banque ${bank}`;
	}

	/** La liste filtrée par la recherche (nom ou numéro de programme), une section par banque. */
	const presetGroups = $derived.by(() => {
		const wanted = fold(query.trim());
		const groups: { bank: number; title: string; presets: TsePreset[] }[] = [];
		for (const preset of ctl.instruments) {
			if (wanted && !fold(preset.name).includes(wanted) && String(preset.program) !== wanted) continue;
			const last = groups.at(-1);
			if (last?.bank === preset.bank) last.presets.push(preset);
			else groups.push({ bank: preset.bank, title: bankTitle(preset.bank), presets: [preset] });
		}
		return groups;
	});

	function same(a: TsePreset | null, b: TsePreset): boolean {
		return a !== null && a.bank === b.bank && a.program === b.program;
	}

	/** À l'ouverture de la feuille, amène l'instrument courant au milieu de la liste. */
	function reveal(node: HTMLElement, current: boolean) {
		if (current) node.scrollIntoView({ block: 'center', inline: 'nearest' });
	}

	const assigning = $derived(sheet?.kind === 'assign' ? (ctl.knobs[sheet.index] ?? null) : null);
	const assigned = $derived(assigning ? ctl.param(assigning.cc) : undefined);

	async function toggleFullscreen() {
		try {
			if (document.fullscreenElement) {
				await document.exitFullscreen();
			} else {
				await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
				// Android : verrouille vraiment l'écran en paysage. Ailleurs, l'appel échoue sans gravité.
				await (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> })
					.lock?.('landscape');
			}
		} catch {
			// Plein écran ou verrouillage refusé : l'interface reste utilisable telle quelle.
		}
	}

	// ── Clavier d'ordinateur ──────────────────────────────────────────────────
	const pressed = new Map<string, number>();

	function keydown(event: KeyboardEvent) {
		if (sheet || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
		if ((event.target as HTMLElement).closest?.('input, textarea, select, [contenteditable]')) return;
		const index = COMPUTER_KEYS[event.code];
		if (index === undefined || pressed.has(event.code)) return;
		event.preventDefault();
		ctl.start();
		const note = ctl.base + index;
		pressed.set(event.code, note);
		ctl.noteOn(note);
	}

	function keyup(event: KeyboardEvent) {
		const note = pressed.get(event.code);
		if (note === undefined) return;
		pressed.delete(event.code);
		ctl.noteOff(note);
	}

	// Onglet masqué ou fenêtre quittée : aucune note ne doit rester coincée.
	function letGo() {
		pressed.clear();
		ctl.releaseAll();
	}
</script>

<svelte:head>
	<title>Control — clavier MIDI</title>
	<meta
		name="description"
		content="Clavier contrôleur MIDI 25 touches avec 8 potentiomètres assignables et Program Change, branché sur les synthés GM, FM et soustractif de TabSoundEngine."
	/>
</svelte:head>

<svelte:window onkeydown={keydown} onkeyup={keyup} onblur={letGo} />
<svelte:document onvisibilitychange={() => document.hidden && letGo()} />

<div class="stage">
	<main class="device">
		<header class="bar">
			<h1 class="brand">Control</h1>

			<div class="tabs" role="tablist" aria-label="Panneau affiché">
				<button
					type="button"
					role="tab"
					aria-selected={tab === 'controls'}
					aria-controls="panel-controls"
					onclick={() => (tab = 'controls')}>Contrôles</button
				>
				<button
					type="button"
					role="tab"
					aria-selected={tab === 'synth'}
					aria-controls="panel-synth"
					onclick={() => (tab = 'synth')}>Synthé</button
				>
			</div>

			<button
				type="button"
				class="cap"
				aria-label="Cible : {label}{current ? `, canal ${channelName(current.channel)}` : ''}"
				onclick={() => (sheet = { kind: 'target' })}
			>
				<span class="wide-label">Cible</span>
				<strong>{label}{current ? ` · ${channelName(current.channel)}` : ''}</strong>
			</button>

			<button
				type="button"
				class="cap"
				aria-label={ctl.preset
					? `Instrument : ${ctl.preset.name}, programme ${ctl.program}`
					: `Program Change, programme ${ctl.program}`}
				onclick={() => {
					query = '';
					sheet = { kind: 'program' };
				}}
			>
				<span class="wide-label">Programme</span><span class="short-label">PC</span>
				<strong>{ctl.program}</strong>
				{#if ctl.preset}
					<span class="wide-label instrument">{ctl.preset.name}</span>
				{/if}
			</button>

			<div class="octave" role="group" aria-label="Octave du clavier">
				<button
					type="button"
					class="cap step"
					aria-label="Octave plus grave"
					disabled={!ctl.canShiftDown}
					onclick={() => ctl.shiftOctave(-1)}>−</button
				>
				<output class="range" aria-live="polite">
					{noteName(ctl.base)}<span class="to">{' – ' + noteName(ctl.base + KEY_COUNT - 1)}</span>
				</output>
				<button
					type="button"
					class="cap step"
					aria-label="Octave plus aiguë"
					disabled={!ctl.canShiftUp}
					onclick={() => ctl.shiftOctave(1)}>+</button
				>
			</div>

			<p class="display" class:alert={!!trouble} title={trouble}>
				{#if trouble}
					<span role="alert">{trouble}</span>
				{:else if display}
					<span>{display.name}</span> <strong>{display.value}</strong>
				{/if}
			</p>

			<button
				type="button"
				class="cap audio"
				aria-disabled={audio.idle}
				onclick={() => !audio.idle && audioAction()}
			>
				<span class="lamp" data-lamp={audio.lamp}></span>
				<span role="status">{audio.label}</span>
			</button>

			<button type="button" class="cap" onclick={() => ctl.panic()} title="Relâche toutes les notes">
				Panic
			</button>

			{#if canFullscreen}
				<button
					type="button"
					class="cap icon fullscreen"
					aria-label={fullscreen ? 'Quitter le plein écran' : 'Plein écran'}
					aria-pressed={fullscreen}
					onclick={toggleFullscreen}
				>
					<svg viewBox="0 0 16 16" aria-hidden="true">
						<path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" />
					</svg>
				</button>
			{/if}
		</header>

		<section class="deck" data-tab={tab}>
			<div
				class="screen"
				id="panel-synth"
				role={compact ? 'tabpanel' : undefined}
				inert={compact && tab !== 'synth'}
			>
				<div class="bezel">
					<!-- TSE.Player ajoute son iframe dans cet élément. -->
					<div class="host" bind:this={host}></div>
					{#if ctl.link === 'loading'}
						<p class="veil">Connexion au synthé…</p>
					{:else if ctl.link === 'error'}
						<div class="veil">
							<p>Le synthé ne répond pas. Vérifiez la connexion internet, puis réessayez.</p>
							<button type="button" class="cap" onclick={() => ctl.retry()}>Réessayer</button>
						</div>
					{:else if font?.state === 'loading'}
						<div
							class="gauge"
							class:unknown={fontPercent === 0}
							role="progressbar"
							aria-label="Chargement de la SoundFont du GM"
							aria-valuemin={0}
							aria-valuemax={100}
							aria-valuenow={fontPercent > 0 ? fontPercent : undefined}
							style:--progress="{fontPercent}%"
						></div>
					{/if}
				</div>
				{#if ctl.needsGesture || font?.state === 'error' || trouble}
					<div class="notes">
						{#if ctl.needsGesture}
							<p class="hint">
								Le navigateur a bloqué le son. Touchez « Démarrer l'audio » dans le synthé.
							</p>
						{/if}
						{#if font?.state === 'error'}
							<p class="hint">
								La SoundFont n'a pas pu être chargée{font.error ? ` (${font.error})` : ''} : le GM
								reste muet.
							</p>
						{/if}
						{#if trouble}
							<p class="hint">{trouble}</p>
						{/if}
					</div>
				{/if}
			</div>

			<div
				class="knobs"
				id="panel-controls"
				role={compact ? 'tabpanel' : undefined}
				inert={compact && tab !== 'controls'}
			>
				{#each ctl.knobs as knob, index (index)}
					<Knob
						{index}
						cc={knob.cc}
						value={knob.value}
						param={ctl.param(knob.cc)}
						initial={ctl.initial(knob.cc)}
						{rotated}
						onchange={(value) => ctl.setKnob(index, value)}
						onassign={() => (sheet = { kind: 'assign', index })}
					/>
				{/each}
			</div>
		</section>

		<div class="bed">
			<Keyboard
				base={ctl.base}
				held={ctl.held}
				onnoteon={(note) => ctl.noteOn(note)}
				onnoteoff={(note) => ctl.noteOff(note)}
				ongesture={() => ctl.start()}
			/>
		</div>
	</main>

	<p class="tips">
		<span>
			Au clavier d'ordinateur, la rangée du bas joue la première octave et la rangée du haut la
			seconde. « Cible » choisit le synthé joué et son canal ; chaque synthé garde ses
			8 potentiomètres. Cliquez sur le nom d'un potentiomètre pour changer son CC ; un double-clic
			sur le potentiomètre le remet à sa valeur d'origine.
		</span>
	</p>

	{#if sheet?.kind === 'target'}
		<Sheet title="Cible" onclose={() => (sheet = null)}>
			{#if ctl.link !== 'ready'}
				<p class="note">
					{ctl.link === 'error' ? 'Le synthé ne répond pas.' : 'Connexion au synthé…'}
				</p>
			{:else}
				<!-- La liste vient de l'état de l'iframe : un moteur plus récent peut en annoncer d'autres. -->
				<div class="synths">
					{#each ctl.synths as synth (synth.id)}
						<button
							type="button"
							class="cap choice two-lines"
							aria-pressed={synth.id === ctl.target}
							onclick={() => ctl.setTarget(synth.id)}
						>
							<span>{synth.label}</span>
							<small>{synth.name} · canal {channelName(synth.channel)}</small>
						</button>
					{/each}
					{#each ctl.absent as synth (synth.id)}
						<button type="button" class="cap choice two-lines" disabled>
							<span>{synth.label}</span>
							<small>absent de ce moteur</small>
						</button>
					{/each}
				</div>

				{#if current}
					<h3 class="section">Canal écouté par {current.label}</h3>
					<div class="channels">
						{#each { length: 16 }, i (i)}
							<button
								type="button"
								class="cap choice"
								aria-pressed={current.channel === i + 1}
								onclick={() => ctl.setChannel(i + 1)}>{i + 1}</button
							>
						{/each}
						<button
							type="button"
							class="cap choice omni"
							aria-pressed={current.channel === 'omni'}
							onclick={() => ctl.setChannel('omni')}>Omni : tous les canaux</button
						>
					</div>
					<p class="note">
						Le clavier et les potentiomètres émettent sur le canal {ctl.sendChannel}.
						{#if ctl.layered.length > 0}
							{ctl.layered.map((synth) => synth.label).join(' et ')}
							{ctl.layered.length > 1 ? 'entendent' : 'entend'} aussi ce canal : les sons se
							superposent, et chaque synthé lit les CC dans sa propre table.
						{/if}
						{#if ctl.table?.drumChannel}
							Sur le canal {ctl.table.drumChannel}, {current.label} joue la batterie.
						{/if}
					</p>
				{/if}
			{/if}
		</Sheet>
	{:else if sheet?.kind === 'program'}
		{@const named = ctl.instruments.length > 0}
		<Sheet
			title="{named ? 'Instrument' : 'Program Change'} · {label}"
			wide={named}
			onclose={() => (sheet = null)}
		>
			{#snippet actions()}
				{#if named}
					<input
						class="search"
						type="search"
						placeholder="Chercher"
						aria-label="Chercher un instrument par son nom ou son numéro"
						autocomplete="off"
						spellcheck="false"
						bind:value={query}
					/>
				{/if}
				<button
					type="button"
					class="cap step"
					aria-label={named ? 'Instrument précédent' : 'Programme précédent'}
					disabled={named ? same(ctl.preset, ctl.instruments[0]) : ctl.program <= 0}
					onclick={() => ctl.stepProgram(-1)}>−</button
				>
				<button
					type="button"
					class="cap step"
					aria-label={named ? 'Instrument suivant' : 'Programme suivant'}
					disabled={named ? same(ctl.preset, ctl.instruments[ctl.instruments.length - 1]) : ctl.program >= 127}
					onclick={() => ctl.stepProgram(1)}>+</button
				>
			{/snippet}
			<!-- La feuille reste ouverte : chaque case émet tout de suite, pour essayer les sons à la suite. -->
			{#if named}
				<!-- Les noms viennent de la SoundFont du synthé, par onPresets. -->
				{#each presetGroups as group, i (group.bank)}
					<h3 class="section" class:lead={i === 0}>{group.title}</h3>
					<div class="presets">
						{#each group.presets as preset (preset.program)}
							<button
								type="button"
								class="cap choice preset"
								title={preset.name}
								aria-pressed={same(ctl.preset, preset)}
								use:reveal={same(ctl.preset, preset)}
								onclick={() => ctl.selectPreset(preset)}
							>
								<span class="number">{preset.program}</span>
								<span class="name">{preset.name}</span>
							</button>
						{/each}
					</div>
				{:else}
					<p class="note">Aucun instrument ne correspond à « {query.trim()} ».</p>
				{/each}
			{:else}
				<div class="programs">
					{#each { length: 128 }, i (i)}
						<button
							type="button"
							class="cap choice"
							aria-pressed={ctl.program === i}
							onclick={() => ctl.setProgram(i)}>{i}</button
						>
					{/each}
				</div>
			{/if}
			<p class="note">
				{#if ctl.sendChannel !== null}
					Émis sur le canal {ctl.sendChannel}, celui de {label}.
				{/if}
				{#if ctl.table?.program === false}
					{label} ignore les Program Change : aucun effet sur le son.
				{:else if named && ctl.onDrumChannel}
					Sur ce canal, {label} ne joue que des kits de batterie.
				{:else if !named && ctl.table?.soundfont}
					{font?.state === 'error'
						? "Sans SoundFont, pas de liste d'instruments."
						: 'Les noms des instruments arrivent avec la SoundFont.'}
				{/if}
			</p>
		</Sheet>
	{:else if sheet?.kind === 'assign' && assigning}
		{@const index = sheet.index}
		<Sheet title="Potentiomètre {index + 1} · {label}" onclose={() => (sheet = null)}>
			{#if ctl.table}
				<div class="params">
					{#each ctl.table.params as param (param.cc)}
						<button
							type="button"
							class="cap choice two-lines"
							aria-pressed={assigning.cc === param.cc}
							onclick={() => {
								ctl.assign(index, param.cc);
								sheet = null;
							}}
						>
							<span>{param.name}</span>
							<small>CC {param.cc}</small>
						</button>
					{/each}
				</div>
			{/if}
			<div class="free">
				<label for="free-cc">Autre numéro de CC</label>
				<button
					type="button"
					class="cap step"
					aria-label="CC précédent"
					disabled={assigning.cc <= 0}
					onclick={() => ctl.assign(index, assigning.cc - 1)}>−</button
				>
				<input
					id="free-cc"
					type="number"
					inputmode="numeric"
					min="0"
					max="127"
					value={assigning.cc}
					onchange={(event) => {
						const cc = event.currentTarget.valueAsNumber;
						if (Number.isFinite(cc)) ctl.assign(index, cc);
						event.currentTarget.value = String(assigning.cc);
					}}
				/>
				<button
					type="button"
					class="cap step"
					aria-label="CC suivant"
					disabled={assigning.cc >= 127}
					onclick={() => ctl.assign(index, assigning.cc + 1)}>+</button
				>
			</div>
			{#if !ctl.table}
				<p class="note">
					Le contrôleur ne connaît pas la table de CC de {label} : indiquez le numéro à émettre.
				</p>
			{:else if !assigned}
				<p class="note">
					{label} ignore le CC {assigning.cc} : le message est émis, sans effet sur le son.
				</p>
			{:else if assigned.note}
				<p class="note">{assigned.note}</p>
			{/if}
		</Sheet>
	{/if}
</div>

<style>
	/* ── Grand écran : l'instrument posé sur son plan de travail ─────────────── */
	.stage {
		min-height: 100vh;
		min-height: 100dvh;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 14px;
		padding: 24px;
	}

	.device {
		width: min(1180px, 100%);
		display: flex;
		flex-direction: column;
		border-radius: 14px;
		background: var(--coque);
		box-shadow:
			0 1px 0 rgb(255 255 255 / 0.6) inset,
			0 24px 48px -18px rgb(29 33 38 / 0.45);
		overflow: hidden;
	}

	.bar {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 12px 18px;
	}

	.brand {
		margin: 0 8px 0 0;
		font-size: 22px;
		font-weight: 600;
		letter-spacing: -0.01em;
	}

	.tabs {
		display: none;
	}

	.cap {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		height: 36px;
		padding: 0 12px;
		border: 1px solid var(--filet);
		border-radius: 7px;
		background: var(--coque-claire);
		font-weight: 600;
		white-space: nowrap;
		cursor: pointer;
		touch-action: manipulation;
	}

	.cap:active:not(:disabled, [aria-disabled='true']) {
		background: var(--creux);
	}

	.cap:disabled {
		opacity: 0.4;
		cursor: default;
	}

	.cap strong {
		min-width: 1.1em;
		font-weight: 600;
		color: var(--cobalt);
		text-align: center;
	}

	.short-label {
		display: none;
	}

	/* Nom de l'instrument, à la suite de son numéro de programme. */
	.instrument {
		max-width: 12em;
		overflow: hidden;
		text-overflow: ellipsis;
		font-weight: 500;
		color: var(--encre-douce);
	}

	.step {
		width: 36px;
		padding: 0;
		font-size: 20px;
		line-height: 1;
	}

	.octave {
		display: flex;
		align-items: center;
		gap: 4px;
	}

	.range {
		min-width: 6.4em;
		font-weight: 600;
		text-align: center;
		white-space: nowrap;
	}

	.display {
		flex: 1 1 0;
		min-width: 0;
		margin: 0;
		overflow: hidden;
		text-align: right;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--encre-douce);
		visibility: hidden;
	}

	.display strong {
		font-weight: 600;
		color: var(--encre);
	}

	/* Une erreur du moteur se lit sur tous les écrans, pas seulement sur téléphone. */
	.display.alert {
		visibility: visible;
		font-weight: 600;
		color: var(--encre);
	}

	.audio[aria-disabled='true'] {
		cursor: default;
	}

	.lamp {
		width: 9px;
		height: 9px;
		border-radius: 50%;
		background: var(--creux);
		box-shadow: inset 0 0 0 1px var(--filet);
	}

	.lamp[data-lamp='on'] {
		background: var(--lampe-active);
		box-shadow: 0 0 0 3px rgb(23 147 90 / 0.2);
	}

	.lamp[data-lamp='wait'] {
		background: var(--lampe-attente);
		box-shadow: 0 0 0 3px rgb(217 138 0 / 0.22);
	}

	.icon {
		width: 36px;
		padding: 0;
	}

	.icon svg {
		width: 16px;
		height: 16px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.6;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.fullscreen {
		display: none;
	}

	.deck {
		display: grid;
		grid-template-columns: minmax(300px, 2fr) 3fr;
		align-items: center;
		gap: 22px;
		padding: 4px 18px 18px;
	}

	.screen {
		display: flex;
		flex-direction: column;
		gap: 8px;
		min-width: 0;
	}

	/* L'écran du synthé, encastré dans la coque : 150 px pour l'iframe, plus 6 px de bordure. */
	.bezel {
		position: relative;
		height: 162px;
		padding: 6px;
		border-radius: 10px;
		background: var(--encre);
	}

	.host {
		height: 100%;
		border-radius: 5px;
		overflow: hidden;
	}

	/* Le Player fixe une hauteur en ligne : l'iframe doit suivre la taille de l'écran. */
	.host :global(iframe) {
		display: block;
		width: 100% !important;
		height: 100% !important;
		border: 0;
	}

	.veil {
		position: absolute;
		inset: 6px;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 10px;
		margin: 0;
		padding: 10px 16px;
		border-radius: 5px;
		background: var(--encre);
		color: var(--coque);
		text-align: center;
	}

	.veil p {
		margin: 0;
		max-width: 34ch;
	}

	.veil .cap {
		color: var(--encre);
	}

	/* Chargement de la SoundFont : un filet dans la bordure basse, sans recouvrir l'iframe. */
	.gauge {
		position: absolute;
		left: 6px;
		right: 6px;
		bottom: 1.5px;
		height: 3px;
		border-radius: 2px;
		background: rgb(255 255 255 / 0.16);
		overflow: hidden;
	}

	.gauge::after {
		content: '';
		display: block;
		width: var(--progress);
		height: 100%;
		background: var(--cobalt-clair);
	}

	/* Progression inconnue : un segment qui va et vient. */
	.gauge.unknown::after {
		width: 30%;
		animation: sweep 1.4s ease-in-out infinite alternate;
	}

	@keyframes sweep {
		to {
			transform: translateX(233%);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.gauge.unknown::after {
			width: 100%;
			opacity: 0.5;
			animation: none;
		}
	}

	.notes {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.hint {
		margin: 0;
		padding: 7px 10px;
		border-left: 3px solid var(--lampe-attente);
		border-radius: 0 6px 6px 0;
		background: var(--coque-claire);
		font-size: 14px;
	}

	.knobs {
		--knob-size: 64px;
		display: grid;
		grid-template-columns: repeat(8, minmax(0, 1fr));
		align-items: start;
		gap: 6px;
	}

	.bed {
		display: flex;
		height: clamp(190px, 21vw, 250px);
	}

	.bed > :global(.keyboard) {
		flex: 1;
	}

	.tips {
		width: min(1180px, 100%);
		margin: 0;
		padding: 0 4px;
		font-size: 14px;
		color: rgb(29 33 38 / 0.78);
	}

	.tips span {
		display: block;
		max-width: 92ch;
	}

	/* ── Feuilles de réglage ─────────────────────────────────────────────────── */
	.choice[aria-pressed='true'] {
		border-color: var(--cobalt);
		background: var(--cobalt);
		color: #fff;
	}

	.synths {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
		gap: 6px;
	}

	.section {
		margin: 14px 0 6px;
		font-size: 14px;
		font-weight: 600;
		color: var(--encre-douce);
	}

	.channels {
		display: grid;
		grid-template-columns: repeat(8, 1fr);
		gap: 6px;
	}

	.channels .cap {
		padding: 0;
		height: 42px;
	}

	.channels .omni {
		grid-column: 1 / -1;
		height: 36px;
	}

	/* 128 programmes : 16 par rangée. */
	.programs {
		display: grid;
		grid-template-columns: repeat(16, 1fr);
		gap: 3px;
	}

	.programs .cap {
		height: 30px;
		padding: 0;
		border-radius: 5px;
		font-size: 13px;
	}

	.search {
		flex: 1 1 0;
		min-width: 0;
		height: 34px;
		padding: 0 10px;
		border: 1px solid var(--filet);
		border-radius: 7px;
		background: var(--ivoire);
		color: var(--encre);
		font: inherit;
		/* 16px : en dessous, iOS zoome sur le champ à la prise de focus. */
		font-size: 16px;
		user-select: text;
		-webkit-user-select: text;
	}

	/* La première section suit l'en-tête de la feuille, qui porte déjà sa marge. */
	.section.lead {
		margin-top: 0;
	}

	.presets {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
		gap: 3px;
	}

	.preset {
		justify-content: flex-start;
		gap: 7px;
		height: 32px;
		padding: 0 8px;
		border-radius: 5px;
		font-size: 14px;
		font-weight: 500;
	}

	.preset .number {
		flex: none;
		min-width: 1.7em;
		font-weight: 600;
		text-align: right;
		opacity: 0.7;
	}

	.preset .name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.params {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 6px;
	}

	.two-lines {
		flex-direction: column;
		gap: 0;
		height: 46px;
		padding: 0 4px;
		line-height: 1.15;
	}

	.two-lines small {
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		font-size: 12px;
		font-weight: 500;
		opacity: 0.75;
	}

	.free {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-top: 12px;
	}

	.free label {
		margin-right: auto;
		font-weight: 600;
	}

	.free input {
		width: 64px;
		height: 36px;
		border: 1px solid var(--filet);
		border-radius: 7px;
		background: var(--ivoire);
		color: var(--encre);
		font: inherit;
		/* 16px : en dessous, iOS zoome sur le champ à la prise de focus. */
		font-size: 16px;
		font-weight: 600;
		text-align: center;
		appearance: textfield;
		-moz-appearance: textfield;
	}

	.free input::-webkit-inner-spin-button,
	.free input::-webkit-outer-spin-button {
		appearance: none;
		margin: 0;
	}

	.note {
		margin: 10px 0 0;
		font-size: 14px;
		color: var(--encre-douce);
	}

	/* ── Fenêtre étroite (tablette en portrait) : écran au-dessus des potentiomètres ── */
	@media (max-width: 900px) {
		.stage {
			padding: 12px;
		}

		.bar {
			flex-wrap: wrap;
		}

		.deck {
			grid-template-columns: 1fr;
			gap: 14px;
		}

		.knobs {
			--knob-size: 58px;
		}
	}

	/* ── Téléphone : tout tient dans un écran en paysage, le synthé passe derrière un onglet ── */
	@media (orientation: landscape) and (max-height: 520px),
		(orientation: portrait) and (max-width: 520px) {
		.stage {
			position: fixed;
			inset: 0;
			min-height: 0;
			display: block;
			padding: 0;
			background: var(--coque);
			touch-action: manipulation;
			user-select: none;
			-webkit-user-select: none;
		}

		.device {
			container-type: inline-size;
			width: 100%;
			height: 100%;
			border-radius: 0;
			box-shadow: none;
			padding-left: env(safe-area-inset-left);
			padding-right: env(safe-area-inset-right);
		}

		.bar {
			flex: none;
			flex-wrap: nowrap;
			gap: 6px;
			height: 44px;
			padding: 0 8px;
		}

		.brand,
		.tips,
		.to,
		.wide-label {
			display: none;
		}

		.short-label {
			display: inline;
		}

		.tabs {
			display: flex;
			padding: 2px;
			border-radius: 9px;
			background: var(--creux);
		}

		.tabs button {
			height: 32px;
			padding: 0 10px;
			border: 0;
			border-radius: 7px;
			background: none;
			font-weight: 600;
			cursor: pointer;
		}

		.tabs button[aria-selected='true'] {
			background: var(--encre);
			color: var(--coque-claire);
		}

		.cap {
			height: 34px;
			padding: 0 9px;
			font-size: 14px;
		}

		.step,
		.icon {
			width: 32px;
			padding: 0;
		}

		.octave {
			gap: 2px;
		}

		.range {
			min-width: 3.2em;
		}

		.display {
			visibility: visible;
			font-size: 14px;
		}

		.fullscreen {
			display: inline-flex;
		}

		/* Les deux panneaux restent montés : masquer l'iframe par display:none couperait le synthé. */
		.deck {
			position: relative;
			display: block;
			flex: none;
			height: 106px;
			padding: 0;
		}

		/* 150 px pour l'iframe, plus sa bordure : son bouton « Démarrer l'audio » doit rester cliquable. */
		.deck[data-tab='synth'] {
			height: 164px;
		}

		.screen,
		.knobs {
			position: absolute;
			inset: 0;
		}

		.deck[data-tab='controls'] .screen,
		.deck[data-tab='synth'] .knobs {
			visibility: hidden;
			pointer-events: none;
		}

		.screen {
			flex-direction: row;
			gap: 8px;
			padding: 0 8px 6px;
		}

		.bezel {
			flex: 1;
			height: auto;
			min-width: 0;
			padding: 4px;
			border-radius: 8px;
		}

		.veil {
			inset: 4px;
			font-size: 14px;
		}

		.gauge {
			left: 4px;
			right: 4px;
			bottom: 0.5px;
		}

		.notes {
			flex: 0 0 170px;
			align-self: center;
			max-height: 100%;
			overflow: auto;
		}

		.knobs {
			--knob-size: 54px;
			--knob-label: 13px;
			align-items: center;
			gap: 2px;
			padding: 0 6px 2px;
		}

		.knobs :global(.knob) {
			gap: 0;
		}

		.knobs :global(.assign) {
			padding: 1px 4px;
		}

		/* La valeur réelle s'affiche dans la barre, à côté de l'octave. */
		.knobs :global(.readout) {
			display: none;
		}

		.bed {
			flex: 1;
			height: auto;
			min-height: 0;
			padding-bottom: env(safe-area-inset-bottom);
			background: var(--encre);
		}

		.channels .cap,
		.two-lines {
			height: 40px;
		}

		.channels .omni {
			height: 34px;
		}

		.section {
			margin: 10px 0 6px;
		}

		.programs .cap {
			height: 28px;
		}

		.preset {
			height: 34px;
		}

		.note {
			margin-top: 8px;
			font-size: 13px;
		}
	}

	/* Barre trop courte (petit téléphone) : l'octave se lit déjà sur les touches. */
	@container (max-width: 600px) {
		.range {
			display: none;
		}

		.bar {
			gap: 4px;
		}

		.tabs button,
		.bar > .cap:not(.icon) {
			padding: 0 7px;
		}
	}

	/* ── Téléphone tenu en portrait : l'interface pivote pour imposer le paysage ── */
	@media (orientation: portrait) and (max-width: 520px) {
		.stage {
			inset: 0 auto auto 0;
			width: 100vh;
			width: 100dvh;
			height: 100vw;
			height: 100dvw;
			transform-origin: 0 0;
			transform: rotate(90deg) translateY(-100%);
		}

		/* Les marges de sécurité suivent l'écran physique : son haut devient la droite de l'interface. */
		.device {
			padding-left: env(safe-area-inset-bottom);
			padding-right: env(safe-area-inset-top);
		}

		.bed {
			padding-bottom: env(safe-area-inset-left);
		}
	}
</style>