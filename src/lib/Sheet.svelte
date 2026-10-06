<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		title: string;
		onclose: () => void;
		/** Boutons placés dans l'en-tête, avant « Fermer ». */
		actions?: Snippet;
		/** Feuille élargie, pour une longue liste. */
		wide?: boolean;
		children: Snippet;
	}

	let { title, onclose, actions, wide = false, children }: Props = $props();

	let panel: HTMLDivElement;

	// Le focus entre dans la feuille à l'ouverture et retourne d'où il venait à la fermeture.
	$effect(() => {
		const origin = document.activeElement as HTMLElement | null;
		panel.focus({ preventScroll: true });
		return () => origin?.focus?.({ preventScroll: true });
	});

	function keydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.preventDefault();
			onclose();
		}
	}
</script>

<svelte:window onkeydown={keydown} />

<!-- Feuille interne plutôt que <dialog> : elle doit pivoter avec l'interface en mode portrait. -->
<div
	class="scrim"
	role="presentation"
	onpointerdown={(event) => event.target === event.currentTarget && onclose()}
>
	<div
		class="sheet"
		class:wide
		role="dialog"
		aria-modal="true"
		aria-label={title}
		tabindex="-1"
		bind:this={panel}
	>
		<header>
			<h2>{title}</h2>
			{@render actions?.()}
			<button type="button" class="close" onclick={onclose}>Fermer</button>
		</header>
		{@render children()}
	</div>
</div>

<style>
	.scrim {
		position: fixed;
		inset: 0;
		z-index: 10;
		display: grid;
		place-items: center;
		padding: 10px;
		background: rgb(29 33 38 / 0.55);
	}

	.sheet {
		width: min(100%, 520px);
		max-height: 100%;
		overflow: auto;
		padding: 0 14px 14px;
		border-radius: 12px;
		background: var(--coque);
		box-shadow: 0 18px 50px rgb(0 0 0 / 0.35);
		outline: none;
	}

	.sheet.wide {
		width: min(100%, 720px);
	}

	/* L'en-tête reste en vue quand le contenu défile (longue liste d'instruments). */
	header {
		position: sticky;
		top: 0;
		z-index: 1;
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 12px 0 10px;
		background: var(--coque);
	}

	h2 {
		flex: 1 0 auto;
		margin: 0;
		font-size: 18px;
		font-weight: 600;
	}

	.close {
		height: 34px;
		padding: 0 12px;
		border: 1px solid var(--filet);
		border-radius: 7px;
		background: var(--coque-claire);
		font-weight: 600;
		cursor: pointer;
	}
</style>