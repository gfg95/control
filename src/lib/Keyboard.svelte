<script lang="ts">
	import { KEY_COUNT, noteName } from './midi.ts';

	interface Props {
		/** Note MIDI de la touche la plus grave (un do). */
		base: number;
		/** Appuis en cours par note MIDI. */
		held: number[];
		onnoteon: (note: number) => void;
		onnoteoff: (note: number) => void;
		/** Geste utilisateur valable pour démarrer l'audio. */
		ongesture?: () => void;
	}

	let { base, held, onnoteon, onnoteoff, ongesture }: Props = $props();

	const BLACK = new Set([1, 3, 6, 8, 10]);

	// Les 25 touches partent d'un do : 15 blanches, 10 noires posées sur les jointures.
	const layout = (() => {
		const whites: number[] = [];
		const blacks: { index: number; joint: number }[] = [];
		for (let index = 0; index < KEY_COUNT; index++) {
			if (BLACK.has(index % 12)) blacks.push({ index, joint: whites.length });
			else whites.push(index);
		}
		return { whites, blacks };
	})();

	let root: HTMLDivElement;
	/** Pointeur → note jouée (−1 : pointeur posé hors des touches). */
	const pointers = new Map<number, number>();

	function noteAt(x: number, y: number): number {
		// elementFromPoint reste juste quand l'interface est pivotée à 90°.
		const key = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-key]');
		return key && root.contains(key) ? base + Number(key.dataset.key) : -1;
	}

	function down(event: PointerEvent) {
		if (event.pointerType === 'mouse' && event.button !== 0) return;
		event.preventDefault();
		root.setPointerCapture(event.pointerId);
		// La souris vaut geste dès l'appui ; le tactile seulement au relâchement.
		if (event.pointerType === 'mouse') ongesture?.();
		const note = noteAt(event.clientX, event.clientY);
		pointers.set(event.pointerId, note);
		if (note >= 0) onnoteon(note);
	}

	// Glissando : le doigt change de touche sans quitter le clavier.
	function move(event: PointerEvent) {
		const previous = pointers.get(event.pointerId);
		if (previous === undefined) return;
		const note = noteAt(event.clientX, event.clientY);
		if (note === previous) return;
		if (previous >= 0) onnoteoff(previous);
		if (note >= 0) onnoteon(note);
		pointers.set(event.pointerId, note);
	}

	function up(event: PointerEvent) {
		const previous = pointers.get(event.pointerId);
		if (previous === undefined) return;
		pointers.delete(event.pointerId);
		if (previous >= 0) onnoteoff(previous);
		if (event.type === 'pointerup') ongesture?.();
	}
</script>

<div
	class="keyboard"
	role="group"
	aria-label="Clavier 25 touches, de {noteName(base)} à {noteName(base + KEY_COUNT - 1)}"
	bind:this={root}
	onpointerdown={down}
	onpointermove={move}
	onpointerup={up}
	onpointercancel={up}
	onlostpointercapture={up}
	oncontextmenu={(event) => event.preventDefault()}
>
	{#each layout.whites as index (index)}
		<div class="key white" class:down={held[base + index] > 0} data-key={index}>
			{#if index % 12 === 0}
				<span class="name">{noteName(base + index)}</span>
			{/if}
		</div>
	{/each}
	{#each layout.blacks as { index, joint } (index)}
		<div
			class="key black"
			class:down={held[base + index] > 0}
			data-key={index}
			style:--joint={joint}
		></div>
	{/each}
</div>

<style>
	.keyboard {
		--whites: 15;
		position: relative;
		display: flex;
		gap: 2px;
		padding: 0 2px 2px;
		background: var(--encre);
		touch-action: none;
		user-select: none;
		-webkit-user-select: none;
		-webkit-touch-callout: none;
		cursor: pointer;
	}

	.key {
		border-radius: 0 0 5px 5px;
	}

	.white {
		flex: 1 1 0;
		min-width: 0;
		display: flex;
		align-items: flex-end;
		justify-content: center;
		padding-bottom: 12px;
		background: var(--ivoire);
		box-shadow: inset 0 -7px 0 var(--ivoire-ombre);
	}

	.black {
		position: absolute;
		top: 0;
		/* Milieu de la jointure entre deux blanches, marges et interstices compris. */
		left: calc(1px + (100% - 2px) * var(--joint) / var(--whites));
		width: calc(100% / var(--whites) * 0.6);
		height: 60%;
		transform: translateX(-50%);
		background: var(--ebene);
		box-shadow: inset 0 -6px 0 var(--ebene-reflet);
		border-radius: 0 0 4px 4px;
	}

	.white.down {
		background: var(--cobalt);
		box-shadow: inset 0 -2px 0 rgb(0 0 0 / 0.25);
	}

	.black.down {
		background: var(--cobalt-clair);
		box-shadow: inset 0 -2px 0 rgb(0 0 0 / 0.25);
	}

	.name {
		font-size: 12px;
		font-weight: 600;
		color: var(--encre-douce);
		white-space: nowrap;
		pointer-events: none;
	}

	.down .name {
		color: var(--ivoire);
	}
</style>
