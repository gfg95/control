<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { Controller } from '#lib/controller.svelte.ts';
	import Keyboard from '#lib/Keyboard.svelte';
	import Knob from '#lib/Knob.svelte';
	import Sheet from '#lib/Sheet.svelte';
	import { COMPUTER_KEYS, FM_PARAMS, KEY_COUNT, ccName, fmParam, formatReal, noteName } from '#lib/midi.ts';

	// Mêmes requêtes que dans le CSS ci-dessous.
	const COMPACT_QUERY =
		'(orientation: landscape) and (max-height: 520px), (orientation: portrait) and (max-width: 520px)';
	const ROTATED_QUERY = '(orientation: portrait) and (max-width: 520px)';

	type Tab = 'controls' | 'synth';
	type SheetState =
		| { kind: 'channel' }
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

	const audio = $derived.by(() => {
		if (ctl.link === 'loading') return { label: 'Connexion…', lamp: 'off', idle: true };
		if (ctl.link === 'error') return { label: 'Réessayer', lamp: 'wait', idle: false };
		if (ctl.running) return { label: 'Son actif', lamp: 'on', idle: true };
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
		const param = fmParam(knob.cc);
		return { name: ccName(knob.cc), value: param ? formatReal(param, knob.value) : String(knob.value) };
	});

	const assigning = $derived(sheet?.kind === 'assign' ? ctl.knobs[sheet.index] : null);

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
		content="Clavier contrôleur MIDI 25 touches avec 8 potentiomètres assignables et Program Change, branché sur le synthé FM de TabSoundEngine."
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

			<button type="button" class="cap" onclick={() => (sheet = { kind: 'channel' })}>
				Canal <strong>{ctl.channel}</strong>
			</button>

			<button
				type="button"
				class="cap"
				aria-label="Program Change, programme {ctl.program}"
				onclick={() => (sheet = { kind: 'program' })}
			>
				<span class="wide-label">Programme</span><span class="short-label">PC</span>
				<strong>{ctl.program}</strong>
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

			<p class="display">
				{#if display}
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
					{/if}
				</div>
				{#if ctl.needsGesture}
					<p class="hint">
						Le navigateur a bloqué le son. Touchez « Démarrer l'audio » dans le synthé.
					</p>
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
			seconde. Cliquez sur le nom d'un potentiomètre pour changer son CC ; un double-clic sur le
			potentiomètre le remet à sa valeur d'origine.
		</span>
	</p>

	{#if sheet?.kind === 'channel'}
		<Sheet title="Canal MIDI" onclose={() => (sheet = null)}>
			<div class="channels">
				{#each { length: 16 }, i (i)}
					<button
						type="button"
						class="cap choice"
						aria-pressed={ctl.channel === i + 1}
						onclick={() => {
							ctl.setChannel(i + 1);
							sheet = null;
						}}>{i + 1}</button
					>
				{/each}
			</div>
		</Sheet>
	{:else if sheet?.kind === 'program'}
		<Sheet title="Program Change" onclose={() => (sheet = null)}>
			{#snippet actions()}
				<button
					type="button"
					class="cap step"
					aria-label="Programme précédent"
					disabled={ctl.program <= 0}
					onclick={() => ctl.setProgram(ctl.program - 1)}>−</button
				>
				<button
					type="button"
					class="cap step"
					aria-label="Programme suivant"
					disabled={ctl.program >= 127}
					onclick={() => ctl.setProgram(ctl.program + 1)}>+</button
				>
			{/snippet}
			<!-- La feuille reste ouverte : chaque case émet tout de suite, pour essayer les programmes à la suite. -->
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
			<p class="note">
				Émis sur le canal {ctl.channel}.
				{#if ctl.engine?.synth === 'fm'}
					Le synthé FM ignore les Program Change : aucun effet sur le son.
				{/if}
			</p>
		</Sheet>
	{:else if sheet?.kind === 'assign' && assigning}
		{@const index = sheet.index}
		<Sheet title="Potentiomètre {index + 1}" onclose={() => (sheet = null)}>
			<div class="params">
				{#each FM_PARAMS as param (param.cc)}
					<button
						type="button"
						class="cap choice param"
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
			{#if !fmParam(assigning.cc)}
				<p class="note">Le synthé FM ignore le CC {assigning.cc} : le message est émis, sans effet sur le son.</p>
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

	/* L'écran du synthé, encastré dans la coque. */
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

	.channels {
		display: grid;
		grid-template-columns: repeat(8, 1fr);
		gap: 6px;
	}

	.channels .cap {
		padding: 0;
		height: 42px;
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

	.params {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 6px;
	}

	.param {
		flex-direction: column;
		gap: 0;
		height: 46px;
		padding: 0 4px;
		line-height: 1.15;
	}

	.param small {
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

		.deck[data-tab='synth'] {
			height: min(150px, 46%);
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

		.hint {
			flex: 0 0 170px;
			align-self: center;
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
		.param {
			height: 40px;
		}

		.programs .cap {
			height: 28px;
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
